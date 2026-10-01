# 09 - mcstructure 文件格式

> `.mcstructure` 是**纯 NBT 文件**，用于存储"一个矩形区域的方块 + 方块实体"。
> 它是 `.mcworld` 的**精简子集**：只保留方块和 BE，不含光照、生物群系、实体。

## 1. 完整结构树

```
TAG_Compound (根，名称="")
├── TAG_Int      "format_version" = 1
├── TAG_List     "size" [3 个 TAG_Int]
├── TAG_Compound "structure"
│   ├── TAG_List "block_indices"
│   │   ├── TAG_List (itemType=3)  ← layer 0
│   │   └── TAG_List (itemType=3)  ← layer 1
│   ├── TAG_List "entities" (itemType=10, 一般空)
│   └── TAG_Compound "palette"
│       └── TAG_Compound "default"
│           ├── TAG_List "block_palette" (itemType=10)
│           └── TAG_Compound "block_position_data"
└── TAG_List     "structure_world_origin" [3 个 TAG_Int]
```

## 2. 顶层字段

### 2.1 format_version

```
TAG_Int "format_version" = 1
```

固定 1。

### 2.2 size

```
TAG_List "size"
  itemType = 3 (Int)
  items = [sizeX, sizeY, sizeZ]
```

三个 Int，分别表示结构在 X / Y / Z 方向的长度。

**⚠️ 注意**：Y 在第二位（X→Y→Z），不是 X→Z→Y。

### 2.3 structure_world_origin

```
TAG_List "structure_world_origin"
  itemType = 3 (Int)
  items = [originX, originY, originZ]
```

结构在世界里的**原始原点**（相对坐标 0,0,0 对应的世界坐标）。

**用途**：这是"从哪个位置导出的"。

**导出 mcworld 时可以忽略**（用用户指定的位置）。

## 3. block_indices（**核心**）

### 3.1 结构

```
TAG_List "block_indices"
  itemType = 9 (List)
  items = [
    { TAG_List (itemType=3)  ← layer 0 },
    { TAG_List (itemType=3)  ← layer 1 }
  ]
```

**两层**，每层是一个**一维 Int32 数组**。

### 3.2 索引顺序（**X→Y→Z**）

```
structIdx = (sx * sizeY + sy) * sizeZ + sz
```

- X 变化最慢
- Z 变化最快
- Y 居中

**反向推导**：

```javascript
const sx = Math.floor(structIdx / (sizeY * sizeZ));
const rem = structIdx % (sizeY * sizeZ);
const sy = Math.floor(rem / sizeZ);
const sz = rem % sizeZ;
```

### 3.3 与 mcworld 的差异（**最重要**）

| 位置 | 索引公式 |
|------|---------|
| mcworld（子区块内） | `lx * 256 + lz * 16 + ly`（XZY） |
| mcstructure | `(sx * sizeY + sy) * sizeZ + sz`（XYZ） |

**搞混会导致方块错位**：

- XZY 当作 XYZ → 方块"上下翻转"
- 反之 → 方块"左右翻转"

**验证**：放一个楼梯，导来导去看方向是否一致。

### 3.4 数组长度

```
每层长度 = sizeX * sizeY * sizeZ
```

**例如**：32 × 16 × 16 = 8192 个 Int32（每个 4 字节） → **32 KB / 层**。

**两层**：**64 KB**。

### 3.5 特殊值

- **-1**：空气（或 palette 未定义）
- **0**：`palette[0]` 对应的方块
- **N**：`palette[N]` 对应的方块

**惯例**：`palette[0]` 通常是 `minecraft:air`，但**不强制**。

**空层**：如果 layer 1 全是 -1，表示"没有贴附方块"。

### 3.6 ⚠️ 内存陷阱

mcstructure 用**稠密数组**存储，即使实际方块很少，也要为整个范围分配内存：

- 100 万方块 → 8 MB（两层）
- 1000 万方块 → 80 MB
- 1 亿方块 → 800 MB（**浏览器会崩**）

**建议阈值**：**1000 万方块**（约 80 MB）。

**超阈值时**：警告用户，提供"继续/取消"。

## 4. entities

```
TAG_List "entities"
  itemType = 10 (Compound)
  items = []
```

**通常是空数组**。

**用途**：存储结构里的实体（掉落物、生物、盔甲架等）。

