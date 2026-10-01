# 07 - BlockEntity（方块实体）

> BlockEntity (BE) 是"带数据的方块"：命令方块存指令、告示牌存文字、箱子存物品。
> BE 数据在 mcworld 和 mcstructure 里存储方式完全不同，是最容易出错的部分。

## 1. 概念

### 1.1 什么是 BlockEntity

普通方块（石头、木头）只有"类型 + 状态"。但有些方块需要**额外数据**：

| 方块 | 额外数据 |
|------|---------|
| 命令方块 | 指令、执行模式、条件 |
| 告示牌 | 正面/背面文字、颜色 |
| 箱子 | 物品列表 |
| 熔炉 | 输入、燃料、输出、进度 |
| 刷怪笼 | 生物类型、生成参数 |
| 唱片机 | 唱片 ID |
| 传送门 | 目标位置 |

**关键**：BE 数据**不存进 SubChunk**，而是作为**独立数据**存在 chunk 的 `0x31` 键里。

### 1.2 为什么分开

- BE 数据**变长**，无法用调色板表示
- BE 数量少（一个 chunk 可能 0~10 个），不占空间
- BE 数据**独立于方块**（方块被破坏时 BE 也删）

## 2. mcworld 侧的存储（`0x31` 键）

### 2.1 键格式

```
[ChunkX int32 LE 4B][ChunkZ int32 LE 4B][0x31]
```

长度 9 字节，**没有后缀**。

### 2.2 值格式

**一串连续的 NBT Compound**（不是 List！直接拼接）：

```
[TAG_Compound][TAG_Compound][TAG_Compound]...
 每个 Compound 都有 id / x / y / z / 其他字段
```

**没有分隔符**，靠 `bytesRead` 遍历。

### 2.3 解析代码

```javascript
function parseBlockEntities(buf) {
    const result = [];
    let p = 0;
    while (p < buf.length) {
        try {
            const nbt = parseNbt(buf, p);
            if (nbt.bytesRead <= 0) break;   // 安全阀
            p += nbt.bytesRead;
            result.push(nbt.value);
        } catch (e) { break; }
    }
    return result;
}
```

### 2.4 序列化代码

```javascript
function serializeBlockEntities(beList) {
    // beList 是 [{ id, x, y, z, ... }, ...]
    // 或者 [{ name, type, value }, ...] 形式的 entries 数组

    const totalLen = beList.reduce((sum, be) => sum + be.length, 0);
    const combined = new Uint8Array(totalLen);
    let off = 0;
    for (const be of beList) {
        combined.set(be, off);
        off += be.length;
    }
    return combined;
}
```

**实际使用**：

```javascript
const beList = [];   // 每个元素是 bSerializeBE(entries) 结果
for (const be of blockEntityList) {
    beList.push(bSerializeBE(parsedToWriterEntries(be)));
}
const combined = serializeBlockEntities(beList);
entries.push({
    key: makeChunkKey(cx, cz, 0x31),
    value: combined
});
```

### 2.5 ⚠️ 32KB 单条记录限制

**基岩版 LevelDB 不支持跨块分片拼接**。

如果一个 chunk 的 `0x31` 值超过 **32 KB**，游戏会**丢弃整条记录**，导致：

- 该 chunk **所有** 方块实体丢失
- 该 chunk 的命令方块变石头（指令丢失）
- 告示牌变空白

**计算**：假设平均每个命令方块 BE 约 200~500 字节（含 `LastOutput`），一个 chunk 有 100 个命令方块 → 20~50 KB，**已经超了**。

**缓解策略**：

1. **过滤 `LastOutput` / `LastOutputParams`**（最有效）
   - 这俩字段每次执行都写入，可以从几 KB 到几十 KB
   - 游戏**不依赖**它们运行，只用于界面显示"上次输出"
2. **分区块导出**：把大结构拆成多个 mcstructure
3. **减少单 chunk 命令方块数量**：重新设计结构布局

## 3. mcstructure 侧的存储（`block_position_data`）

### 3.1 结构

