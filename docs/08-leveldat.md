# 08 - level.dat 格式与陷阱

> `level.dat` 是 `.mcworld` 的**元数据文件**，告诉游戏"这个世界叫什么、出生点在哪、怎么生成"。
> 格式错误会导致**整个存档打不开**，或者出现"升级世界"提示。

## 1. 文件结构

```
[8 字节头] + [NBT 数据]
```

### 1.1 头部

**小端序**：

- 字节 0-3：`uint32`，版本号，**固定 10**
- 字节 4-7：`uint32`，后续 NBT 数据的字节长度

```javascript
function buildLevelDat(worldName, spawnX, spawnY, spawnZ) {
    // ... 构造 root（见 §3）
    const nbtBytes = bSerializeBE(root);

    const header = new Uint8Array(8);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, 10, true);                // 版本号
    dv.setUint32(4, nbtBytes.length, true);   // NBT 长度

    const result = new Uint8Array(8 + nbtBytes.length);
    result.set(header);
    result.set(nbtBytes, 8);
    return result;
}
```

### 1.2 NBT 数据

标准的基岩版 NBT，根是 Compound，名称空字符串。

## 2. 必需字段

### 2.1 核心字段表

| 字段 | 类型 | 推荐值 | 说明 |
|------|------|--------|------|
| `LevelName` | String | 世界名 | 显示名称 |
| `GameType` | Int | 1 | 0=生存，1=创造，2=冒险，3=旁观 |
| `Difficulty` | Int | 0 | 0=和平，1=简单，2=普通，3=困难 |
| `RandomSeed` | Long | 12345 | 种子 |
| `SpawnX` | Int | 0 | 出生点 X |
| `SpawnY` | Int | **32767** | ⚠️ 必须 32767 |
| `SpawnZ` | Int | 0 | 出生点 Z |
| `Generator` | Int | **2** | 2 = 平坦世界 |
| `FlatWorldLayers` | String | JSON | 见 §4 |
| `StorageVersion` | Int | 10 | |
| `baseGameVersion` | String | `"*"` | |
| `WorldVersion` | Int | 1 | |
| `NetworkVersion` | Int | 2168 | 1.19.10 协议号 |
| `InventoryVersion` | String | `"1.19.10"` | |
| `BiomeOverride` | String | `"minecraft:minecraft:"` | |
| `lastOpenedWithVersion` | **List\<Int\>** | `[1,19,10,3,0]` | ⚠️ 不是 String |
| `MinimumCompatibleClientVersion` | **List\<Int\>** | `[1,19,10,0,0]` | 同上 |

### 2.2 ⚠️ 陷阱一：lastOpenedWithVersion 必须是 List\<Int\>

**❌ 错误写法**：

```javascript
{ name: 'lastOpenedWithVersion', type: 8, value: '1.19.10' }   // String
```

**后果**：游戏提示"**升级世界**"，或者拒绝加载。

**✅ 正确写法**：

```javascript
function intList(values) {
    return { itemType: 3, items: values };   // itemType 3 = Int
}

{ name: 'lastOpenedWithVersion', type: 9, value: intList([1, 19, 10, 3, 0]) }
```

`[1, 19, 10, 3, 0]` 对应版本 `1.19.10.3.0`。

### 2.3 ⚠️ 陷阱二：SpawnY 必须 32767

**❌ 错误写法**：

```javascript
{ name: 'SpawnY', type: 3, value: -60 }   // 或 64
```

**✅ 正确写法**：

```javascript
{ name: 'SpawnY', type: 3, value: 32767 }
```

**为什么**：基岩版用 32767 表示"**出生点由引擎计算**"。写其他值会被引擎忽略，可能导致出生点在世界外。

### 2.4 ⚠️ 陷阱三：Generator 必须是 2（平坦）

**❌ 错误**：

```javascript
{ name: 'Generator', type: 3, value: 1 }   // 无限世界
```

**✅ 正确**：

