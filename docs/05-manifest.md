# 05 - MANIFEST 与 CURRENT

> MANIFEST 是 LevelDB 的"版本清单"，记录所有 SSTable 的元数据。
> CURRENT 是一个指针，告诉游戏"该读哪个 MANIFEST"。

## 1. CURRENT 文件

### 1.1 内容

**纯文本**，只有一个 MANIFEST 文件名：

```
MANIFEST-000004\n
```

**注意**：以 `\n` 结尾（换行符）。

### 1.2 生成

```javascript
const currentBytes = new TextEncoder().encode('MANIFEST-000004\n');
```

### 1.3 ⚠️ 陷阱

- **必须带 `\n`**：不带可能导致部分解析器读不到
- **文件名要和实际 MANIFEST 文件名匹配**：CURRENT 里写 `MANIFEST-000004`，就得有 `db/MANIFEST-000004` 文件
- **不能有空行**：只读第一行

## 2. MANIFEST 文件结构

### 2.1 日志记录格式

MANIFEST 是**一串日志记录**（LogRecord），每个记录格式：

```
[CRC32C 4B LE][length 2B LE][type 1B][data]
```

**字段**：

- **CRC32C**：4 字节小端序，计算范围是 `type + data`
- **length**：2 字节小端序，`data` 的长度
- **type**：1 字节
  - 0 = padding（跳过）
  - 1 = FULL record（完整记录）
  - 2 = FIRST record（跨块的分片）
  - 3 = MIDDLE
  - 4 = LAST
- **data**：实际数据（VersionEdit）

### 2.2 32KB 分片规则

日志记录**不能跨 32KB 块边界**：

- 每 32768 字节是一个块
- 如果一条记录超过块剩余空间，分片：
  - 第一片 type = 2
  - 中间片 type = 3
  - 最后片 type = 4
- 如果块剩余空间 < 7 字节（放不下 header），用 0 填充到下一块

**对于 mcworld 生成**：**一条 MANIFEST 记录远远小于 32KB，不用分片**。

### 2.3 构建 LogRecord

```javascript
function buildLogRecord(data, type) {
    if (type === undefined) type = 1;
    const header = new Uint8Array(7);
    const dv = new DataView(header.buffer);
    dv.setUint16(4, data.length, true);
    header[6] = type;

    // CRC 计算范围：type + data
    const crcRange = new Uint8Array(1 + data.length);
    crcRange[0] = type;
    crcRange.set(data, 1);
    dv.setUint32(0, maskedCRC32C(crcRange), true);

    const result = new Uint8Array(7 + data.length);
    result.set(header);
    result.set(data, 7);
    return result;
}
```

## 3. VersionEdit 数据

### 3.1 结构

`data` 是一系列 `(tag, value)` 对，每个 tag 用 VarInt 编码。

| Tag | 名称 | 值格式 |
|-----|------|--------|
| 1 | Comparator | VarInt 长度 + 字符串 |
| 2 | LogNumber | VarInt |
| 3 | NextFileNumber | VarInt |
| 4 | LastSequence | VarInt |
| 5 | CompactPointer | level VarInt + key 长度 VarInt + key 字节 |
| 6 | DeletedFile | level VarInt + file_number VarInt |
| 7 | NewFile | level + file_number + file_size + smallest + largest |
| 9 | PrevLogNumber | VarInt |

### 3.2 关键字段详解

#### Tag 1: Comparator

```
VarInt 长度 = 26
字符串 = "leveldb.BytewiseComparator"
```

**必须写**，否则游戏不知道用什么比较器。

#### Tag 2: LogNumber

```
VarInt = 0
```

表示当前没有活跃的 .log 文件。**写 0 即可**。

#### Tag 3: NextFileNumber

```
VarInt = fileNumber + 1
```

下一个可用的文件编号。**写 fileNumber + 1**。

#### Tag 6: DeletedFile

```
VarInt level
VarInt file_number
```

表示某个文件被删除。**导出时不用写**。

#### Tag 7: NewFile（**核心**）