**每个实体是一个 NBT Compound**，含 `identifier`（实体类型）、`Pos`（坐标）、`Rotation`（朝向）等。

**我们生成 mcstructure 时**：**留空**。

## 5. palette

### 5.1 结构

```
TAG_Compound "palette"
  └── TAG_Compound "default"
      ├── TAG_List "block_palette" (itemType=10)
      └── TAG_Compound "block_position_data"
```

**为什么有"default"层**：允许一个结构有多个调色板（例如不同维度）。**mcworld 只用 default**。

### 5.2 block_palette

**每个条目的 NBT 结构**：

```
TAG_Compound
  TAG_String "name" = "minecraft:xxx"
  TAG_Compound "states"
    TAG_Int "某状态" = 值
  TAG_Int "version" = 18168865
```

**字段详解**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | String | 方块 ID，含 `minecraft:` 前缀 |
| `states` | Compound | 方块状态（方向、是否开启等） |
| `version` | Int | 方块定义版本，**18168865** 是 1.19.10 |

**states 里的每个字段**：

```
TAG_Int "状态名" = 值
```

**状态值类型**可能是 Byte / Int / String，取决于方块。

### 5.3 构造代码

```javascript
function makeBlockPaletteEntry(name, states) {
    const stateEntries = Object.keys(states || {}).map(function(k) {
        const tag = states[k];
        return { name: k, type: NBT_TYPE_IDS[tag.type] || 3, value: tag.value };
    });
    return [
        { name: 'name', type: 8, value: name },
        { name: 'states', type: 10, value: stateEntries },
        { name: 'version', type: 3, value: 18168865 }
    ];
}
```

**使用**：

```javascript
const paletteEntries = palette.map(function(p) {
    const stateEntries = Object.keys(p.states).map(function(k) {
        const tag = p.states[k];
        return { name: k, type: NBT_TYPE_IDS[tag.type] || 3, value: tag.value };
    });
    return [
        { name: 'name', type: 8, value: p.name },
        { name: 'states', type: 10, value: stateEntries },
        { name: 'version', type: 3, value: p.version }
    ];
});
```

### 5.4 block_position_data（**关键**）

**格式**：

```
TAG_Compound "block_position_data"
  ├── "0,0,0"     (TAG_Compound)
  │     └── block_entity_data (TAG_Compound)
  ├── "3,5,-2"    (TAG_Compound)
  │     └── block_entity_data (TAG_Compound)
  ...
```

**⚠️ 三条黄金规则**（详见 `07-blockentity.md`）：

1. 键是 `"sx,sy,sz"` 字符串（相对坐标，无空格）
2. 值包一层 `block_entity_data`
3. BE 内 x/y/z 也是相对坐标

**构造代码**：

```javascript
const bpEntries = Object.keys(blockPositionData).map(function(key) {
    return {
        name: key,
        type: 10,
        value: [
            { name: 'block_entity_data', type: 10, value: blockPositionData[key] }
        ]
    };
});
```

## 6. 完整构造代码

```javascript
function buildMcstructure(sizeX, sizeY, sizeZ, indices0, indices1, paletteEntries, bpEntries, originX, originY, originZ) {
    const root = [
        { name: 'format_version', type: 3, value: 1 },
        { name: 'size', type: 9, value: { itemType: 3, items: [sizeX, sizeY, sizeZ] } },
        { name: 'structure', type: 10, value: [
            { name: 'block_indices', type: 9, value: { itemType: 9, items: [
                { itemType: 3, items: Array.from(indices0) },
                { itemType: 3, items: Array.from(indices1) }
            ]}},
            { name: 'entities', type: 9, value: { itemType: 10, items: [] } },
            { name: 'palette', type: 10, value: [
                { name: 'default', type: 10, value: [
                    { name: 'block_palette', type: 9, value: { itemType: 10, items: paletteEntries } },
                    { name: 'block_position_data', type: 10, value: bpEntries }
                ]}
            ]}
        ]},
        { name: 'structure_world_origin', type: 9, value: { itemType: 3, items: [originX, originY, originZ] } }
    ];

    return bSerializeBE(root);
}
```

## 7. 完整解析代码

