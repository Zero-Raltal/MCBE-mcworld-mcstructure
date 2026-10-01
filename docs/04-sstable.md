# 04 - SSTable（.ldb）文件格式

> SSTable 是 LevelDB 的核心存储文件，也是 `.mcworld` 里**唯一实际存数据**的地方。
> 本文件讲清它的**字节级结构**、**构建流程**、**解析流程**、**所有陷阱**。

## 1. 术语与背景

**SSTable** = Sorted String Table，一个"按键排序的不可变 KV 文件"。

**为什么用它**：LevelDB 把内存里的写入先缓存，等缓存满了再一次性排序、打包成 SSTable。SSTable 一旦写完**永不修改**，只追加新的 SSTable 或合并（compaction）。

**在 mcworld 里**：SSTable 就是 `.ldb` 文件。游戏加载时读它，得到所有 chunk 数据。

**关键性质**：

- 键**必须严格递增**
- 文件一旦写完就固定
- 读取时用**二分查找**定位块，所以**索引块**很关键

## 2. 整体布局

```
┌─────────────────────────────────┐
│ 数据块 1                         │
│   [条目][条目]...[条目]          │
│   [restart 数组]                 │
│   [restart 数量 uint32 LE]       │
│   [compression_type 1B]          │
│   [crc32c_masked 4B LE]          │
├─────────────────────────────────┤
│ 数据块 2                         │
│   ...（同上）                    │
├─────────────────────────────────┤
│ ...                              │
├─────────────────────────────────┤
│ 数据块 N                         │
├─────────────────────────────────┤
│ 元索引块（一般是空的）            │
│   [restart 数量 uint32 LE = 1]   │
│   [restart 偏移 uint32 LE = 0]   │
│   [compression_type 1B]          │
│   [crc32c_masked 4B LE]          │
├─────────────────────────────────┤
│ 索引块                           │
│   [条目: last_key → BlockHandle] │
│   [restart 数组]                 │
│   [restart 数量 uint32 LE]       │
│   [compression_type 1B]          │
│   [crc32c_masked 4B LE]          │
├─────────────────────────────────┤
│ Footer (48B)                     │
└─────────────────────────────────┘
```

**⚠️ 关键顺序**：

```
数据块 1..N  →  元索引块  →  索引块  →  Footer
```

**元索引块在索引块之前**！很多文档写反，实测必须如此。

**⚠️ 块尾部的 5 字节属于块，但不是块内容**：

- 数据块的"size"**不包含**这 5 字节
- Footer 的 `handle.size` **不包含**这 5 字节

## 3. 数据块格式

### 3.1 块内条目

```
[条目 1][条目 2]...[条目 N][restart 数组][restart 数量 uint32 LE]
```

**每个条目**：

```
[shared_key_len VarInt][non_shared_key_len VarInt][value_len VarInt]
[非共享 key 字节][value 字节]
```

**前缀共享**：

- LevelDB 为了节省空间，相邻 key 共享前缀
- `shared_key_len` 表示"与上一个 key 共享多少字节"
- `non_shared_key_len` 表示"本次新增多少字节"
- 完整 key = `上一个key[0..shared_len-1] + 本次新增字节`

**示例**：假设上一个 key 是 `abcX`，当前 key 是 `abcY`：

```
shared_key_len = 3
non_shared_key_len = 1
新增字节 = "Y"
→ 完整 key = "abcY"
```

### 3.2 restart 数组

**为什么需要**：前缀共享让"随机访问"变难（必须从头解码）。LevelDB 每隔 N 个条目记录一个 **restart point**，从该点开始可以独立解码。

**规则**：

- `restart interval` 默认是 16
- 每 16 个条目，记录一个 restart 偏移（从块开始到该条目首字节的字节数）
- restart 用 `uint32 LE` 存储
- 最后还有一个 `uint32 LE` 存 restart 数量

**示例**：块里有 40 个条目（interval = 16）：