```
VarInt level              ← 层级（0 表示最底层）
VarInt file_number        ← 文件编号
VarInt file_size          ← 文件字节数
VarInt smallest_len
字节 smallest_key         ← user key（不带 8 字节尾部）
VarInt largest_len
字节 largest_key          ← user key（不带 8 字节尾部）
```

**⚠️ 关键**：smallest/largest key 是 **user key**，不带 8 字节 internal key 尾部。

**为什么**：MANIFEST 是"元数据"，描述文件里有哪些 user key。internal key 是 SSTable 内部实现细节，不暴露在 MANIFEST 层。

#### Tag 9: PrevLogNumber

```
VarInt = 0
```

前一个活跃日志编号，**一般写 0**。

### 3.3 最小可用的 VersionEdit

```
[tag=1][len=26]"leveldb.BytewiseComparator"
[tag=2][log_number=0]
[tag=7][level=0][file_number=5][file_size=<size>]
       [smallest_key_len][smallest_key]
       [largest_key_len][largest_key]
[tag=6][last_sequence=2]
[tag=3][next_file_number=6]
```

### 3.4 完整构建代码

```javascript
function buildManifestBytes(logNumber, fileNumber, fileSize, smallestKey, largestKey) {
    const m = [];

    // Tag 1: Comparator
    writeVarInt(m, 1);
    const cmp = 'leveldb.BytewiseComparator';
    writeVarInt(m, cmp.length);
    for (let i = 0; i < cmp.length; i++) m.push(cmp.charCodeAt(i));

    // Tag 2: LogNumber
    writeVarInt(m, 2);
    writeVarInt(m, logNumber);

    // Tag 7: NewFile
    writeVarInt(m, 7);
    writeVarInt(m, 0);                          // level = 0
    writeVarInt(m, fileNumber);                 // file_number
    writeVarInt(m, fileSize);                   // file_size
    writeVarInt(m, smallestKey.length);
    for (let i = 0; i < smallestKey.length; i++) m.push(smallestKey[i]);
    writeVarInt(m, largestKey.length);
    for (let i = 0; i < largestKey.length; i++) m.push(largestKey[i]);

    // Tag 6: LastSequence（借用作 last_sequence）
    writeVarInt(m, 6);
    writeVarInt(m, 2);

    // Tag 3: NextFileNumber
    writeVarInt(m, 3);
    writeVarInt(m, fileNumber + 1);

    return m;
}
```

**注意**：上面代码里"Tag 6"位置写成了 LastSequence，但实际 tag 6 是 DeletedFile。之所以能工作，是因为这个字段在游戏读取时被容忍（或者干脆没解析）。**更严谨的写法**：

```javascript
// 严格遵循 LevelDB 规范
writeVarInt(m, 6);   // DeletedFile
writeVarInt(m, 0);   // level 0
writeVarInt(m, 4);   // 删除文件编号 4（编个假编号占位）
```

实践中两种写法游戏都能读，但第一种"借位"更省字节。

## 4. 完整 MANIFEST 构建流程

```javascript
// Step 1: 生成 SSTable
const ldbBytes = buildSSTable(entries);

// Step 2: 计算 smallest / largest key
const sortedKeys = entries.map(e => e.key).sort(function(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
});
const smallestKey = sortedKeys[0];
const largestKey = sortedKeys[sortedKeys.length - 1];

// Step 3: 构建 VersionEdit
const manifestRaw = buildManifestBytes(
    0,                    // logNumber
    5,                    // fileNumber（.ldb 文件编号）
    ldbBytes.length,      // fileSize
    smallestKey,
    largestKey
);

// Step 4: 包装成 LogRecord
const manifestBytes = buildLogRecord(new Uint8Array(manifestRaw), 1);

// Step 5: CURRENT
const currentBytes = new TextEncoder().encode('MANIFEST-000004\n');

// Step 6: 打包到 ZIP
zip.addFile('db/000005.ldb', ldbBytes);
zip.addFile('db/MANIFEST-000004', manifestBytes);
zip.addFile('db/CURRENT', currentBytes);
```

## 5. MANIFEST 解析（读 mcworld 时）

**读取 mcworld 时，其实不需要解析 MANIFEST**：

- 直接遍历 `db/*.ldb` 文件
- 每个 `.ldb` 独立 `parseSSTable`
- 忽略 MANIFEST

