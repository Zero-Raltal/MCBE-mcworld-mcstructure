# 03 - LevelDB 整体结构

> `.mcworld` 的核心是 LevelDB 数据库。本文件讲清它的**文件角色**、**数据流**、**生命周期**。
> 具体的 SSTable / MANIFEST 格式见 `04-sstable.md` / `05-manifest.md`。

## 1. 文件角色

```
db/
├── CURRENT              ← 文本："MANIFEST-000004\n"
├── MANIFEST-000004      ← 二进制，版本编辑日志
├── 000005.ldb           ← 二进制，SSTable 数据
├── 000006.ldb           ← 可能有多个
└── 000003.log           ← 二进制，增量写入日志（可选）
```

| 文件 | 角色 | 可删除? |
|------|------|---------|
| CURRENT | 指针，指向当前 MANIFEST | ❌ 必须存在 |
| MANIFEST-N | 记录所有 SSTable 的元数据 | ❌ 必须存在 |
| N.ldb | 实际数据 | ❌ 至少一个 |
| N.log | 增量写入 | ✅ 可无 |

## 2. 游戏读档流程

```
1. 读 CURRENT → 得到 "MANIFEST-000004"
2. 读 MANIFEST-000004 → 得到所有 .ldb 列表
3. 按文件编号顺序读每个 .ldb → 加载所有 key-value
4. 读 .log（若有）→ 应用增量写入
5. 把所有 key-value 合并成一个"逻辑数据库"
6. 按 key 解释：
   - 长度 9-10 且前 4 字节是有效 chunkX → chunk 键
   - 否则 → 全局字符串键
```

**关键点**：游戏**不关心**文件叫什么，只关心：

- CURRENT 指向的 MANIFEST 存在
- MANIFEST 里列出的 .ldb 都存在
- 每个 .ldb 的 Footer 魔数正确

## 3. 键（Key）分类

LevelDB 是 **KV 存储**，没有表结构。键分两大类：

### 3.1 区块键（二进制）

格式：

```
[ChunkX int32 LE 4B][ChunkZ int32 LE 4B][Tag 1B] + 可选后缀
```

| Tag | 名称 | 后缀 | 值格式 |
|-----|------|------|--------|
| `0x2B` | Data3D | 无 | 540 字节光照数据 |
| `0x2C` | ChunkVersion | 无 | 1 字节 |
| `0x2F` | SubChunkTerrain | subY (1B) | SubChunk 数据 |
| `0x30` | SubChunkExtraData | subY | 额外数据 |
| `0x31` | BlockEntity | 无 | 一串 NBT Compound |
| `0x32` | Entity | 无 | 实体数据 |
| `0x33` | PendingTicks | 无 | 计划刻 |
| `0x36` | Data2D | 无 | 4 字节 |
| `0x3F` | 生物群系 | 无 | 8 字节哈希 |
| `0x40` | 未知 | 无 | `00 0A` |
| `0x41` | 未知 | 无 | `00` |
| `0x77` | 未知 | 无 | 空 |

### 3.2 全局字符串键

键就是 UTF-8 字符串本身：

| 键名 | 内容 |
|------|------|
| `scoreboard` | 计分板 NBT |
| `Overworld` | 主世界元数据 |
| `BiomeData` | 生物群系数据 |
| `LevelChunkMetaDataDictionary` | 区块元数据字典 |
| `mobevents` | 生物事件开关 |
| `schedulerWT` | 流浪商人调度 |
| `~local_player` | 本地玩家 NBT |

## 4. 键构造函数

### 4.1 完整实现

```javascript
function makeChunkKey(cx, cz, tag, subY) {
    const len = (subY !== undefined) ? 10 : 9;
    const k = new Uint8Array(len);
    const dv = new DataView(k.buffer);
    dv.setInt32(0, cx, true);       // chunkX 小端序
    dv.setInt32(4, cz, true);       // chunkZ 小端序
    k[8] = tag;
    if (subY !== undefined) k[9] = subY & 0xFF;
    return k;
}
```

### 4.2 键解析

```javascript
function parseChunkKey(key) {
    if (key.length < 9) return null;
    const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
    const cx = view.getInt32(0, true);
    const cz = view.getInt32(4, true);
    const tag = key[8];

    let subY = null;
    if (key.length === 10) {
        subY = new Int8Array([key[9]])[0];   // 有符号
    }

    return { cx, cz, tag, subY };
}
```

### 4.3 ⚠️ subY 是有符号字节

世界范围 -64 ~ 319 对应 subY = -4 ~ 19。

**写入时**：

```javascript
k[9] = subY & 0xFF;   // -4 → 0xFC
```

**读取时**：

```javascript
const subY = new Int8Array([key[9]])[0];   // 0xFC → -4
```

## 5. 元数据键（写 mcworld 时必须包含）

导出 mcworld 时，**每个 chunk** 都要写以下键值（否则游戏可能不认）：