```javascript
{ name: 'Generator', type: 3, value: 2 }   // 平坦世界
```

**为什么**：Generator = 2 让游戏用 `FlatWorldLayers` 生成地表。如果用 1（无限），游戏会用 Perlin 噪声生成随机地形，你的结构会被埋在地下或漂浮在空中。

## 3. 完整构造代码

```javascript
function buildLevelDat(worldName, spawnX, spawnY, spawnZ) {
    // Step 1: 构造 FlatWorldLayers JSON
    const flatLayersJson = JSON.stringify({
        biome_id: 1,
        block_layers: [
            { block_name: "minecraft:bedrock", count: 1 },
            { block_name: "minecraft:dirt", count: 2 },
            { block_name: "minecraft:grass_block", count: 1 }
        ],
        encoding_version: 6,
        preset_id: "ClassicFlat",
        world_version: "version.post_1_18"
    }) + "\n";   // ★ 末尾加 \n

    function intList(values) {
        return { itemType: 3, items: values };
    }

    // Step 2: 构造 root
    const root = [
        // ---- 世界基础信息 ----
        { name: 'LevelName', type: 8, value: worldName || 'Structure World' },
        { name: 'GameType', type: 3, value: 1 },
        { name: 'Difficulty', type: 3, value: 0 },
        { name: 'RandomSeed', type: 4, value: 12345 },

        // ---- 出生点 ----
        { name: 'SpawnX', type: 3, value: spawnX || 0 },
        { name: 'SpawnY', type: 3, value: 32767 },   // ★ 必须 32767
        { name: 'SpawnZ', type: 3, value: spawnZ || 0 },

        // ---- 世界生成 ----
        { name: 'Generator', type: 3, value: 2 },     // ★ 2 = 平坦
        { name: 'FlatWorldLayers', type: 8, value: flatLayersJson },

        // ---- 版本信息 ----
        { name: 'StorageVersion', type: 3, value: 10 },
        { name: 'baseGameVersion', type: 8, value: '*' },
        { name: 'WorldVersion', type: 3, value: 1 },
        { name: 'NetworkVersion', type: 3, value: 2168 },
        { name: 'InventoryVersion', type: 8, value: '1.19.10' },

        // ---- 生物群系 ----
        { name: 'BiomeOverride', type: 8, value: 'minecraft:minecraft:' },

        // ---- 版本兼容（★ 都是 List<Int>） ----
        { name: 'lastOpenedWithVersion', type: 9, value: intList([1, 19, 10, 3, 0]) },
        { name: 'MinimumCompatibleClientVersion', type: 9, value: intList([1, 19, 10, 0, 0]) },

        // ---- 常用开关 ----
        { name: 'showcoordinates', type: 1, value: 1 },
        { name: 'commandsEnabled', type: 1, value: 1 },
        { name: 'hasBeenLoadedInCreative', type: 1, value: 1 }
    ];

    // Step 3: NBT 编码
    const nbtBytes = bSerializeBE(root);

    // Step 4: 加 8 字节头
    const header = new Uint8Array(8);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, 10, true);
    dv.setUint32(4, nbtBytes.length, true);

    // Step 5: 拼接
    const result = new Uint8Array(8 + nbtBytes.length);
    result.set(header);
    result.set(nbtBytes, 8);
    return result;
}
```

## 4. FlatWorldLayers JSON

### 4.1 格式

```json
{
  "biome_id": 1,
  "block_layers": [
    { "block_name": "minecraft:bedrock", "count": 1 },
    { "block_name": "minecraft:dirt", "count": 2 },
    { "block_name": "minecraft:grass_block", "count": 1 }
  ],
  "encoding_version": 6,
  "preset_id": "ClassicFlat",
  "world_version": "version.post_1_18"
}
```

### 4.2 字段详解

