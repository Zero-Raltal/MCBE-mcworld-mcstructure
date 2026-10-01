---
name: minecraft-bedrock-codec
description: Minecraft 基岩版 .mcworld 与 .mcstructure 两种格式的完整读写逻辑、二进制结构、双向转换算法。适用于解析、生成、修复、转换这两种文件。
version: 3.1
target-version: Minecraft Bedrock 1.19.10+
triggers:
  - "mcworld"
  - "mcstructure"
  - "level.dat"
  - "LevelDB"
  - "SSTable"
  - "SubChunk"
  - "block_position_data"
  - "BlockEntity"
  - "基岩版存档"
  - "结构文件"
  - "Minecraft 世界转换"
tags:
  - minecraft
  - bedrock
  - binary-format
  - file-codec
  - nbt
  - leveldb
dependencies:
  - "JSZip 或同等 ZIP 库（浏览器/Node）"
  - "pako 或同等 zlib 库"
  - "无外部 NBT/LevelDB 库依赖（本 skill 自带实现）"
---

# Skill: Minecraft 基岩版 `.mcworld` / `.mcstructure` 编解码

> 本 skill 面向 **AI Agent**，以"能直接照抄实现"为标准编写。
> 内容涵盖 **二进制结构**、**读写逻辑**、**互转算法**、**踩坑清单**。
> 所有代码均为 **零外部 NBT/LevelDB 依赖** 的可运行 JavaScript。

---

## 0. Agent 快速入门

### 0.1 何时使用本 skill

**触发条件**（满足任一即加载本 skill）：

| 用户请求 | 你需要做的事 |
|---------|-------------|
| "把 .mcstructure 转成 .mcworld" | 见 §6.3 |
| "把 .mcworld 转成 .mcstructure" | 见 §6.2 |
| "读取/修改 .mcworld 里的方块" | 见 §5 + §6.2 |
| "读取/修改 .mcstructure 里的命令方块/告示牌" | 见 §4 |
| "生成的存档打不开" / "命令方块是空的" | 见 §7 陷阱清单 |
| "解析 level.dat" | 见 §5.2 |

**不适用**：

- Java 版 `.mca` / `.mcr` 格式（完全不同）
- `.mcfunction` / 数据包（纯文本，不需要二进制解析）
- 教育版 `.mcworld` 的变体（可能带额外字段，但主体格式兼容）

### 0.2 核心概念速览

```
.mcworld  = ZIP 包装的 LevelDB 数据库
.mcstructure = 纯 NBT 文件（一坨连续的字节）

两者都是"世界的一个切片"：
  - mcworld 存的是"完整的区块数据库"（含空气、光照、实体、BE 等）
  - mcstructure 存的是"一个矩形区域的方块 + BE"（不含光照、实体）

转换本质：
  mcworld → mcstructure：把多个 chunk 的 subChunk 合并成一个 3D 数组
  mcstructure → mcworld：把一个 3D 数组拆成多个 chunk 的 subChunk
```

### 0.3 最小工作流

**读取 mcworld 里的所有方块**：

```
1. 用 JSZip 加载 .mcworld
2. 遍历 db/*.ldb，对每个文件调用 parseSSTable() 收集 key-value
3. 对 key[8]==0x2f 的条目，调用 parseSubChunk() 得到方块
4. 对 key[8]==0x31 的条目，调用 parseNbt() 反复解析得到所有 BlockEntity
```

**生成 mcworld**：

```
1. 收集所有要写入的 key-value（SubChunk + BE + 元数据）
2. 调用 buildSSTable() 生成 .ldb 字节
3. 调用 buildManifestBytes() + buildLogRecord() 生成 MANIFEST
4. 生成 level.dat（NBT 编码）
5. 用 ZipBuilder 打包成 .mcworld
```

### 0.4 二进制读取第一原则

**所有字段都是小端序（Little Endian）**。

```javascript
// ✅ 用 DataView 显式指定 true
const v = view.getInt32(pos, true);

// ❌ 不要依赖宿主字节序
const v = view.getInt32(pos);   // 默认大端，错！
```

**所有字符串都是 UTF-8**，长度前缀的宽度见下文。

---

## 1. 术语表