- 条目 0 → restart 偏移 P0
- 条目 16 → restart 偏移 P16
- 条目 32 → restart 偏移 P32
- restart 数量 = 3

### 3.3 块尾部（5 字节）

```
[compression_type 1B][crc32c_masked 4B LE]
```

**压缩类型**：

| 值 | 含义 |
|----|------|
| 0 | 无压缩 |
| 1 | Snappy（基岩版**不用**） |
| 2 | zlib |
| 4 | **raw deflate**（基岩版 1.19+ 使用） |

**CRC 计算范围**：`block_content + compression_type`（**包含 type 字节**）。

```javascript
function blockWithTrailer(blockBytes) {
    const crcInput = new Uint8Array(blockBytes.length + 1);
    crcInput.set(blockBytes, 0);
    crcInput[blockBytes.length] = 0;   // compression_type
    const crc = maskedCRC32C(crcInput);

    const result = new Uint8Array(blockBytes.length + 5);
    result.set(blockBytes, 0);
    result[blockBytes.length] = 0;             // compression_type
    result[blockBytes.length + 1] = crc & 0xFF;
    result[blockBytes.length + 2] = (crc >>> 8) & 0xFF;
    result[blockBytes.length + 3] = (crc >>> 16) & 0xFF;
    result[blockBytes.length + 4] = (crc >>> 24) & 0xFF;
    return result;
}
```

**为什么不压缩**：

- 基岩版允许不压缩
- 不压缩实现简单，避免引入 deflate 依赖
- 文件略大但可接受

**如果要压缩**：用 `pako.deflateRaw()`，compression_type 写 4。

## 4. 内部键（Internal Key）

**⚠️ 极重要**：SSTable 里存的**不是** user key，而是 **internal key**：

```
internal_key = user_key + [value_type 1B] + [sequence_number 7B LE]
```

**含义**：

- `value_type`：1 = 有效值，0 = 删除标记
- `sequence_number`：单调递增的操作序号

**为什么要有**：

- LevelDB 是 LSM 树，同一个 key 可能出现在多个 SSTable 里
- internal key 保证"最新版本的 key 排在前面"
- 排序时先按 user key，再按 sequence_number 降序

**实践简化**：导出 mcworld 时，`sequence_number` 用**全 0**，`value_type` 用 **1** 即可。

```javascript
function makeInternalKey(userKey) {
    const ik = new Uint8Array(userKey.length + 8);
    ik.set(userKey, 0);
    ik[userKey.length] = 1;   // value_type = 1
    // 后面 7 字节默认全 0（sequence_number = 0）
    return ik;
}
```

**⚠️ 解析时要去掉尾部**：

```javascript
if (key.length >= 8) {
    userKey = key.slice(0, key.length - 8);
}
```

## 5. 索引块

**格式**：与数据块相同。

**内容**：每个条目对应一个数据块。

```
key = 该数据块最后一个 user_key 的 internal key
value = BlockHandle (offset, size)
```

**restart interval**：索引块用 **1**（每个条目都是 restart point）。

**为什么用最后一个 key**：二分查找时，找"最后一个 lastKey ≤ 目标 key" 的数据块。

### 5.1 构造索引块

```javascript
const indexEntries = [];
for (let i = 0; i < dataBlocks.length; i++) {
    const handle = encodeHandle(dataBlockOffsets[i], dataBlocks[i].bytes.length);
    indexEntries.push({
        key: dataBlocks[i].lastKey,   // 已经是 internal key
        value: handle
    });
}
const indexBlockBytes = buildBlock(indexEntries);
```

## 6. 元索引块（MetaIndex）

**通常是空的**。

**格式**：

```
[restart 数组 = [0]]
[restart 数量 uint32 LE = 1]
[compression_type = 0]
[CRC]
```

**含义**：`[00 00 00 00][01 00 00 00][00][crc 4B]`。

**为什么存在**：LevelDB 通用格式，mcworld 里不用。但**必须存在**（Footer 要指向它）。

## 7. Footer（48 字节）

