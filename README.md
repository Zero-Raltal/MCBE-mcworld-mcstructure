<div align="center">

# minecraft-bedrock-codec

**Minecraft 基岩版 `.mcworld` ⇄ `.mcstructure` 双向转换工具包**

零外部 NBT / LevelDB 依赖 · Node.js 与浏览器通用 · 完整技术文档 + 可运行示例

[![Minecraft](https://img.shields.io/badge/Minecraft-Bedrock-62B47A?style=flat-square)](https://www.minecraft.net/)
[![Version](https://img.shields.io/badge/Version-1.19.10+-blue?style=flat-square)]()
[![License](https://img.shields.io/badge/License-MIT-lightgrey?style=flat-square)](./LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A514-339933?style=flat-square&logo=node.js&logoColor=white)]()
[![Browser](https://img.shields.io/badge/Browser-UMD-orange?style=flat-square)]()

[快速开始](#-快速开始) · [文档](#-文档导航) · [示例](#-示例代码) · [常见问题](#-常见问题)

</div>

---

## 这是什么？

一个**从零实现的** Minecraft 基岩版存档格式编解码工具包，涵盖：

- **`.mcworld`**（ZIP 包装的 LevelDB 数据库）—— 完整世界存档
- **`.mcstructure`**（纯 NBT 文件）—— 结构文件，用于结构方块、行为包等

提供**双向转换**、**方块与方块实体解析**、**所有底层二进制原语的完整实现**。

**适合场景**：

- 解析存档、导出结构、修复损坏的文件
- 学习基岩版 LevelDB / NBT / SSTable 的内部格式
- 作为 AI Agent 的知识库（skill）加载
- 作为其他工具（地图编辑器、结构生成器）的底层库

---

## 特性

| 特性 | 说明 |
|------|------|
| **零依赖** | 核心逻辑不依赖任何 NBT / LevelDB 库；只用 `jszip` 做 ZIP、`pako` 做 zlib 兜底 |
| **UMD 模块** | 同一份 `utils.js` 同时支持 Node.js（`require`）和浏览器（`window.McCodec`） |
| **双向转换** | `.mcworld ⇄ .mcstructure`，包含方块、方块实体、layer 1 贴附方块（水/雪/植物） |
| **完整文档** | 13 篇技术文档，覆盖 NBT / SSTable / SubChunk / BlockEntity / level.dat 等所有格式细节 |
| **可运行示例** | 4 个 Node.js 示例 + 1 个浏览器 Demo 页面 |
| **实测验证** | 所有格式细节均在 Minecraft 基岩版 1.19.10 实测，兼容 1.21 |

---

## 快速开始

### 方式一：浏览器（无需安装）

```bash
git clone https://github.com/yourname/minecraft-bedrock-codec.git
cd minecraft-bedrock-codec

# 启动一个静态服务器（不能用 file:// 打开）
python3 -m http.server 8000
```

浏览器打开 **`http://localhost:8000/docs/demo.html`**，即可：

- 读取 `.mcworld` → 输出方块统计 + 所有 BE
- 生成 `.mcworld`（测试世界）
- 读取 `.mcstructure` → 输出结构信息
- 生成 `.mcstructure`（测试结构）

### 方式二：Node.js

```bash
cd examples
npm install jszip pako

# 读取 .mcworld
node read-mcworld.js path/to/world.mcworld

# 生成测试 .mcworld
node write-mcworld.js test.mcworld

# 读取 .mcstructure
node read-mcstructure.js path/to/structure.mcstructure

# 生成测试 .mcstructure
node write-mcstructure.js test.mcstructure
```

### 方式三：作为库使用

```javascript
const u = require('./examples/utils');

// 解析 NBT
const nbt = u.parseNbt(bytes, 0);

// 解析 SSTable
const result = u.parseSSTable(ldbBytes);
console.log('解析出', result.entries.length, '条 key-value');

// 解析 SubChunk
const sub = u.parseSubChunk(subChunkBytes);
for (const layer of sub.layers) {
    // layer.palette, layer.indexBytes, layer.bits
}

// 构建 SSTable
const ldb = u.buildSSTable([
    { key: new Uint8Array([...]), value: new Uint8Array([...]) }
]);
```

---

## 目录结构

```
minecraft-bedrock-codec/
├── README.md                    ← 本文件
├── SKILL.md                     ← 总纲 + 导航（Agent 从这里开始）
├── LICENSE                      ← CC BY 4.0
├── docs/
│   ├── 01-nbt.md                ← NBT 二进制编码 + 解析/写入器
│   ├── 02-primitives.md         ← CRC32C / VarInt / BlockHandle / ZIP
│   ├── 03-leveldb.md            ← LevelDB 整体结构
│   ├── 04-sstable.md            ← SSTable 详细格式
│   ├── 05-manifest.md           ← MANIFEST + CURRENT
│   ├── 06-subchunk.md           ← SubChunk（layer 0/1 + 位打包）
│   ├── 07-blockentity.md        ← BlockEntity 处理
│   ├── 08-leveldat.md           ← level.dat 字段 + 陷阱
│   ├── 09-mcstructure.md        ← mcstructure 完整结构
│   ├── 10-mcworld.md            ← mcworld 组合
│   ├── 11-conversion.md         ← 双向转换算法
│   ├── 12-pitfalls.md           ← 陷阱清单（18 条）
│   ├── 13-checklist.md          ← Agent 自检清单
│   └── demo.html                ← 浏览器 Demo 页面
└── examples/
    ├── README.md
    ├── utils.js                 ← 所有 helper 函数（UMD）
    ├── read-mcworld.js
    ├── write-mcworld.js
    ├── read-mcstructure.js
    └── write-mcstructure.js
```

---

## 文档导航

| 你想做什么 | 阅读顺序 |
|-----------|---------|
| **快速了解格式** | [`SKILL.md`](./SKILL.md) → [`docs/03-leveldb.md`](./docs/03-leveldb.md) |
| **实现读 mcworld** | [`docs/04-sstable.md`](./docs/04-sstable.md) → [`docs/06-subchunk.md`](./docs/06-subchunk.md) |
| **实现读 mcstructure** | [`docs/09-mcstructure.md`](./docs/09-mcstructure.md) |
| **实现转换器** | [`docs/11-conversion.md`](./docs/11-conversion.md) |
| **排查 Bug** | [`docs/12-pitfalls.md`](./docs/12-pitfalls.md) → [`docs/13-checklist.md`](./docs/13-checklist.md) |
| **AI Agent 使用** | 直接加载 [`SKILL.md`](./SKILL.md)（含 YAML frontmatter） |

**核心文档一览**：

- **NBT 编码**：[`01-nbt.md`](./docs/01-nbt.md) —— 所有格式的基础
- **SSTable 格式**：[`04-sstable.md`](./docs/04-sstable.md) —— LevelDB 的核心
- **SubChunk 格式**：[`06-subchunk.md`](./docs/06-subchunk.md) —— 方块数据的实际存储
- **BlockEntity**：[`07-blockentity.md`](./docs/07-blockentity.md) —— 命令方块 / 告示牌 / 箱子
- **陷阱清单**：[`12-pitfalls.md`](./docs/12-pitfalls.md) —— 18 条实测踩坑

---

## 示例代码

### 读取 `.mcworld` 中的所有命令方块指令

```javascript
const fs = require('fs');
const JSZip = require('jszip');
const u = require('./examples/utils');

async function listCommandBlocks(mcworldPath) {
    const buffer = fs.readFileSync(mcworldPath);
    const zip = await JSZip.loadAsync(buffer);

    for (const path of Object.keys(zip.files)) {
        if (!path.startsWith('db/') || !path.endsWith('.ldb')) continue;

        const bytes = await zip.file(path).async('uint8array');
        const result = u.parseSSTable(bytes);

        for (const entry of result.entries) {
            // 0x31 = BlockEntity
            if (entry.key.length !== 9 || entry.key[8] !== 0x31) continue;

            const beList = u.parseBlockEntities(entry.value);
            for (const be of beList) {
                if (!be.id || be.id.value !== 'CommandBlock') continue;
                console.log(
                    `[${be.x.value}, ${be.y.value}, ${be.z.value}]`,
                    be.Command ? be.Command.value : '(空)'
                );
            }
        }
    }
}

listCommandBlocks('world.mcworld');
```

### 生成一个含命令方块的 `.mcstructure`

```javascript
const fs = require('fs');
const u = require('./examples/utils');

// 1. 定义结构尺寸和方块
const sizeX = 16, sizeY = 4, sizeZ = 16;
const totalBlocks = sizeX * sizeY * sizeZ;

const palette = [
    { name: 'minecraft:air', states: {} },
    { name: 'minecraft:stone', states: {} },
    { name: 'minecraft:command_block', states: {
        conditional_bit: { type: 'Byte', value: 0 },
        facing_direction: { type: 'Int', value: 0 }
    }}
];

// 2. 填充方块索引
const indices0 = new Int32Array(totalBlocks).fill(-1);
for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
        indices0[(x * sizeY + 0) * sizeZ + z] = 1;   // stone
    }
}
const sx = 8, sy = 1, sz = 8;
const cmdBlockIdx = (sx * sizeY + sy) * sizeZ + sz;
indices0[cmdBlockIdx] = 2;   // command_block

// 3. 方块实体 —— 键是扁平索引！
const be = [
    { name: 'id', type: 8, value: 'CommandBlock' },
    { name: 'x', type: 3, value: sx },
    { name: 'y', type: 3, value: sy },
    { name: 'z', type: 3, value: sz },
    { name: 'Command', type: 8, value: 'say hello' },
    // ... 其他字段
];

const bpEntries = [
    {
        name: String(cmdBlockIdx),   // ★ "536"，不是 "8,1,8"
        type: 10,
        value: [
            { name: 'block_entity_data', type: 10, value: be }
        ]
    }
];

// 4. 构造 NBT 并写入
const root = [
    { name: 'format_version', type: 3, value: 1 },
    { name: 'size', type: 9, value: { itemType: 3, items: [sizeX, sizeY, sizeZ] } },
    { name: 'structure', type: 10, value: [
        { name: 'block_indices', type: 9, value: { itemType: 9, items: [
            { itemType: 3, items: Array.from(indices0) },
            { itemType: 3, items: new Array(totalBlocks).fill(-1) }
        ]}},
        { name: 'entities', type: 9, value: { itemType: 10, items: [] } },
        { name: 'palette', type: 10, value: [
            { name: 'default', type: 10, value: [
                { name: 'block_palette', type: 9, value: { itemType: 10, items: palette.map(p => [
                    { name: 'name', type: 8, value: p.name },
                    { name: 'states', type: 10, value: Object.keys(p.states).map(k => ({
                        name: k, type: u.NBT_TYPE_IDS[p.states[k].type] || 3, value: p.states[k].value
                    })) },
                    { name: 'version', type: 3, value: 18168865 }
                ]) } },
                { name: 'block_position_data', type: 10, value: bpEntries }
            ]}
        ]}
    ]},
    { name: 'structure_world_origin', type: 9, value: { itemType: 3, items: [0, 0, 0] } }
];

fs.writeFileSync('my_structure.mcstructure', u.bSerializeBE(root));
```

---

## 最容易踩的坑

> **`block_position_data` 的键必须是扁平索引字符串 `String(structIdx)`，不是 `"sx,sy,sz"` 坐标。**

社区里有**大量**文章写"键必须是 `'x,y,z'`"——这是**错误**的。实测游戏只认扁平索引。

```javascript
// ❌ 错误（游戏静默丢弃，所有 BE 丢失）
blockPositionData['8,1,8'] = entries;

// ✅ 正确
const structIdx = (sx * sizeY + sy) * sizeZ + sz;
blockPositionData[String(structIdx)] = entries;   // 例如 "536"
```

**症状**：方块正常，但命令方块是空的、告示牌是空白的、箱子物品消失。

**排查**：用 NBT 查看器打开 `.mcstructure`，看 `palette.default.block_position_data` 的键：

```
✅ 正确：
  "536": { block_entity_data: { id: "CommandBlock", Command: "..." } }

❌ 错误：
  "8,1,8": { block_entity_data: { ... } }     ← 游戏会 Number("8,1,8") = NaN，静默跳过
```

详见 [`docs/07-blockentity.md` §3](./docs/07-blockentity.md)。

---

## 🔧 版本兼容性

| MC 版本 | 支持 | 差异 |
|---------|------|------|
| 1.18 前 | ⚠️ | 世界最低 Y = 0，不支持负 Y |
| **1.18 - 1.19.80** | ✅ | 完整支持 |
| **1.19.80 - 1.21** | ✅ | 告示牌双面结构（FrontText/BackText） |
| 1.20+ | ✅ | 告示牌新增 `isWaxed` 字段 |
| 1.21+ | ✅ | 部分 BE id 前缀 `minecraft:` |

**测试环境**：Minecraft 基岩版 1.19.10（Windows）

---

## 常见问题

**Q: 生成的 `.mcworld` 游戏打不开？**

A: 检查以下三点（详见 [`docs/08-leveldat.md`](./docs/08-leveldat.md)）：
1. `lastOpenedWithVersion` 必须是 `List<Int>`（不是 String）
2. `SpawnY` 必须是 `32767`
3. `Generator` 必须是 `2`（平坦世界）

**Q: 命令方块在游戏里是空的？**

A: 99% 是 `block_position_data` 的键写错了。必须是 `String(structIdx)`，不是 `"8,1,8"`。详见 [§最容易踩的坑](#-最容易踩的坑)。

**Q: 水面、雪、草丛丢失？**

A: 只读了 layer 0，没读 layer 1。详见 [`docs/06-subchunk.md`](./docs/06-subchunk.md) §3。

**Q: 大存档解析时浏览器崩溃？**

A: mcstructure 用稠密 Int32 数组存储，1 亿方块约 800 MB。建议加阈值警告（推荐 1000 万方块），或分区块导出。

**Q: Node.js 里能直接用 `utils.js` 吗？**

A: 能。`utils.js` 是 UMD 格式，`require('./utils')` 直接可用。浏览器里通过 `<script src="utils.js">` 后用 `window.McCodec` 访问。

**Q: 我可以生成 Java 版的 `.mca` 吗？**

A: 不行。Java 版格式完全不同，本项目只支持基岩版。

---

## 贡献

欢迎提交 Issue 和 PR。特别欢迎：

- **报告 Bug**：附上最小复现文件（截图 + 日志）
- **补充文档**：特别是没覆盖到的方块类型
- **新增示例**：比如 GUI 工具、批量转换脚本
- **翻译**：英文版 README / 文档

**提交前请确认**：

- 代码通过 `node examples/write-mcstructure.js` 能生成文件
- 代码通过 `node examples/read-mcstructure.js test.mcstructure` 能读回
- 在 Minecraft 里实测过（如果涉及游戏内行为）

---

## License

[CC BY 4.0](./LICENSE) —— 随意商用 / 改写 / 分发，保留出处即可。

---

## 致谢

- [LevelDB 官方文档](https://github.com/google/leveldb/blob/main/doc/table_format.md)
- [Minecraft Wiki - Bedrock Edition level format](https://minecraft.fandom.com/wiki/Bedrock_Edition_level_format)
- [Microsoft Learn - mcstructure schema](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/schemasreference/)
- [wiki.vg - NBT](https://wiki.vg/NBT)

---

<div align="center">

**如果这个项目帮到了你，给个 Star 吧！**

Made with ❤️ for the Minecraft Bedrock modding community

</div>