| 术语 | 含义 |
|------|------|
| **NBT** | Named Binary Tag，MC 的通用数据格式 |
| **TAG** | NBT 的一个数据单元（类型 + 名称 + 值） |
| **Compound** | NBT 里的"字典"类型（TAG_Compound, ID 10） |
| **List** | NBT 里的"数组"类型（TAG_List, ID 9） |
| **Chunk** | 区块，16×16 的水平单位 |
| **SubChunk** | 子区块，16×16×16 的立方体单位 |
| **subY** | 子区块的 Y 索引（世界 Y = subY × 16） |
| **layer0 / layer1** | 子区块的两层（layer1 存水/雪/植物） |
| **palette** | 调色板，把一个子区块内的不同方块编号 |
| **bits** | 每个方块索引占用的位数（0/2/4/8） |
| **BlockEntity (BE)** | 方块实体，比如命令方块、告示牌、箱子 |
| **SSTable** | Sorted String Table，LevelDB 的核心存储文件 |
| **MANIFEST** | LevelDB 清单，记录所有 SSTable 的元数据 |
| **CURRENT** | 一个文本文件，指向当前 MANIFEST |
| **Internal Key** | SSTable 里的键 = user_key + 8 字节尾部 |
| **BlockHandle** | SSTable 里的 (offset, size) 对 |
| **扁平索引** | mcstructure 里的方块索引 `(sx*sizeY+sy)*sizeZ+sz` |

---

## 2. 两种格式鸟瞰

### 2.1 结构对照

```
.mcworld (ZIP)
├── level.dat                     ← NBT（8 字节头 + NBT 数据）
├── levelname.txt
├── world_behavior_packs.json
├── world_resource_packs.json
└── db/
    ├── CURRENT                   ← 文本："MANIFEST-000004\n"
    ├── MANIFEST-000004           ← 二进制，LogRecord 序列
    └── 000005.ldb                ← 二进制，SSTable

.mcstructure (纯 NBT)
└── TAG_Compound (根)
    ├── size
    ├── structure
    │   ├── block_indices         ← 2 层 Int32 数组
    │   ├── entities
    │   └── palette.default
    │       ├── block_palette
    │       └── block_position_data
    └── structure_world_origin
```

### 2.2 差异对照表

| 维度 | mcworld | mcstructure |
|------|---------|-------------|
| 顶层格式 | ZIP | 裸 NBT |
| 坐标 | 世界绝对坐标 | 结构相对坐标 (0..size-1) |
| 布局 | 按 chunk 分块 | 一整块稠密 3D 数组 |
| 方块索引顺序 | 子区块内 `x*256 + z*16 + y`（**XZY**） | 全局 `(x*sizeY + y)*sizeZ + z`（**XYZ**） |
| 方块索引类型 | 位打包（0/2/4/8 位） | Int32 数组 |
| 调色板 | 每个子区块独立 | 全局共享一份 |
| 层数 | layerCount 可 > 1 | 固定 2 层 |
| 空气 | 不存或存 palette | palette[0] 通常是 air |
| 方块实体 | 挂在 chunk 的 0x31 键 | 挂在 palette.default.block_position_data |
| BE 键 | 无键，按 x/y/z 匹配 | **扁平索引字符串** |
| 光照/生物群系 | 有独立字段 | 无 |
| 实体 | 有（0x32 键） | 有（entities 数组，一般空） |

### 2.3 位置映射公式

**mcstructure 坐标 → mcworld 坐标**：

```
worldX = originX + sx
worldY = originY + sy
worldZ = originZ + sz
```

**mcstructure 内的全局索引**：

```
structIdx = (sx * sizeY + sy) * sizeZ + sz
```

**mcworld 内子区块局部索引**：

```
cx = Math.floor(worldX / 16)
cz = Math.floor(worldZ / 16)
subY = Math.floor(worldY / 16)
lx = worldX - cx * 16
ly = worldY - subY * 16
lz = worldZ - cz * 16
subChunkIdx = lx * 256 + lz * 16 + ly
```

---

## 3. 详细文档索引

本文档已拆分为 13 个详细子文档，放在 `docs/`：

| 文件 | 内容 |
|------|------|
| `docs/01-nbt.md` | NBT 二进制编码 + 解析/写入器 |
| `docs/02-primitives.md` | CRC32C / VarInt / BlockHandle / ZIP |
| `docs/03-leveldb.md` | LevelDB 整体结构 |
| `docs/04-sstable.md` | SSTable 详细格式 |
| `docs/05-manifest.md` | MANIFEST + CURRENT |
| `docs/06-subchunk.md` | SubChunk（layer 0/1 + 位打包） |
| `docs/07-blockentity.md` | BlockEntity 处理 |
| `docs/08-leveldat.md` | level.dat 字段 + 陷阱 |
| `docs/09-mcstructure.md` | mcstructure 完整结构 |
| `docs/10-mcworld.md` | mcworld 组合 |
| `docs/11-conversion.md` | 双向转换算法 |
| `docs/12-pitfalls.md` | 陷阱清单（详细版） |
| `docs/13-checklist.md` | Agent 自检清单 |

**示例代码**：`examples/`（Node.js + 浏览器可用）

---

## 4. 最重要的一条

