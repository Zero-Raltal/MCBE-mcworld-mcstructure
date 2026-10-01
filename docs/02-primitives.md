# 02 - 底层原语

> 本文件收集所有"小而通用"的二进制原语：CRC32C、VarInt、BlockHandle、ZIP 打包。
> 它们被 `04-sstable.md`、`05-manifest.md`、`10-mcworld.md` 共用。

## 1. CRC32C（Castagnoli）

### 1.1 用途

基岩版 LevelDB 的**所有**校验都用 CRC32C：

- SSTable 块尾部（5 字节：1 类型 + 4 CRC）
- 日志记录头（MANIFEST / .log）
- WriteBatch

### 1.2 多项式

```
CRC32C 多项式（反向表示）：0x82F63B78
```

**注意**：这与常见的 ZIP CRC32（多项式 `0xEDB88320`）**不同**！不能用同一套表。

### 1.3 完整实现

```javascript
const CRC32C_TABLE = (function() {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
            c = (c & 1) ? (0x82F63B78 ^ (c >>> 1)) : (c >>> 1);
        }
        t[i] = c;
    }
    return t;
})();

function crc32c(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc = CRC32C_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
```

### 1.4 掩码（LevelDB 特有）

LevelDB 存储的 CRC 不是原始的，而是经过"掩码"的：

```javascript
function maskedCRC32C(data) {
    const crc = crc32c(data);
    return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}
```

**为什么掩码**：LevelDB 作者为了防止把 CRC 本身当成数据，加了一层可逆变换。读出来之后**不需要**反向恢复，直接用掩码值比较。

### 1.5 计算范围（**关键，容易搞错**）

不同场景的计算范围不同：

| 场景 | 计算范围 |
|------|---------|
| SSTable 块尾部 | `block_content + compression_type`（**包含 type 字节**） |
| 日志记录（MANIFEST / .log） | `type 字节 + data`（**包含 type，不含 CRC 和 length 本身**） |
| WriteBatch | `type + data` |

**⚠️ 陷阱**：如果 CRC 计算范围算错，游戏会认为整个块损坏，**静默丢弃**。

## 2. VarInt

### 2.1 用途

- SSTable 数据块的 `shared_len` / `non_shared_len` / `value_len`
- 索引块的 BlockHandle（offset / size）
- MANIFEST 的 VersionEdit 各字段

### 2.2 编码规则

每个字节的低 7 位存数据，最高位是"还有后续"标志：

```
0xxxxxxx          → 单字节，值 = 低 7 位
1xxxxxxx yyyyyyy  → 双字节，值 = 低 7 位 | (y 的低 7 位 << 7)
...
```

### 2.3 完整实现

```javascript
function writeVarInt(buf, value) {
    // 注意：这里要支持到 2^32-1
    while (value >= 0x80) {
        buf.push((value & 0x7F) | 0x80);
        value >>>= 7;
    }
    buf.push(value & 0x7F);
}

function readVarInt(data, pos) {
    let result = 0, shift = 0, bytes = 0;
    while (true) {
        const b = data[pos + bytes];
        result |= (b & 0x7F) << shift;
        bytes++;
        if ((b & 0x80) === 0) break;
        shift += 7;
        if (bytes > 5) throw new Error('VarInt too long');
    }
    return { value: result >>> 0, bytes };
}
```

### 2.4 边界情况

- **负数**：LevelDB 的 VarInt 只用于无符号数（偏移、长度、编号）。有符号数（如 chunkX、chunkZ）用固定 4 字节 LE int32。
- **超过 5 字节**：读超过 5 字节说明数据损坏，抛异常。

## 3. BlockHandle

### 3.1 用途

SSTable 索引块里的 value，指向一个数据块的位置：

```
[offset VarInt][size VarInt]
```

- `offset`：数据块在文件中的**起始字节**
- `size`：数据块的**内容长度**（**不含 5 字节尾部**）

### 3.2 完整实现