```
[metaindex_handle: offset VarInt][metaindex_handle: size VarInt]
[index_handle: offset VarInt][index_handle: size VarInt]
[零填充到 40 字节]
[魔数 8 字节: 57 FB 80 8B 24 75 47 DB]
```

**字段含义**：

- `metaindex_handle`：元索引块在文件中的 (offset, size)
- `index_handle`：索引块在文件中的 (offset, size)
- `size` **不含** 5 字节尾部

**魔数**：`0xdb4775248b80fb57` 的小端序表示。

**构造**：

```javascript
const footerBuf = [];
writeVarInt(footerBuf, metaIndexBlockOffset);
writeVarInt(footerBuf, metaIndexBlockBytes.length);
writeVarInt(footerBuf, indexBlockOffset);
writeVarInt(footerBuf, indexBlockBytes.length);
while (footerBuf.length < 40) footerBuf.push(0);
footerBuf.push(0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb);
```

## 8. 完整构建流程

```javascript
function buildSSTable(entries) {
    // Step 1: 排序
    const sorted = entries.slice().sort(function(a, b) {
        const n = Math.min(a.key.length, b.key.length);
        for (let i = 0; i < n; i++) {
            if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
        }
        return a.key.length - b.key.length;
    });

    // Step 2: 转成 internal key
    function makeInternalKey(userKey) {
        const ik = new Uint8Array(userKey.length + 8);
        ik.set(userKey, 0);
        ik[userKey.length] = 1;
        return ik;
    }

    // Step 3: 块打包函数
    function blockWithTrailer(blockBytes) {
        const crcInput = new Uint8Array(blockBytes.length + 1);
        crcInput.set(blockBytes, 0);
        crcInput[blockBytes.length] = 0;
        const crc = maskedCRC32C(crcInput);
        const result = new Uint8Array(blockBytes.length + 5);
        result.set(blockBytes, 0);
        result[blockBytes.length] = 0;
        result[blockBytes.length + 1] = crc & 0xFF;
        result[blockBytes.length + 2] = (crc >>> 8) & 0xFF;
        result[blockBytes.length + 3] = (crc >>> 16) & 0xFF;
        result[blockBytes.length + 4] = (crc >>> 24) & 0xFF;
        return result;
    }

    function encodeHandle(offset, size) {
        const buf = [];
        writeVarInt(buf, offset);
        writeVarInt(buf, size);
        return new Uint8Array(buf);
    }

    // Step 4: 块内序列化
    function buildBlock(blockEntries) {
        const blockData = [];
        const restarts = [];
        for (const item of blockEntries) {
            restarts.push(blockData.length);
            writeVarInt(blockData, 0);                  // shared_key_len
            writeVarInt(blockData, item.key.length);    // non_shared_key_len
            writeVarInt(blockData, item.value.length);  // value_len
            for (let i = 0; i < item.key.length; i++) blockData.push(item.key[i]);
            for (let i = 0; i < item.value.length; i++) blockData.push(item.value[i]);
        }
        for (const r of restarts) {
            blockData.push(r & 0xFF, (r >>> 8) & 0xFF, (r >>> 16) & 0xFF, (r >>> 24) & 0xFF);
        }
        blockData.push(
            restarts.length & 0xFF,
            (restarts.length >>> 8) & 0xFF,
            (restarts.length >>> 16) & 0xFF,
            (restarts.length >>> 24) & 0xFF
        );
        return new Uint8Array(blockData);
    }

    // Step 5: 切分数据块（每块约 4KB）
    const BLOCK_TARGET = 4096;
    const groups = [];
    let current = [], currentSize = 0;
    for (const entry of sorted) {
        const ik = makeInternalKey(entry.key);
        const est = 15 + ik.length + entry.value.length;
        if (currentSize + est > BLOCK_TARGET && current.length > 0) {
            groups.push(current);
            current = [];
            currentSize = 0;
        }
        current.push({ key: ik, value: entry.value });
        currentSize += est;
    }
    if (current.length > 0) groups.push(current);

    // Step 6: 构建数据块
    const dataBlocks = [];
    for (const group of groups) {
        dataBlocks.push({
            bytes: buildBlock(group),
            lastKey: group[group.length - 1].key
        });
    }

    // Step 7: 元索引块（空）
    const metaIndexBlockBytes = buildBlock([]);
    const metaIndexBlockWithTrailer = blockWithTrailer(metaIndexBlockBytes);

    // Step 8: 索引块
    const dataBlockOffsets = [];
    let offset = 0;
    for (const b of dataBlocks) {
        dataBlockOffsets.push(offset);
        offset += b.bytes.length + 5;
    }
    const indexEntries = [];
    for (let i = 0; i < dataBlocks.length; i++) {
        const handle = encodeHandle(dataBlockOffsets[i], dataBlocks[i].bytes.length);
        indexEntries.push({ key: dataBlocks[i].lastKey, value: handle });
    }
    const indexBlockBytes = buildBlock(indexEntries);
    const indexBlockWithTrailer = blockWithTrailer(indexBlockBytes);

    // Step 9: 计算位置
    const metaIndexBlockOffset = offset;
    const indexBlockOffset = metaIndexBlockOffset + metaIndexBlockWithTrailer.length;

    // Step 10: Footer
    const footerBuf = [];
    writeVarInt(footerBuf, metaIndexBlockOffset);
    writeVarInt(footerBuf, metaIndexBlockBytes.length);
    writeVarInt(footerBuf, indexBlockOffset);
    writeVarInt(footerBuf, indexBlockBytes.length);
    while (footerBuf.length < 40) footerBuf.push(0);
    footerBuf.push(0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb);

    // Step 11: 拼接
    const pieces = [];
    for (const b of dataBlocks) pieces.push(blockWithTrailer(b.bytes));
    pieces.push(metaIndexBlockWithTrailer);
    pieces.push(indexBlockWithTrailer);
    pieces.push(new Uint8Array(footerBuf));

    let total = 0;
    for (const p of pieces) total += p.length;

    const result = new Uint8Array(total);
    let off = 0;
    for (const p of pieces) {
        result.set(p, off);
        off += p.length;
    }
    return result;
}
```