| Tag | 值 | 说明 |
|-----|-----|------|
| `0x2B` | 540 字节 `04 00 04 00 ... 04 00` | 光照数据占位 |
| `0x2C` | `2A` | ChunkVersion = 42 |
| `0x36` | `02 00 00 00` | Data2D |
| `0x3F` | `B5 60 75 FD 69 2A 3C 93` | 生物群系哈希 |
| `0x40` | `00 0A` | 未知 |
| `0x41` | `00` | 未知 |
| `0x77` | 空 | 未知 |

```javascript
const v2b = new Uint8Array(540);
for (let i = 0; i < 270; i++) v2b[i * 2] = 0x04;
const tag2c = new Uint8Array([0x2a]);
const tag36 = new Uint8Array([2, 0, 0, 0]);
const tag3f = new Uint8Array([0xb5, 0x60, 0x75, 0xfd, 0x69, 0x2a, 0x3c, 0x93]);
const tag40 = new Uint8Array([0x00, 0x0a]);
const tag41 = new Uint8Array([0x00]);
const tag77 = new Uint8Array(0);
```

**⚠️ 缺这些会怎样**：

- 缺 `0x2B`：光照可能错乱
- 缺 `0x3F`：生物群系可能异常
- 缺 `0x36`：可能导致 chunk 加载失败

## 6. 完整构建流程

```
1. 收集所有 key-value 条目到 entries 数组
   ├── SubChunk 条目（每个 subY 一条）
   ├── BlockEntity 条目（每个 chunk 一条）
   └── 元数据条目（每个 chunk 若干条）
2. 按 key 字节序排序 entries
3. buildSSTable(entries) → .ldb 字节
4. buildManifestBytes(...) + buildLogRecord(...) → MANIFEST 字节
5. 打包成 ZIP
```

### 6.1 entries 数组的形态

```javascript
const entries = [
    { key: Uint8Array, value: Uint8Array },   // 每条一个对象
    // ...
];
```

### 6.2 排序（**必须**）

```javascript
entries.sort(function(a, b) {
    const n = Math.min(a.key.length, b.key.length);
    for (let i = 0; i < n; i++) {
        if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    }
    return a.key.length - b.key.length;
});
```

**字节序排序规则**：

1. 逐字节比较
2. 第一个不同的字节，小的在前
3. 如果前缀相同，短的在前

**为什么必须排序**：SSTable 要求键严格递增。不排序会导致游戏读取时二分查找错乱。

## 7. 文件命名约定

```
db/CURRENT              → 内容 "MANIFEST-000004\n"
db/MANIFEST-000004      → MANIFEST 文件（编号 4）
db/000005.ldb           → 第一个 SSTable（编号 5）
```

编号可以不同，只要：

- CURRENT 指向的 MANIFEST 存在
- MANIFEST 里的 `file_number` 对应实际 `.ldb` 编号

**惯例**：

- MANIFEST 编号从 4 开始（前面可能有被合并的）
- .ldb 编号从 5 开始
- 编号都用 6 位零填充

## 8. 逻辑数据流图

```
写 mcworld：
  entries 数组
      ↓ sort by key bytes
  entries 排序
      ↓ buildSSTable
  .ldb 字节
      ↓ 计算 smallest / largest key
  MANIFEST 原始数据
      ↓ buildLogRecord
  MANIFEST 文件字节
      ↓
  ZIP 打包（含 level.dat + CURRENT + MANIFEST + .ldb）

读 mcworld：
  ZIP 解压
      ↓ 读 CURRENT 得到 MANIFEST 名
      ↓ 读 MANIFEST 得到 .ldb 列表
      ↓ 读每个 .ldb，parseSSTable
  entries 数组
      ↓ 按 key 解释
  逻辑数据库
```

## 9. 与 mcstructure 的关系

| LevelDB 里的内容 | mcstructure 里有吗？ |
|-----------------|---------------------|
| SubChunk 方块数据 | ✅ 对应 block_indices |
| BlockEntity | ✅ 对应 block_position_data |
| 光照 | ❌ 不存 |
| 生物群系 | ❌ 不存 |
| 实体（0x32） | ⚠️ 部分（entities 字段，一般空） |
| 计划刻 | ❌ 不存 |
| 计分板 | ❌ 不存 |

**结论**：mcstructure 是 mcworld 的"精简子集"，只保留方块和 BE。

## 10. 自检清单

- [ ] CURRENT 内容格式为 `"MANIFEST-000004\n"`（含 `\n`）
- [ ] MANIFEST 里的 smallest/largest key 是**原始 user key**（不带 8 字节尾部）
- [ ] entries 按 key 字节序排序
- [ ] 每个 chunk 都写了全部 7 个元数据键
- [ ] subY 是有符号字节（负值用 `& 0xFF`）
- [ ] .ldb 文件扩展名是 `.ldb`（不是 `.sst`）
- [ ] ZIP 里文件路径用 `/`（不是 `\`）

## 11. 参考

- LevelDB 官方文档：https://github.com/google/leveldb/blob/main/doc/table_format.md
- 基岩版 LevelDB 结构：https://minecraft.fandom.com/wiki/Bedrock_Edition_level_format