| 字段 | 说明 |
|------|------|
| `biome_id` | 生物群系 ID（1 = 平原） |
| `block_layers` | 层数组，从 Y=-64 开始往上堆 |
| `block_layers[].block_name` | 方块名（含 `minecraft:` 前缀） |
| `block_layers[].count` | 连续堆叠数 |
| `encoding_version` | 6（1.18+ 用） |
| `preset_id` | `"ClassicFlat"` |
| `world_version` | `"version.post_1_18"` |

### 4.3 层的堆叠

**从世界最低 Y（-64）开始**：

```
Y = -64      → bedrock (count=1)
Y = -63~-62  → dirt (count=2)
Y = -61      → grass_block (count=1)
Y = -60+     → 空气
```

**⚠️ 陷阱**：`count` 是**数量**，不是"结束 Y"。

### 4.4 完整示例

```javascript
const flatLayersJson = JSON.stringify({
    biome_id: 1,
    block_layers: [
        { block_name: "minecraft:bedrock", count: 1 },
        { block_name: "minecraft:dirt", count: 2 },
        { block_name: "minecraft:grass_block", count: 1 }
    ],
    encoding_version: 6,
    preset_id: "ClassicFlat",
    world_version: "version.post_1_18"
}) + "\n";
```

**末尾加 `\n`**：某些解析器要求 JSON 后跟换行符。

## 5. 可选字段

### 5.1 常用开关

| 字段 | 类型 | 值 | 说明 |
|------|------|-----|------|
| `showcoordinates` | Byte | 1 | 显示坐标 |
| `commandsEnabled` | Byte | 1 | 允许作弊 |
| `commandblockoutput` | Byte | 0 | 命令方块输出广播 |
| `commandblocksenabled` | Byte | 1 | 命令方块可用 |
| `sendcommandfeedback` | Byte | 1 | 命令反馈 |
| `dodaylightcycle` | Byte | 0 | 关闭昼夜循环 |
| `domobspawning` | Byte | 0 | 关闭生物生成 |
| `spawnMobs` | Byte | 0 | 同上（冗余字段） |
| `Time` | Long | 6000 | 世界时间（0=日出，6000=正午） |
| `currentTick` | Long | 6000 | 同步 tick |
| `keepinventory` | Byte | 1 | 保留物品 |
| `showtags` | Byte | 1 | 显示标签 |
| `showbordereffect` | Byte | 1 | 显示边界效果 |

### 5.2 完整可选字段

```javascript
// 加在 root 里
{ name: 'showcoordinates', type: 1, value: 1 },
{ name: 'commandblockoutput', type: 1, value: 0 },
{ name: 'commandblocksenabled', type: 1, value: 1 },
{ name: 'sendcommandfeedback', type: 1, value: 1 },
{ name: 'dodaylightcycle', type: 1, value: 0 },
{ name: 'domobspawning', type: 1, value: 0 },
{ name: 'keepinventory', type: 1, value: 1 },
{ name: 'Time', type: 4, value: 6000 },
{ name: 'currentTick', type: 4, value: 6000 },
{ name: 'showtags', type: 1, value: 1 }
```

## 6. 与 levelname.txt 的关系

**两者都存在时，`levelname.txt` 覆盖 `level.dat` 的 `LevelName`**。

- 如果只想改显示名：改 `levelname.txt` 最简单
- 如果想改内部名：改 `level.dat`

**建议**：两者保持**一致**。

```javascript
zip.addFile('level.dat', buildLevelDat(worldName, px, py, pz));
zip.addFile('levelname.txt', new TextEncoder().encode(worldName));
```

## 7. 版本兼容

| MC 版本 | NetworkVersion | InventoryVersion |
|---------|---------------|------------------|
| 1.19.0 | 2145 | `"1.19.0"` |
| 1.19.10 | 2168 | `"1.19.10"` |
| 1.19.20 | 2180 | `"1.19.20"` |
| 1.20.0 | 2212 | `"1.20.0"` |
| 1.20.10 | 2222 | `"1.20.10"` |
| 1.21.0 | 2310 | `"1.21.0"` |

**建议**：用 `2168`（1.19.10），兼容性最广。