## 9. 完整解析流程

```javascript
function parseSSTable(buffer) {
    const result = { entries: [], magicOK: false, indexCount: 0, dataBlockOK: 0, dataBlockFail: 0 };
    if (buffer.length < 48) return result;

    // Step 1: 检查 Footer 魔数
    const footerStart = buffer.length - 48;
    const magic = [0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb];
    for (let i = 0; i < 8; i++) {
        if (buffer[footerStart + 40 + i] !== magic[i]) return result;
    }
    result.magicOK = true;

    // Step 2: 读 Footer
    let pos = footerStart;
    function readAt() {
        const r = readVarInt(buffer, pos);
        pos += r.bytes;
        return r.value;
    }
    try {
        readAt(); readAt();                       // 跳过 metaindex handle
        const indexOffset = readAt();
        const indexSize = readAt();
        if (indexOffset >= buffer.length || indexSize <= 0) return result;

        // Step 3: 读索引块
        const indexEntries = readBlock(buffer, indexOffset, indexSize);
        result.indexCount = indexEntries.length;

        // Step 4: 逐个数据块
        for (const idx of indexEntries) {
            let p = 0;
            const dOff = readVarInt(idx.value, p); p += dOff.bytes;
            const dSize = readVarInt(idx.value, p); p += dSize.bytes;
            const dataEntries = readBlock(buffer, dOff.value, dSize.value);
            if (dataEntries.length > 0) result.dataBlockOK++;
            else result.dataBlockFail++;
            for (const de of dataEntries) result.entries.push(de);
        }
    } catch (e) { }
    return result;
}

function readBlock(buffer, offset, size) {
    const dataEnd = offset + size;
    if (dataEnd > buffer.length) return [];
    const compressionType = buffer[dataEnd];   // 尾部第一字节
    let blockData = buffer.slice(offset, dataEnd);
    try {
        blockData = decompressBlock(blockData, compressionType);
    } catch (e) { return []; }
    return parseBlockEntries(blockData);
}

function parseBlockEntries(blockData) {
    const len = blockData.length;
    if (len < 4) return [];
    const view = new DataView(blockData.buffer, blockData.byteOffset, blockData.byteLength);
    const numRestarts = view.getUint32(len - 4, true);
    const restartsStart = len - 4 - numRestarts * 4;

    const entries = [];
    let pos = 0, lastKey = new Uint8Array(0);

    while (pos < restartsStart) {
        try {
            const shared = readVarInt(blockData, pos); pos += shared.bytes;
            const nonShared = readVarInt(blockData, pos); pos += nonShared.bytes;
            const valueLen = readVarInt(blockData, pos); pos += valueLen.bytes;

            if (pos + nonShared.value + valueLen.value > restartsStart) break;

            const keyDelta = blockData.slice(pos, pos + nonShared.value);
            pos += nonShared.value;
            const value = blockData.slice(pos, pos + valueLen.value);
            pos += valueLen.value;

            // 恢复完整 key
            const key = new Uint8Array(shared.value + nonShared.value);
            key.set(lastKey.slice(0, shared.value), 0);
            key.set(keyDelta, shared.value);

            // 去掉 8 字节 internal key 尾部
            if (key.length >= 8) {
                entries.push({ key: key.slice(0, key.length - 8), value });
            }
            lastKey = key;
        } catch (e) { break; }
    }
    return entries;
}
```

