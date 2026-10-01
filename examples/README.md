# minecraft-bedrock-codec

Minecraft 基岩版 `.mcworld` / `.mcstructure` 双向转换 skill，供 AI Agent 使用。

## 功能

- 解析 `.mcworld`（ZIP + LevelDB + SSTable + SubChunk + NBT）
- 解析 `.mcstructure`（纯 NBT）
- 双向转换（保留方块、方块实体、层 1 贴附方块）
- 零外部 NBT / LevelDB 依赖（只用 `jszip` + `pako`）

## 适用版本

Minecraft 基岩版 **1.19.10 ~ 1.21**。

## 目录

| 路径 | 说明 |
|------|------|
| [`SKILL.md`](./SKILL.md) | 总纲 + 导航，**从这里开始** |
| [`docs/`](./docs/) | 详细技术文档（13 个文件） |
| [`examples/`](./examples/) | 可运行示例（Node.js） |

## 快速开始

```bash
# 安装依赖
cd examples
npm install jszip pako

# 读取 .mcworld
node read-mcworld.js path/to/world.mcworld

# 生成 .mcworld
node write-mcworld.js test.mcworld

# 读取 .mcstructure
node read-mcstructure.js path/to/structure.mcstructure

# 生成 .mcstructure
node write-mcstructure.js test.mcstructure
```

## 核心认知

```
.mcworld      = ZIP 包装的 LevelDB 数据库
.mcstructure  = 纯 NBT 文件（稠密 3D 数组）

转换本质：
  mcworld → mcstructure：多个 chunk 的 subChunk 合并成 3D 数组
  mcstructure → mcworld：3D 数组拆成多个 chunk 的 subChunk
```

**⚠️ 最容易踩的坑**：mcstructure 的 `block_position_data` 键必须是 `"sx,sy,sz"` 字符串（相对坐标），不是扁平索引。写错会导致**所有**方块实体数据静默丢失（命令方块变空、告示牌变空白、箱子物品消失）。

详见 [`docs/07-blockentity.md`](./docs/07-blockentity.md) §3

## 浏览器 Demo

不想装 Node.js？直接打开 `docs/demo.html`：

```bash
# 在项目根目录启动静态服务器
python3 -m http.server 8000
# 浏览器打开
open http://localhost:8000/docs/demo.html
```

Demo 页面提供 4 个操作：

1. **读取 .mcworld**：选择文件 → 输出方块统计 + 所有 BE
2. **生成 .mcworld**：一键生成测试世界并下载
3. **读取 .mcstructure**：选择文件 → 输出结构信息 + BE
4. **生成 .mcstructure**：一键生成测试结构并下载

> ⚠️ **必须用 HTTP 服务器**打开，不能用 `file://`（浏览器会拦截跨目录的 `<script src>`）。
> `docs/demo.html` 通过 `<script src="../examples/utils.js">` 加载工具库，所以 `examples/utils.js` **必须是 UMD 格式**（顶部和底部有 `(function (root, factory) {...})` 包裹）。

## License

MII