**为什么不用最新**：新版本字段会变（例如 1.20+ 告示牌 `isWaxed`），旧游戏打不开。用 1.19.10 能让 1.19+ 都能打开。

## 8. 陷阱清单

### 8.1 lastOpenedWithVersion 类型

```
❌ String
❌ List<String>
✅ List<Int>   →  [1, 19, 10, 3, 0]
```

### 8.2 SpawnY

```
❌ -60 / 64 / 0
✅ 32767
```

### 8.3 Generator

```
❌ 0 / 1  （旧版 / 无限）
✅ 2      （平坦）
```

### 8.4 FlatWorldLayers 是否加 \n

```
⚠️ 加 \n 更保险
✅ JSON + "\n"
```

### 8.5 NetworkVersion 不匹配

```
❌ 用最新版本号（游戏可能拒绝旧存档）
✅ 用 2168（1.19.10），兼容性最广
```

### 8.6 头部的版本号不是 10

```
❌ 0 / 1 / 8
✅ 10
```

### 8.7 NBT 长度字段错误

```
❌ 写成整个文件长度
✅ 只算 NBT 数据长度（不含头部）
```

## 9. 调试

### 9.1 检查 level.dat 是否能解析

```javascript
function checkLevelDat(buffer) {
    if (buffer.length < 8) {
        console.error('文件太小');
        return null;
    }
    const dv = new DataView(buffer.buffer, buffer.byteOffset);
    const version = dv.getUint32(0, true);
    const nbtLength = dv.getUint32(4, true);

    console.log('头部版本:', version);
    console.log('NBT 长度:', nbtLength);
    console.log('文件总长:', buffer.length);
    console.log('预期总长:', 8 + nbtLength);

    if (version !== 10) console.warn('⚠️ 版本不是 10');
    if (8 + nbtLength !== buffer.length) console.warn('⚠️ 长度不匹配');

    // 解析 NBT
    try {
        const nbt = parseNbt(buffer, 8);
        console.log('NBT 解析成功，字段:', Object.keys(nbt.value).join(','));
        return nbt.value;
    } catch (e) {
        console.error('NBT 解析失败:', e.message);
        return null;
    }
}
```

### 9.2 检查关键字段

```javascript
function validateLevelDat(root) {
    const errors = [];

    // lastOpenedWithVersion 必须是 List<Int>
    if (root.lastOpenedWithVersion) {
        if (root.lastOpenedWithVersion.type !== 'List') {
            errors.push('lastOpenedWithVersion 不是 List');
        } else if (root.lastOpenedWithVersion.value.itemType !== 'Int') {
            errors.push('lastOpenedWithVersion 元素类型不是 Int');
        }
    }

    // SpawnY 必须是 32767
    if (root.SpawnY && root.SpawnY.value !== 32767) {
        errors.push('SpawnY 不是 32767');
    }

    // Generator 必须是 2
    if (root.Generator && root.Generator.value !== 2) {
        errors.push('Generator 不是 2');
    }

    return errors;
}
```

## 10. 自检清单

- [ ] 头部版本号是 10
- [ ] 头部 NBT 长度 = 实际 NBT 数据长度
- [ ] `lastOpenedWithVersion` 是 List\<Int\>
- [ ] `MinimumCompatibleClientVersion` 是 List\<Int\>
- [ ] `SpawnY` = 32767
- [ ] `Generator` = 2
- [ ] `FlatWorldLayers` 是合法 JSON，末尾加 `\n`
- [ ] `NetworkVersion` 用 2168（1.19.10）
- [ ] `InventoryVersion` 用 `"1.19.10"`
- [ ] `BiomeOverride` 是 `"minecraft:minecraft:"`
- [ ] 有 `LevelName` 字段
- [ ] `levelname.txt` 与 `LevelName` 一致

## 11. 参考

- level.dat 字段：https://minecraft.fandom.com/wiki/Level.dat
- 平坦世界配置：https://minecraft.fandom.com/wiki/Superflat