```javascript
function encodeBlockHandle(offset, size) {
    const buf = [];
    writeVarInt(buf, offset);
    writeVarInt(buf, size);
    return new Uint8Array(buf);
}

function decodeBlockHandle(data, pos) {
    pos = pos || 0;
    const off = readVarInt(data, pos);
    pos += off.bytes;
    const sz = readVarInt(data, pos);
    pos += sz.bytes;
    return { offset: off.value, size: sz.value, bytes: pos };
}
```

### 3.3 ⚠️ 最常见的错误

```
❌ 把 size 写成 "内容 + 5 字节尾部"
✅ size 只包含块内容本身
```

如果 size 写错，读取器会：

- size 偏大 → 越界读取，把 CRC 和下一个块的头当数据
- size 偏小 → 数据被截断，解析到一半失败

## 4. ZIP 打包

### 4.1 用途

生成 `.mcworld` 时需要打包成 ZIP。用 `JSZip` 也可以，但**零依赖**的实现更可靠（避免浏览器环境加载外部库）。

### 4.2 最小 ZIP 格式

每个文件包含两部分：

**本地文件头（Local File Header）**：

```
签名      4B   0x04034b50
版本      2B   20
标志      2B   0
压缩方式  2B   0（不压缩）
修改时间  2B   0
修改日期  2B   0
CRC32     4B
压缩大小  4B
原始大小  4B
文件名长度 2B
扩展字段  2B   0
文件名    N B
文件数据  M B
```

**中心目录（Central Directory）**：每个文件一条，结构类似。

**结尾记录（End of Central Directory）**：22 字节。

### 4.3 完整实现

```javascript
class ZipBuilder {
    constructor() {
        this.files = [];         // [Uint8Array, Uint8Array, ...] 本地头和数据的序列
        this.centralDir = [];    // [Uint8Array, ...] 中心目录条目
        this.offset = 0;         // 当前写入偏移
    }

    addFile(name, data) {
        const nameBytes = new TextEncoder().encode(name);
        const crc = this._crc32(data);
        const size = data.length;

        // ---- 本地文件头 ----
        const local = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);    // 签名
        lv.setUint16(4, 20, true);            // 版本
        lv.setUint16(6, 0, true);             // 标志
        lv.setUint16(8, 0, true);             // 压缩方式
        lv.setUint16(10, 0, true);            // 修改时间
        lv.setUint16(12, 0, true);            // 修改日期
        lv.setUint32(14, crc, true);          // CRC32
        lv.setUint32(18, size, true);         // 压缩大小
        lv.setUint32(22, size, true);         // 原始大小
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true);            // 扩展字段长度
        local.set(nameBytes, 30);

        const localHeaderOffset = this.offset;
        this.files.push(local, data);
        this.offset += local.length + size;

        // ---- 中心目录条目 ----
        const central = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true);    // 签名
        cv.setUint16(4, 20, true);            // 版本（创建）
        cv.setUint16(6, 20, true);            // 版本（需要）
        cv.setUint16(8, 0, true);             // 标志
        cv.setUint16(10, 0, true);            // 压缩方式
        cv.setUint16(12, 0, true);            // 修改时间
        cv.setUint16(14, 0, true);            // 修改日期
        cv.setUint32(16, crc, true);          // CRC32
        cv.setUint32(20, size, true);         // 压缩大小
        cv.setUint32(24, size, true);         // 原始大小
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true);            // 扩展字段长度
        cv.setUint16(32, 0, true);            // 注释长度
        cv.setUint16(34, 0, true);            // 起始磁盘号
        cv.setUint16(36, 0, true);            // 内部属性
        cv.setUint32(38, 0, true);            // 外部属性
        cv.setUint32(42, localHeaderOffset, true);
        central.set(nameBytes, 46);
        this.centralDir.push(central);
    }

    _crc32(data) {
        // 注意：ZIP 用标准 CRC32（0xEDB88320），不是 CRC32C！
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < data.length; i++) {
            crc ^= data[i];
            for (let j = 0; j < 8; j++) {
                crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
            }
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    build() {
        const centralOffset = this.offset;
        let centralSize = 0;
        for (const c of this.centralDir) centralSize += c.length;

        const end = new Uint8Array(22);
        const ev = new DataView(end.buffer);
        ev.setUint32(0, 0x06054b50, true);    // 签名
        ev.setUint16(4, 0, true);             // 磁盘号
        ev.setUint16(6, 0, true);             // 起始磁盘号
        ev.setUint16(8, this.centralDir.length, true);   // 本盘条目数
        ev.setUint16(10, this.centralDir.length, true);  // 总条目数
        ev.setUint32(12, centralSize, true);
        ev.setUint32(16, centralOffset, true);
        ev.setUint16(20, 0, true);            // 注释长度

        const parts = this.files.concat(this.centralDir, [end]);
        let total = 0;
        for (const p of parts) total += p.length;

        const out = new Uint8Array(total);
        let pos = 0;
        for (const p of parts) {
            out.set(p, pos);
            pos += p.length;
        }
        return out;
    }
}
```