## 10. 解压函数

```javascript
function decompressBlock(data, type) {
    if (type === 0) return data;
    if (type === 1) return snappyDecompress(data);
    if (type === 2) {
        if (typeof pako !== 'undefined') return pako.inflate(data);
        throw new Error('pako 未加载');
    }
    if (type === 3 || type === 4) {
        if (typeof pako !== 'undefined') return pako.inflateRaw(data);
        throw new Error('pako 未加载');
    }
    // 兜底尝试
    if (typeof pako !== 'undefined') {
        try { return pako.inflateRaw(data); } catch (e) { }
        try { return pako.inflate(data); } catch (e) { }
    }
    return data;
}
```

**Snappy 解压**（保留兼容，基岩版不用）：

```javascript
function snappyDecompress(input) {
    let ip = 0, outLen = 0, shift = 0;
    while (true) {
        const b = input[ip++];
        outLen |= (b & 0x7F) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
    }
    const output = new Uint8Array(outLen);
    let op = 0;
    while (ip < input.length) {
        const tag = input[ip++];
        const type = tag & 3;
        if (type === 0) {
            let len = (tag >> 2) + 1;
            if (len > 60) {
                const extra = len - 60;
                len = 0;
                for (let i = 0; i < extra; i++) len |= input[ip++] << (i * 8);
                len += 1;
            }
            output.set(input.slice(ip, ip + len), op);
            ip += len;
            op += len;
        } else {
            let offset, len;
            if (type === 1) {
                len = ((tag >> 2) & 0x7) + 4;
                offset = ((tag >> 5) << 8) | input[ip++];
            } else if (type === 2) {
                len = (tag >> 2) + 1;
                offset = input[ip++] | (input[ip++] << 8);
            } else {
                len = (tag >> 2) + 1;
                offset = input[ip++] | (input[ip++] << 8) |
                         (input[ip++] << 16) | (input[ip++] << 24);
            }
            for (let i = 0; i < len; i++) {
                output[op] = output[op - offset];
                op++;
            }
        }
    }
    return output;
}
```

## 11. 诊断工具