```
TAG_Compound "block_position_data"
  ├── "0,0,0"     (TAG_Compound)
  │     └── block_entity_data (TAG_Compound)
  ├── "3,5,-2"    (TAG_Compound)
  │     └── block_entity_data (TAG_Compound)
  ├── "10,2,7"
  │     └── block_entity_data
  ...
```

### 3.2 三条黄金规则

1. **键必须是 `"sx,sy,sz"` 字符串**（相对坐标，逗号分隔，无空格）
2. **值必须再包一层 `block_entity_data`**
3. **BE 内的 `x/y/z` 也必须是结构相对坐标**（与键一致）

### 3.3 ✅ 正确写法

```javascript
const bpEntries = Object.keys(blockPositionData).map(function(key) {
    return {
        name: key,                     // "3,5,-2"
        type: 10,
        value: [
            { name: 'block_entity_data', type: 10, value: blockPositionData[key] }
        ]
    };
});
```

`blockPositionData` 的形态：

```javascript
blockPositionData = {
    "3,5,-2": [  // entries 数组，形如 [{ name, type, value }, ...]
        { name: 'id', type: 8, value: 'CommandBlock' },
        { name: 'Command', type: 8, value: 'say hello' },
        { name: 'x', type: 3, value: 3 },
        { name: 'y', type: 3, value: 5 },
        { name: 'z', type: 3, value: -2 },
        ...
    ],
    "10,2,7": [ ... ]
}
```

### 3.4 ❌ 错误写法

**错误 1**：用扁平整数索引当键

```javascript
// ❌ 游戏会忽略所有 BE
const bpEntries = [];
for (let i = 0; i < beList.length; i++) {
    bpEntries.push({
        name: String(i),           // "0", "1", "2"...
        type: 10,
        value: [{ name: 'block_entity_data', type: 10, value: beList[i] }]
    });
}
```

**错误 2**：忘了包 `block_entity_data`

```javascript
// ❌ 游戏找不到 BE
{
    name: "3,5,-2",
    type: 10,
    value: [  // 直接是 BE 字段，没包 block_entity_data
        { name: 'id', type: 8, value: 'CommandBlock' },
        ...
    ]
}
```

**错误 3**：键用世界坐标

```javascript
// ❌ 游戏按相对坐标找，找不到
{
    name: "100,64,200",    // 世界坐标，不是结构相对坐标
    ...
}
```

### 3.5 为什么游戏只认 `"sx,sy,sz"` 键

**游戏的读取逻辑**（逆向推断）：

```
1. 遍历 block_position_data 的每个条目
2. 用 key 正则解析 "(-?\d+),(-?\d+),(-?\d+)" 得到 (sx, sy, sz)
3. 用 (sx, sy, sz) 从 block_indices 里找到对应的方块
4. 如果方块是 air，跳过（不会挂 BE 到空气）
5. 把 block_entity_data 内容挂到该方块
```

**如果键不匹配这个正则**：游戏直接跳过。**不会报错，静默忽略**。

## 4. BE 数据完整性

### 4.1 命令方块完整字段

```
BlockEntityVersion  Int      (可选)
Command             String   ★ 命令内容
CustomName          String   自定义名称（显示在 GUI 上）
ExecuteOnFirstTick  Byte
LPCommandMode       Int      0=脉冲，1=循环，2=连锁
LPCondionalMode     Byte     条件模式
LPRedstoneMode      Byte     红石模式
LastExecution       Long
LastOutput          String   (可过滤) 上次输出
LastOutputParams    List     (可过滤)
SuccessCount        Int
TickDelay           Int
TrackOutput         Byte
Version             Int
auto                Byte     自动执行
conditionMet        Byte
id                  String   ★ "CommandBlock"
powered             Byte
x / y / z           Int      ★ 坐标
```

### 4.2 告示牌字段

**1.19.80+ 双面结构**：

```
id                  String   "Sign"
FrontText           Compound ★ 正面
  Text              String
  HideGlowOutline   Byte
  IgnoreLighting    Byte
  PersistFormatting Byte
  SignTextColor     Int      颜色 (ARGB)
  TextOwner         String
BackText            Compound ★ 背面
  ...同上
isWaxed             Byte     (1.20+ 涂蜡)
x / y / z           Int
```