**`block_position_data` 的键必须是 `String(structIdx)` —— 扁平索引字符串，不是 `"sx,sy,sz"` 坐标。**

**⚠️ 社区里有大量文章写"键必须是 `'x,y,z'`"，这是错的。** 实测游戏只认扁平索引。

```javascript
// ❌ 错误（社区流传的错说法）
blockPositionData['8,1,8'] = entries;

// ✅ 正确
const structIdx = (sx * sizeY + sy) * sizeZ + sz;
blockPositionData[String(structIdx)] = entries;   // 例如 "536"
```

**写错的后果**：游戏静默丢弃**所有**方块实体数据，命令方块变空、告示牌变空白、箱子物品消失，**但方块本身还在**（因为方块数据在 `block_indices` 里是对的）。

**排查方法**：用 NBT 查看器打开 `.mcstructure`，看 `palette.default.block_position_data` 的键：

```
✅ 正确：
block_position_data:
  "536":            ← 数字字符串
    block_entity_data: { id: "CommandBlock", Command: "say hello", ... }

❌ 错误：
block_position_data:
  "8,1,8":          ← 坐标字符串，游戏会 Number("8,1,8") = NaN，静默跳过
    block_entity_data: { ... }
```

详见 `docs/07-blockentity.md` §3。

---

## 5. 关键常量速查

### 5.1 NBT 类型 ID

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

### 5.2 LevelDB 键 Tag

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

### 5.3 关键魔数 / 常量

| 名称 | 值 |
|------|-----|
| SSTable Footer 魔数 | `57 FB 80 8B 24 75 47 DB` |
| SSTable 压缩类型 | 0=无 / 1=Snappy / 2=zlib / **4=raw deflate** |
| CURRENT 内容 | `"MANIFEST-000004\n"` |
| 世界范围 | Y: -64 ~ 319（1.18+） |
| subY 范围 | -4 ~ 19 |
| 单条 `0x31` 记录上限 | **32 KB**（基岩版限制） |

---

## 6. 核心转换流程

### 6.1 决策树

```
用户想干什么？
├── 读取 mcworld 里的方块 → docs/10-mcworld.md
├── 读取 mcstructure 里的方块 → docs/09-mcstructure.md
├── mcworld → mcstructure → docs/11-conversion.md §2
└── mcstructure → mcworld → docs/11-conversion.md §3
```

### 6.2 mcworld → mcstructure 概要

```
1. 解压 .mcworld ZIP
2. 遍历 db/*.ldb 和 *.log，用 parseSSTable 收集 key-value
3. 分类：
   - key[8]==0x2f（长度 10）→ 子区块
   - key[8]==0x31（长度 9）→ 方块实体
4. 扫描范围（求 min/max 坐标）
5. 收集方块（两层）
6. 收集 BE：世界坐标 → 结构相对坐标，键 = String(structIdx)
7. 展开成 Int32Array
8. 构造 mcstructure NBT
9. 下载
```

### 6.3 mcstructure → mcworld 概要

```
1. 解析 mcstructure NBT
2. 读 size / palette / layer0 / layer1 / block_position_data
3. 遍历方块（两层），按 chunk 分组
4. 处理 BE：结构相对坐标 → 世界坐标
5. 构建 db 条目（SubChunk + BE + 元数据）
6. SSTable + MANIFEST + ZIP
7. 下载
```

---

## 7. 陷阱速查

按严重程度排序的 18 条陷阱，详见 `docs/12-pitfalls.md`。前 5 条最常踩：

| # | 陷阱 | 后果 |
|---|------|------|
| 1 | 只读 layer 0 | 水面、雪、草丛全丢 |
| 2 | **`block_position_data` 键写成 `"sx,sy,sz"`** | **所有 BE 丢失** |
| 3 | `bits=0` 未短路 | 全空气子区块读出越界 |
| 4 | 索引顺序搞混 XZY vs YZX | 方块错位、镜像 |
| 5 | 内部键缺 8 字节尾部 | 整个 SSTable 无法读取 |

---

## 8. 版本兼容性

基于 **Minecraft 基岩版 1.19.10** 实测，兼容 1.21。

| 版本 | 差异 |
|------|------|
| 1.18 前 | 世界最低 Y = 0，不支持负 Y |
| 1.18+ | 世界范围 -64 ~ 319 |
| 1.19.10 | 子区块 version = 9，storageFormat 支持 4 位 |
| 1.19.80+ | 告示牌 `FrontText` / `BackText` 双面结构 |
| 1.20+ | 告示牌发光字段变 `has_glowing_text`；新增 `isWaxed` |
| 1.21+ | 部分 BE id 前缀 `minecraft:` |

---

## 9. License

MIT
