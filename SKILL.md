# minecraft-bedrock-codec

Minecraft 基岩版 `.mcworld` / `.mcstructure` 读写 skill，供 AI Agent 使用。

## 目录结构

```
minecraft-bedrock-codec/
├── SKILL.md                        ← 你在这里：总纲 + 导航
├── docs/
│   ├── 01-nbt.md                   ← NBT 二进制格式 + 解析/写入器
│   ├── 02-primitives.md            ← CRC32C / VarInt / BlockHandle / ZIP
│   ├── 03-leveldb.md               ← LevelDB 整体结构
│   ├── 04-sstable.md               ← SSTable 详细格式
│   ├── 05-manifest.md              ← MANIFEST + CURRENT
│   ├── 06-subchunk.md              ← SubChunk（layer 0/1 + 位打包）
│   ├── 07-blockentity.md           ← BlockEntity 处理
│   ├── 08-leveldat.md              ← level.dat 字段 + 陷阱
│   ├── 09-mcstructure.md           ← mcstructure 完整结构
│   ├── 10-mcworld.md               ← mcworld 组合
│   ├── 11-conversion.md            ← 双向转换算法
│   ├── 12-pitfalls.md              ← 陷阱清单（详细版）
│   └── 13-checklist.md             ← Agent 自检清单
├── examples/
│   ├── README.md
│   ├── read-mcworld.js             ← 读取 mcworld 里的所有方块
│   ├── write-mcworld.js            ← 从零生成 mcworld
│   ├── read-mcstructure.js         ← 读取 mcstructure
│   └── write-mcstructure.js        ← 从零生成 mcstructure
└── LICENSE                         ← CC BY 4.0
```

## 什么时候用这个 skill

**触发条件**（满足任一即加载）：

| 用户请求 | 你该打开的文件 |
|---------|---------------|
| "把 .mcstructure 转成 .mcworld" | `docs/11-conversion.md` |
| "把 .mcworld 转成 .mcstructure" | `docs/11-conversion.md` |
| "读取 .mcworld 里的方块" | `docs/10-mcworld.md` + `docs/04-sstable.md` + `docs/06-subchunk.md` |
| "读取 .mcstructure 里的命令方块/告示牌" | `docs/09-mcstructure.md` + `docs/07-blockentity.md` |
| "生成的存档打不开" / "命令方块是空的" | `docs/12-pitfalls.md` |
| "解析 level.dat" | `docs/08-leveldat.md` |
| "为什么 .mcstructure 里的水/雪/草丢了" | `docs/06-subchunk.md` §layer |
| "SSTable / LevelDB 格式是什么" | `docs/03-leveldb.md` + `docs/04-sstable.md` |

**不适用**：

- Java 版 `.mca` / `.mcr` 格式（完全不同）
- `.mcfunction` / 数据包（纯文本）
- 教育版 `.mcworld` 的变体（可能带额外字段，但主体兼容）

## 核心认知

### 两种格式的本质

```
.mcworld     = ZIP 包装的 LevelDB 数据库
.mcstructure = 纯 NBT 文件（一坨连续的字节）

转换本质：
  mcworld → mcstructure：把多个 chunk 的 subChunk 合并成一个 3D 数组
  mcstructure → mcworld：把一个 3D 数组拆成多个 chunk 的 subChunk
```

### 依赖关系图

```
                    ┌─────────────┐
                    │ 01-nbt.md   │ ← 最底层，所有格式都依赖它
                    │ (NBT 编码)  │
                    └──────┬──────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
     ┌────▼─────┐    ┌─────▼──────┐    ┌────▼─────┐
     │ 08-level │    │ 06-subchunk│    │ 09-mc-   │
     │   .dat   │    │            │    │ structure│
     └──────────┘    └─────┬──────┘    └────┬─────┘
                           │                │
                    ┌──────▼──────┐         │
                    │ 07-block-   │         │
                    │   entity    │         │
                    └──────┬──────┘         │
                           │                │
                    ┌──────▼────────────────▼──────┐
                    │       10-mcworld.md          │
                    │  (组合 SubChunk + BE + ...)  │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │       11-conversion.md       │
                    │       双向转换算法            │
                    └──────────────────────────────┘

底层原语（所有文件都可能引用）：
  02-primitives.md  → CRC32C / VarInt / BlockHandle / ZIP
  03-leveldb.md     → LevelDB 整体框架
  04-sstable.md     → SSTable 详细格式
  05-manifest.md    → MANIFEST + CURRENT
```

### 阅读顺序建议

**首次实现完整转换器**：