```javascript
function parseMcstructure(bytes) {
    const nbt = parseNbt(bytes, 0);
    const root = nbt.value;

    // size
    const sizeX = root.size.value.items[0];
    const sizeY = root.size.value.items[1];
    const sizeZ = root.size.value.items[2];

    // origin
    let originX = 0, originY = 0, originZ = 0;
    if (root.structure_world_origin && root.structure_world_origin.value) {
        const items = root.structure_world_origin.value.items;
        originX = items[0];
        originY = items[1];
        originZ = items[2];
    }

    // structure
    const structure = root.structure.value;
    const palette = structure.palette.value.default.value.block_palette.value.items;

    // block_indices（两层）
    const biItems = structure.block_indices.value.items;
    const blockIndices0 = biItems[0].items || biItems[0];
    let blockIndices1 = null;
    if (biItems.length > 1) {
        const arr = biItems[1].items || biItems[1];
        // 检查是否有非 -1 值
        let hasAny = false;
        for (let i = 0; i < arr.length; i++) {
            if (arr[i] >= 0) { hasAny = true; break; }
        }
        if (hasAny) blockIndices1 = arr;
    }

    // BE
    const defaultCompound = structure.palette.value.default.value;
    const blockPositionData = defaultCompound.block_position_data ?
                              defaultCompound.block_position_data.value : {};

    return {
        sizeX, sizeY, sizeZ,
        originX, originY, originZ,
        palette,
        blockIndices0,
        blockIndices1,
        blockPositionData
    };
}
```

## 8. 陷阱清单

### 8.1 索引顺序错

```
❌ (sx * sizeZ + sz) * sizeY + sy      （把 Z 放中间）
❌ sx + sy * sizeX + sz * sizeX * sizeY   （X 最快变化）
✅ (sx * sizeY + sy) * sizeZ + sz       （正确）
```

### 8.2 block_position_data 键格式

```
❌ "0" / "1" / "2"
❌ "3, 5, -2"     （有空格）
❌ "100,64,200"   （世界坐标）
✅ "3,5,-2"
```

### 8.3 缺 block_entity_data 包装

```
❌ { name: "3,5,-2", value: [{ name: 'id', ... }] }
✅ { name: "3,5,-2", value: [{ name: 'block_entity_data', value: [{ name: 'id', ... }] }] }
```

### 8.4 size 顺序错

```
❌ [sizeX, sizeZ, sizeY]
✅ [sizeX, sizeY, sizeZ]
```

### 8.5 内存爆炸

`new Int32Array(sizeX * sizeY * sizeZ)` 可能分配数百 MB。

**建议**：先估算，超阈值警告。

### 8.6 palette[0] 不一定是 air

有些工具生成的结构，`palette[0]` 不是 air。**不要假设**。

**正确做法**：检查实际 name。

### 8.7 version 字段

```
❌ 1
❌ 0
✅ 18168865   （1.19.10）
```

不同版本的 version 不同：

| MC 版本 | version |
|---------|---------|
| 1.16 | 17825808 |
| 1.17 | 17879555 |
| 1.18 | 17959425 |
| 1.19.10 | 18168865 |

**建议**：用 18168865。

## 9. 与 mcworld 的对照表

| mcstructure 字段 | mcworld 对应 |
|-----------------|-------------|
| size | 由 min/max 坐标算出 |
| block_indices[0] | SubChunk 的 layer 0 |
| block_indices[1] | SubChunk 的 layer 1 |
| palette.default.block_palette | SubChunk 里的 palette |
| palette.default.block_position_data | chunk 的 0x31 键 |
| structure_world_origin | 用户指定的放置位置 |

## 10. 自检清单

- [ ] 根是 Compound (10)
- [ ] `format_version` = 1
- [ ] `size` 是 `[sizeX, sizeY, sizeZ]`
- [ ] 索引公式是 `(sx * sizeY + sy) * sizeZ + sz`
- [ ] `block_indices` 有两层
- [ ] 每层长度 = sizeX * sizeY * sizeZ
- [ ] layer 1 全空时用全 -1 数组（不要省略）
- [ ] `block_position_data` 的键是 `"sx,sy,sz"`
- [ ] 每个 BE 包了 `block_entity_data`
- [ ] BE 内 x/y/z 用结构相对坐标
- [ ] palette 里每个条目有 name / states / version
- [ ] version 是 18168865
- [ ] `structure_world_origin` 是 3 个 Int

## 11. 参考

- mcstructure 格式：https://learn.microsoft.com/en-us/minecraft/creator/reference/content/schemasreference/schemas/minecraftschema_blocks_1.0.0
- NBT 规范：https://wiki.vg/NBT