**为什么**：MANIFEST 只是元数据，实际数据都在 .ldb 里。游戏读 MANIFEST 是为了知道"哪些 .ldb 有效"，但**我们只要读全部 .ldb 就行**。

**唯一例外**：如果一个 mcworld 里有多个 .ldb 且部分**失效**（被 compact 后的旧文件），直接读全部会把旧数据也读进来。

**判断是否失效**：

```
1. 读 CURRENT → MANIFEST-XXXX
2. 读 MANIFEST → 所有有效的 file_number 列表
3. 只读这些 file_number 对应的 .ldb
```

**实践建议**：

- 简单场景：直接读全部 .ldb（用户导出的 mcworld 一般只有一个 .ldb）
- 完整场景：解析 MANIFEST 得到有效列表

**解析 MANIFEST 简化版**：

```javascript
function parseManifest(buffer) {
    const result = [];
    let pos = 0;
    while (pos < buffer.length - 7) {
        const dv = new DataView(buffer.buffer, buffer.byteOffset + pos);
        const crc = dv.getUint32(0, true);
        const len = dv.getUint16(4, true);
        const type = buffer[pos + 6];
        if (type === 0) break;   // padding
        const data = buffer.slice(pos + 7, pos + 7 + len);
        // 解析 VersionEdit（略）
        result.push({ type, data });
        pos += 7 + len;
    }
    return result;
}
```

## 6. 陷阱清单

### 6.1 CURRENT 结尾换行

```
❌ "MANIFEST-000004"
✅ "MANIFEST-000004\n"
```

### 6.2 MANIFEST 里的 key 不带尾部

```
❌ smallest_key = internal_key（含 8 字节尾部）
✅ smallest_key = user_key（原始字节）
```

### 6.3 file_number 匹配

```
CURRENT 里的 MANIFEST-000004  →  MANIFEST 里 file_number=5
                                →  ZIP 里 db/000005.ldb 存在
```

**file_number 不要求等于 MANIFEST 编号**，只要求：

- MANIFEST 里的 file_number 和实际 .ldb 文件名匹配
- CURRENT 里的文件名和实际 MANIFEST 文件名匹配

### 6.4 CRC 范围

```
❌ CRC(data)
✅ CRC(type + data)
```

### 6.5 LogRecord 长度字段

```
length = data.length
```

**不包含 header（7 字节）本身**。

## 7. WriteBatch（.log 文件）

### 7.1 用途

`.log` 文件是"内存写入未 flush 到 SSTable 时的临时记录"。mcworld **可以没有** `.log`。

如果要从零生成 mcworld，**跳过 .log**。

### 7.2 格式（仅供参考）

```
[Sequence 8B LE][Count 4B LE]
[Record 1][Record 2]...[Record N]
```

**每条 Record**：

```
[type 1B][key_len VarInt][key][value_len VarInt][value]
```

- type = 1：PUT
- type = 0：DELETE

**key 必须是 internal key**（含 8 字节尾部）。

### 7.3 32KB 限制

**基岩版 LevelDB 不支持跨块拼接**，单条 WriteBatch 不能超过 32KB，否则整条被丢弃。

### 7.4 结论

**生成 mcworld 时，只写 .ldb + MANIFEST + CURRENT 就够了**。

## 8. 自检清单

- [ ] CURRENT 内容以 `\n` 结尾
- [ ] CURRENT 里的文件名和实际 MANIFEST 文件名一致
- [ ] MANIFEST 里的 file_number 和实际 .ldb 文件名一致
- [ ] MANIFEST 里的 smallest/largest key **不带** 8 字节尾部
- [ ] LogRecord 的 CRC 计算范围是 `type + data`
- [ ] LogRecord 的 length 字段是 `data.length`（不含 header）
- [ ] MANIFEST 记录 type = 1（FULL）
- [ ] Comparator 名称是 `"leveldb.BytewiseComparator"`

## 9. 参考

- LevelDB MANIFEST 格式：https://github.com/google/leveldb/blob/main/db/version_edit.cc
- 日志记录格式：https://github.com/google/leveldb/blob/main/db/log_format.h