```javascript
function diagnoseSSTable(buffer) {
    const r = parseSSTable(buffer);
    console.log('文件大小:', buffer.length, '字节');
    console.log('Magic OK:', r.magicOK);
    console.log('索引块条目数:', r.indexCount);
    console.log('数据块解压成功:', r.dataBlockOK);
    console.log('数据块解压失败:', r.dataBlockFail);
    console.log('解析出 key-value:', r.entries.length);
    return r;
}
```

**期望输出**（正常文件）：

```
文件大小: 12345 字节
Magic OK: true
索引块条目数: 4
数据块解压成功: 4
数据块解压失败: 0
解析出 key-value: 19
```

**常见异常**：

| 症状 | 病因 |
|------|------|
| `Magic OK: false` | Footer 魔数错误，文件损坏或格式不对 |
| `indexCount: 0` | Footer 里的 index_handle 错 |
| `dataBlockFail > 0` | 数据块 CRC 校验失败，或解压失败 |
| `entries.length: 0` | 索引块里的 BlockHandle 错误 |

## 12. 陷阱清单

### 12.1 顺序陷阱

```
❌ 数据块 1..N  →  索引块  →  元索引块  →  Footer
✅ 数据块 1..N  →  元索引块  →  索引块  →  Footer
```

元索引块在索引块**之前**。

### 12.2 BlockHandle size 陷阱

```
❌ size = "内容 + 5 字节尾部"    → 越界读取垃圾
✅ size = 内容长度               → 正确
```

**记忆法**：块尾部 5 字节**不属于块**，它是"块的校验和压缩标识"，读取器从 `offset+size` 处读它。

### 12.3 CRC 计算范围陷阱

```
❌ CRC(block_content)
✅ CRC(block_content + compression_type)
```

**为什么包含 type**：防止把压缩类型改掉后 CRC 仍通过（安全性设计）。

### 12.4 internal key 尾部陷阱

```
❌ SSTable 里存 user key
✅ SSTable 里存 user_key + [type 1B] + [sequence 7B]
```

**读取时必须去掉 8 字节**，否则后续按 user key 解释会错位。

### 12.5 排序陷阱

```
❌ 不排序
✅ 按 user_key 字节序升序排序
```

LevelDB 严格依赖键递增。

### 12.6 空 SSTable 陷阱

如果 entries 为空（理论上不该发生）：

- 数据块数量为 0
- 索引块为空
- Footer 仍要写

游戏可能拒绝加载"空 SSTable"，**别生成空的**。

## 13. 与 MANIFEST 的关系

```
MANIFEST 记录：
  - Comparator 名称
  - LogNumber
  - 所有 .ldb 文件列表（file_number / file_size / smallest_key / largest_key）
  - LastSequenceNumber
  - NextFileNumber

SSTable 记录：
  - 实际 key-value 数据
```

**MANIFEST 里的 smallest/largest key 是 user key**（不带 8 字节尾部）！

```javascript
// ✅ MANIFEST 用
const smallestKey = entries[0].key;   // user key
const largestKey = entries[entries.length - 1].key;
```

## 14. 自检清单

- [ ] 元索引块在索引块**之前**
- [ ] 每个块都有 5 字节尾部（compression_type + CRC32C）
- [ ] CRC 计算范围包含 compression_type
- [ ] BlockHandle 的 size **不含** 5 字节尾部
- [ ] Footer 魔数是 `57 FB 80 8B 24 75 47 DB`
- [ ] SSTable 里所有 key 都加了 8 字节 internal key 尾部
- [ ] MANIFEST 里的 smallest/largest key **没有** 8 字节尾部
- [ ] entries 按 user key 字节序排序
- [ ] 每个数据块的 restart interval 是 16（或自定义）
- [ ] 索引块用 restart interval = 1
- [ ] 每个块末尾的 restart 数量是 `uint32 LE`
- [ ] 压缩类型用 0（无）或 4（raw deflate），不用 1（Snappy）

## 15. 参考

- LevelDB table 格式：https://github.com/google/leveldb/blob/main/doc/table_format.md
- LevelDB 源码：`table/block_builder.cc`、`table/table_builder.cc`