```
01-nbt.md  →  02-primitives.md  →  03-leveldb.md
    ↓
04-sstable.md  →  05-manifest.md
    ↓
06-subchunk.md  →  07-blockentity.md
    ↓
08-leveldat.md  →  09-mcstructure.md  →  10-mcworld.md
    ↓
11-conversion.md
    ↓
12-pitfalls.md  →  13-checklist.md
```

**快速修改某个 bug**：

```
12-pitfalls.md  →  相关文件（症状反查表会指出）
```

**只需读 mcworld 里的方块**：

```
04-sstable.md  →  06-subchunk.md
```

## 快速上手：最小工作流

### 读取 mcworld 里的方块

```
1. 用 JSZip 加载 .mcworld
2. 遍历 db/*.ldb，对每个文件调用 parseSSTable() 收集 key-value
3. 对 key[8]==0x2f 的条目，调用 parseSubChunk() 得到方块
4. 对 key[8]==0x31 的条目，调用 parseNbt() 反复解析得到所有 BlockEntity
```

**详细代码**：`docs/10-mcworld.md` §读取流程

### 生成 mcworld

```
1. 收集所有要写入的 key-value（SubChunk + BE + 元数据）
2. 调用 buildSSTable() 生成 .ldb 字节
3. 调用 buildManifestBytes() + buildLogRecord() 生成 MANIFEST
4. 生成 level.dat（NBT 编码）
5. 用 ZipBuilder 打包成 .mcworld
```

**详细代码**：`docs/10-mcworld.md` §生成流程

### 读取 mcstructure

```
1. 用 parseNbt() 解析整个文件
2. 读 root.size → sizeX / sizeY / sizeZ
3. 读 root.structure.block_indices → layer0 / layer1
4. 读 root.structure.palette.default.block_palette → 调色板
5. 读 root.structure.palette.default.block_position_data → BE
```

**详细代码**：`docs/09-mcstructure.md`

## 关键常量速查

### NBT 类型 ID

| ID | 类型 | 长度前缀 |
|----|------|---------|
| 0 | TAG_End | — |
| 1 | TAG_Byte | — |
| 2 | TAG_Short | — |
| 3 | TAG_Int | — |
| 4 | TAG_Long | — |
| 5 | TAG_Float | — |
| 6 | TAG_Double | — |
| 7 | TAG_ByteArray | int32 |
| 8 | TAG_String | **uint16** ← 唯一一个 |
| 9 | TAG_List | int32 |
| 10 | TAG_Compound | — |
| 11 | TAG_IntArray | int32 |
| 12 | TAG_LongArray | int32 |

### LevelDB 键 Tag

| Tag | 名称 | 后缀 |
|-----|------|------|
| 0x2B | Data3D | 无 |
| 0x2C | ChunkVersion | 无 |
| 0x2F | SubChunkTerrain | subY (1B) |
| 0x31 | BlockEntity | 无 |
| 0x32 | Entity | 无 |
| 0x36 | Data2D | 无 |
| 0x3F | 生物群系 | 无 |
| 0x40 / 0x41 / 0x77 | 元数据 | 无 |

### 关键魔数 / 常量

| 名称 | 值 |
|------|-----|
| SSTable Footer 魔数 | `57 FB 80 8B 24 75 47 DB` |
| SSTable 压缩类型 | 0=无 / 1=Snappy / 2=zlib / **4=raw deflate** |
| CURRENT 内容 | `"MANIFEST-000004\n"` |
| 世界范围 | Y: -64 ~ 319（1.18+） |
| subY 范围 | -4 ~ 19 |
| 单条 `0x31` 记录上限 | **32 KB**（基岩版限制） |

## 最重要的一条

**`block_position_data` 的键必须是 `"sx,sy,sz"` 字符串，不是扁平索引。**

这是 mcstructure 侧**最常被搞错**的一点。写错了会导致**所有**方块实体（命令方块指令、告示牌文字、箱子物品）静默丢失，而方块本身还在。详见 `docs/09-mcstructure.md` §block_position_data 和 `docs/12-pitfalls.md` §2。

## 版本兼容性

基于 **Minecraft 基岩版 1.19.10** 实测，兼容 1.21。

| 版本 | 差异 |
|------|------|
| 1.18 前 | 世界最低 Y = 0，不支持负 Y |
| 1.18+ | 世界范围 -64 ~ 319 |
| 1.19.10 | 子区块 version = 9，storageFormat 支持 4 位 |
| 1.19.80+ | 告示牌 `FrontText` / `BackText` 双面结构 |
| 1.20+ | 告示牌发光字段变 `has_glowing_text`；新增 `isWaxed` |
| 1.21+ | 部分 BE id 前缀 `minecraft:` |

## License

MIT

## 作者：ZeroRaltal