**⚠️ 1.19.80 之前是单字段**：

```
Text                String   正面文字
```

**迁移**：读取旧格式时把 `Text` 搬到 `FrontText.Text`。

### 4.3 箱子字段

```
id                  String   "Chest"
Items               List     物品列表
Findable            Byte
CustomName          String
x / y / z           Int
```

**Items 的每个元素**：

```
Name                String   物品 ID
Count               Byte     数量
Damage              Short    耐久/数据值
Slot                Byte     槽位
tag                 Compound 物品 NBT（附魔、自定义名称等）
```

### 4.4 熔炉字段

```
id                  String   "Furnace"
BurnTime            Short    剩余燃烧时间
CookTime            Short    当前烧炼进度
CookTimeTotal       Short    总烧炼时间
BurnDuration        Short    燃料可燃烧时间
Items               List     输入 / 燃料 / 输出
x / y / z           Int
```

## 5. 完整流程

### 5.1 mcworld → mcstructure 的 BE 收集

```javascript
const blockPositionData = {};
let beTotal = 0, beKept = 0, beFail = 0;

for (const beBuf of beBufList) {
    let p = 0;
    while (p < beBuf.length) {
        try {
            const nbt = parseNbt(beBuf, p);
            if (nbt.bytesRead <= 0) break;
            p += nbt.bytesRead;
            beTotal++;

            const be = nbt.value;
            if (!be || !be.x || !be.y || !be.z) { beFail++; continue; }

            const bx = Number(be.x.value);
            const by = Number(be.y.value);
            const bz = Number(be.z.value);
            if (!isFinite(bx) || !isFinite(by) || !isFinite(bz)) { beFail++; continue; }
            if (bx < x1 || bx > x2 || by < y1 || by > y2 || bz < z1 || bz > z2) {
                beFail++;
                continue;
            }

            const sx = bx - x1, sy = by - y1, sz = bz - z1;

            const entryList = parsedToWriterEntries(be);
            for (const ent of entryList) {
                if (ent.name === 'x' && ent.type === 3) ent.value = sx;
                else if (ent.name === 'y' && ent.type === 3) ent.value = sy;
                else if (ent.name === 'z' && ent.type === 3) ent.value = sz;
            }

            // ★ 键必须是 "sx,sy,sz"
            blockPositionData[sx + ',' + sy + ',' + sz] = entryList;
            beKept++;
        } catch (e) { beFail++; break; }
    }
}
```

### 5.2 mcstructure → mcworld 的 BE 处理

```javascript
const defaultCompound = structure.palette.value.default.value;
if (defaultCompound.block_position_data && defaultCompound.block_position_data.value) {
    const bpd = defaultCompound.block_position_data.value;
    const beKeys = Object.keys(bpd);

    for (const key of beKeys) {
        const beData = bpd[key].value;
        if (!beData.block_entity_data || !beData.block_entity_data.value) continue;
        const be = beData.block_entity_data.value;

        // 从键解析相对坐标
        let sx = null, sy = null, sz = null;
        const cm = key.match(/^(-?\d+),\s*(-?\d+),\s*(-?\d+)$/);
        if (cm) {
            sx = parseInt(cm[1]);
            sy = parseInt(cm[2]);
            sz = parseInt(cm[3]);
        } else if (be.x && be.y && be.z) {
            sx = Number(be.x.value);
            sy = Number(be.y.value);
            sz = Number(be.z.value);
        }
        if (sx === null) continue;

        // 补全 id
        if (!be.id) {
            const structIdx = (sx * sizeY + sy) * sizeZ + sz;
            const palIdx = blockIndices0[structIdx];
            if (palIdx >= 0) {
                const bn = palette[palIdx].name.value;
                const inferred = BLOCK_TO_BE_ID[bn];
                if (inferred) be.id = { type: 'String', value: inferred };
            }
        }

        // 转回世界坐标
        const worldX = px + sx, worldY = py + sy, worldZ = pz + sz;

        const beEntries = parsedToWriterEntries(be);
        for (const e of beEntries) {
            if (e.name === 'x' && e.type === 3) e.value = worldX;
            if (e.name === 'y' && e.type === 3) e.value = worldY;
            if (e.name === 'z' && e.type === 3) e.value = worldZ;
        }

        const cx = Math.floor(worldX / 16);
        const cz = Math.floor(worldZ / 16);
        const group = getOrCreate(cx, cz);
        group.blockEntities.push(bSerializeBE(beEntries));
    }
}
```