### 4.4 ⚠️ CRC 陷阱

**ZIP 用标准 CRC32，LevelDB 用 CRC32C，两者不同！**

| 场景 | 多项式 |
|------|--------|
| ZIP 内部 CRC | `0xEDB88320`（标准） |
| LevelDB / SSTable | `0x82F63B78`（Castagnoli） |

**不要复用同一个实现**，会静默产生损坏的 ZIP 或 SSTable。

### 4.5 压缩选项

为了简单，上面用 `compression = 0`（不压缩）。这对 `.mcworld` **完全可行**：

- 游戏不要求 ZIP 内部压缩
- 只要求 ZIP 结构合法
- 不压缩反而更快

如果需要压缩，可以：

- 用 `pako.deflate()` 得到 deflate 数据
- 把 `compression` 字段改成 8（DEFLATE）

但**没必要**，除非文件很大。

## 5. 各原语的关系图

```
┌──────────────────────────────────────────────────────────┐
│ LevelDB 数据库                                            │
│  ┌─────────────────────────────────────────────────┐     │
│  │ SSTable (.ldb)                                   │     │
│  │  ┌─────────────────┐  ┌───────────────────┐    │     │
│  │  │ 数据块           │  │ 索引块             │    │     │
│  │  │ [VarInt][Key]   │  │ [VarInt][Block-   │    │     │
│  │  │ [VarInt][Val]   │  │  Handle]          │    │     │
│  │  │ ...             │  │ ...               │    │     │
│  │  │ [restart 数组]  │  │ [restart 数组]    │    │     │
│  │  │ [uint32 数量]   │  │ [uint32 数量]     │    │     │
│  │  └─────────────────┘  └───────────────────┘    │     │
│  │  每个块后缀: [类型 1B][CRC32C 4B]              │     │
│  │                                                 │     │
│  │  Footer 48B                                     │     │
│  └─────────────────────────────────────────────────┘     │
│                                                          │
│  ┌─────────────────────┐  ┌──────────────────────────┐  │
│  │ MANIFEST             │  │ CURRENT                  │  │
│  │ [CRC32C][len][type] │  │ "MANIFEST-000004\n"      │  │
│  │ [VersionEdit]        │  │                          │  │
│  │ ...                  │  │                          │  │
│  └─────────────────────┘  └──────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## 6. 自检清单

- [ ] CRC32C 用多项式 `0x82F63B78`（不是 `0xEDB88320`）
- [ ] ZIP 内部 CRC 用 `0xEDB88320`（不是 `0x82F63B78`）
- [ ] SSTable 块 CRC 计算范围是 `block + compression_type`
- [ ] 日志记录 CRC 计算范围是 `type + data`
- [ ] VarInt 只用于无符号数
- [ ] BlockHandle 的 size **不含** 5 字节尾部
- [ ] ZIP 尾部（End of Central Directory）的偏移字段正确
- [ ] CRC 掩码函数 `maskedCRC32C` 只用于 LevelDB，不用于 ZIP

## 7. 参考

- LevelDB 源码：`util/crc32c.cc`
- ZIP 规范：https://pkware.cachefly.net/webdocs/APPNOTE/APPNOTE-6.3.9.TXT