## 6. BE id 推断表

**问题**：mcstructure 里 BE 的 `block_entity_data` 有时**没有 `id` 字段**（常见于手工生成的结构）。

**解决**：根据方块名反推 BE id。

```javascript
const BLOCK_TO_BE_ID = {
    // 命令方块
    'minecraft:command_block': 'CommandBlock',
    'minecraft:chain_command_block': 'CommandBlock',
    'minecraft:repeating_command_block': 'CommandBlock',

    // 告示牌
    'minecraft:standing_sign': 'Sign',
    'minecraft:wall_sign': 'Sign',
    'minecraft:hanging_sign': 'Sign',
    'minecraft:wall_hanging_sign': 'Sign',

    // 容器
    'minecraft:chest': 'Chest',
    'minecraft:trapped_chest': 'Chest',
    'minecraft:barrel': 'Barrel',
    'minecraft:hopper': 'Hopper',
    'minecraft:dispenser': 'Dispenser',
    'minecraft:dropper': 'Dropper',
    'minecraft:shulker_box': 'ShulkerBox',

    // 熔炉
    'minecraft:furnace': 'Furnace',
    'minecraft:lit_furnace': 'Furnace',
    'minecraft:blast_furnace': 'BlastFurnace',
    'minecraft:lit_blast_furnace': 'BlastFurnace',
    'minecraft:smoker': 'Smoker',
    'minecraft:lit_smoker': 'Smoker',

    // 酿造
    'minecraft:brewing_stand': 'BrewingStand',

    // 特殊方块
    'minecraft:enchanting_table': 'EnchantTable',
    'minecraft:beacon': 'Beacon',
    'minecraft:jukebox': 'Jukebox',
    'minecraft:mob_spawner': 'MobSpawner',
    'minecraft:noteblock': 'Music',
    'minecraft:end_portal': 'EndPortal',
    'minecraft:end_gateway': 'EndGateway',
    'minecraft:skull': 'Skull',
    'minecraft:flower_pot': 'FlowerPot',
    'minecraft:campfire': 'Campfire',
    'minecraft:soul_campfire': 'Campfire',
    'minecraft:lectern': 'Lectern',
    'minecraft:bed': 'Bed',
    'minecraft:conduit': 'Conduit',
    'minecraft:bell': 'Bell',
    'minecraft:structure_block': 'StructureBlock',
    'minecraft:jigsaw': 'JigsawBlock',
    'minecraft:pistonarmcollision': 'PistonArm',
    'minecraft:sticky_pistonarmcollision': 'PistonArm',
    'minecraft:cauldron': 'Cauldron',
    'minecraft:lava_cauldron': 'Cauldron',
    'minecraft:daylight_detector': 'DaylightDetector',
    'minecraft:daylight_detector_inverted': 'DaylightDetector'
};
```

**使用**：

```javascript
if (!be.id) {
    const structIdx = (sx * sizeY + sy) * sizeZ + sz;
    const palIdx = blockIndices0[structIdx];
    if (palIdx >= 0) {
        const bn = palette[palIdx].name.value;
        const inferred = BLOCK_TO_BE_ID[bn];
        if (inferred) be.id = { type: 'String', value: inferred };
    }
}
```

## 7. 陷阱清单

### 7.1 block_position_data 键格式

```
❌ "0" / "1" / "2"        （扁平索引）
❌ "3, 5, -2"              （带空格）
❌ "100,64,200"            （世界坐标）
❌ "{x:3, y:5, z:-2}"     （JSON 格式）
✅ "3,5,-2"                （纯数字，逗号分隔，无空格）
```

### 7.2 缺 block_entity_data 包装

```javascript
// ❌ 直接放 BE 字段
{ name: "3,5,-2", type: 10, value: [{ name: 'id', type: 8, value: 'CommandBlock' }] }

// ✅ 包一层
{ name: "3,5,-2", type: 10, value: [
    { name: 'block_entity_data', type: 10, value: [
        { name: 'id', type: 8, value: 'CommandBlock' }
    ]}
]}
```

### 7.3 x/y/z 坐标系统一

**mcstructure 侧**：BE 内的 x/y/z 用**结构相对坐标**（与 block_position_data 键一致）。

**mcworld 侧**：BE 内的 x/y/z 用**世界坐标**（与 chunk key 一致）。

**转换时务必转换**：

```javascript
// mcworld → mcstructure
ent.value = ent.value - x1;   // 或 y1 / z1

// mcstructure → mcworld
ent.value = ent.value + px;   // 或 py / pz
```

### 7.4 BE id 大小写

```
✅ "CommandBlock"     （驼峰）
❌ "commandblock"     （全小写）
❌ "COMMAND_BLOCK"    （下划线）
```

**参考**：mcworld 的 `0x31` 里 id 是驼峰；mcstructure 里 id 也是驼峰。

### 7.5 32KB 单条记录

见 §2.5。**这是实际最常遇到的坑**。

### 7.6 LastOutput 过滤

**过滤前**：命令方块 BE 平均 2~10 KB，100 个就超 32KB。

**过滤后**：命令方块 BE 平均 300~800 字节，100 个约 30~80 KB（可能仍超）。

**结论**：过滤 `LastOutput` 是必须的，但仍要控制单 chunk BE 数量。

## 8. 验证方法

### 8.1 调试日志

```javascript
if (beDbg < 3) {
    beDbg++;
    log('[BE调试] id=' + (be.id ? be.id.value : '(无)') +
        ' 坐标=(' + bx + ',' + by + ',' + bz + ')' +
        ' 字段=' + Object.keys(be).join(','));
}
```

**期望输出**：

```
[BE调试] id=CommandBlock 坐标=(0,-60,0) 字段=BlockEntityVersion,Command,CustomName,...,x,y,z
[BE调试] id=Sign 坐标=(5,-60,3) 字段=id,FrontText,BackText,x,y,z
```

**看到 `Command` 字段** → 数据完整。

### 8.2 NBT 查看器

用 NBT Studio 打开 `.mcstructure`：

```
palette.default.block_position_data:
  "3,5,-2":
    block_entity_data:
      id: "CommandBlock"
      Command: "say hello"
      x: 3
      y: 5
      z: -2
```

**如果看到 `"0"`, `"1"`, `"2"` 这样的键** → 就是 §7.1 的错误，游戏会忽略。

### 8.3 游戏内测试

1. 加载 `.mcstructure` 到结构方块
2. 点开命令方块 → 应显示原指令
3. 打开告示牌 → 应显示正反面文字
4. 打开箱子 → 应保留物品

## 9. 自检清单

- [ ] block_position_data 键是 `"sx,sy,sz"` 字符串（无空格）
- [ ] 每个值都包了 `block_entity_data`
- [ ] BE 内 x/y/z 用结构相对坐标
- [ ] mcworld 侧 BE 内 x/y/z 用世界坐标
- [ ] BE id 是驼峰（CommandBlock / Sign / Chest）
- [ ] 缺失 id 时从方块名推断
- [ ] 单条 `0x31` 记录 < 32 KB
- [ ] 过滤了 `LastOutput` / `LastOutputParams`（除非明确要保留）
- [ ] BE 坐标在结构范围内

## 10. 参考

- BlockEntity 列表：https://minecraft.fandom.com/wiki/Block_entity
- 命令方块字段：https://minecraft.fandom.com/wiki/Command_Block#Block_data
