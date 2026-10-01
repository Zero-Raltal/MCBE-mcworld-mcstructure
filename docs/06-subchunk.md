# 06 - SubChunk 子区块格式

> SubChunk 是 mcworld 里**实际存方块**的地方。一个 SubChunk 是 16×16×16 的立方体。
> 本文件讲清它的**版本差异**、**两层结构**、**位打包**、**常见陷阱**。

## 1. 基本概念

### 1.1 尺寸

- SubChunk 是 **16×16×16 = 4096** 个方块的立方体
- 世界坐标 (wx, wy, wz) 映射到：
  - `cx = floor(wx / 16)`（chunk X）
  - `cz = floor(wz / 16)`（chunk Z）
  - `subY = floor(wy / 16)`（子区块 Y）
  - `lx = wx - cx * 16`（局部 X，0~15）
  - `ly = wy - subY * 16`（局部 Y，0~15）
  - `lz = wz - cz * 16`（局部 Z，0~15）

### 1.2 高度范围

| MC 版本 | 世界 Y 范围 | subY 范围 |
|---------|-----------|-----------|
| 1.18 前 | 0 ~ 255 | 0 ~ 15 |
| **1.18+** | **-64 ~ 319** | **-4 ~ 19** |

**注意**：subY 是**有符号字节**，-4 在字节里是 `0xFC`。

## 2. 版本差异

### 2.1 v8 vs v9

| 版本 | 结构 |
|------|------|
| **v8** | `[version=8][layerCount][layers...]` |
| **v9** | `[version=9][layerCount][subY][layers...]` |

**v9 多了 1 字节 subY**。

**1.18+ 必须用 v9**。

### 2.2 完整布局

```
[version 1B][layerCount 1B][subY 1B（仅 v9）]
[Layer 0 数据]
[Layer 1 数据]  ← 可选
...
```

## 3. 层级（Layer）概念

### 3.1 两层的含义

- **layer 0**：主方块（石头、木板、命令方块、刷怪笼等）
- **layer 1**：贴附层（水、雪层、雪、草、花、地毯、藤蔓、海龟蛋、睡莲等）

**⚠️ 最大的数据丢失点**：如果只读 layer 0，水面、积雪、地表草丛全部丢失。

### 3.2 判断层是否存在

**每层的开头是 `storageFormat` 字节**：

- `storageFormat = 0`：bits = 0，palette 只有 1 项
- `storageFormat = 1`：bits = 0，palette_type = 1（少见）
- `storageFormat = 4`：bits = 2，palette_type = 0
- `storageFormat = 8`：bits = 4，palette_type = 0
- `storageFormat = 16`：bits = 8，palette_type = 0

**paletteCount == 0** 表示该层没有内容。

## 4. 每层数据格式

### 4.1 结构

```
[storageFormat 1B][方块索引数组][paletteCount uint32 LE][palette NBT 数组]
```

### 4.2 storageFormat 解码

```javascript
const storageFormat = data[pos++];
const bits = storageFormat >> 1;           // 位宽
const paletteType = storageFormat & 1;     // 0 = 索引在前，1 = 调色板在前
```

**基岩版用 paletteType = 0**。

### 4.3 bits 只能是 0、2、4、8

| palette 大小 | bits | indexByteCount |
|--------------|------|----------------|
| 1 | 0 | 0 |
| 2-4 | 2 | 1024 |
| 5-16 | 4 | 2048 |
| 17-256 | 8 | 4096 |

**⚠️ 不能取 3、5、6、7**。如果取错，整个子区块会错位。

**为什么不能取 3**：基岩版读取器只支持 2 的幂，其他值会按错误的位宽解读。

### 4.4 bits = 0 的特殊情况

**如果一个子区块内所有方块都是同一种（例如全空气、全石头）**，基岩版可能用 `bits = 0` 存储：

- `storageFormat = 0`
- `indexByteCount = (4096 * 0) >> 3 = 0` —— **索引数组为空**
- 调色板只有 1 项

**⚠️ 读索引时必须短路返回 0**：

```javascript
function getBitValue(buf, index, bits) {
    if (bits === 0) return 0;   // ★ 关键短路
    // ...
}
```

**如果不短路**：位运算会读取空数组，返回 `undefined` 或崩溃。

### 4.5 索引数组长度

```javascript
const indexByteCount = (4096 * bits) >> 3;
```

- bits = 0 → 0 字节
- bits = 2 → 1024 字节
- bits = 4 → 2048 字节
- bits = 8 → 4096 字节

## 5. 方块索引顺序（**XZY**）

### 5.1 公式

```
index = lx * 256 + lz * 16 + ly
```

**顺序是 X→Z→Y**，不是 X→Y→Z！

### 5.2 为什么

Minecraft 的存储顺序按"Y 最快变化"排列：

- 先固定 (lx, lz)，扫描 16 个 ly
- 再固定 lx，扫描 16 个 lz
- 最后扫描 16 个 lx

### 5.3 ⚠️ 与 mcstructure 的差异

```
mcworld 索引：    lx * 256 + lz * 16 + ly     (XZY)
mcstructure 索引： (sx * sizeY + sy) * sizeZ + sz  (XYZ)
```

**搞混会导致方块错位、镜像、扭转**。

**测试方法**：放一个非对称结构（例如 L 形），看转过去后是否保持形状。

## 6. 位打包 / 解包

### 6.1 连续位打包

- 每个方块的索引占 `bits` 位
- 连续存放，从低位开始
- 不按字节对齐

**示例**（bits = 4）：

```
方块 0 的索引占 bit 0~3
方块 1 的索引占 bit 4~7
方块 2 的索引占 bit 8~11
...
```

**示例**（bits = 2）：

```
方块 0 的索引占 bit 0~1
方块 1 的索引占 bit 2~3
方块 2 的索引占 bit 4~5
方块 3 的索引占 bit 6~7
方块 4 的索引占 bit 8~9（进入下一字节）
...
```

### 6.2 解包实现

```javascript
function getBitValue(buf, index, bits) {
    if (bits === 0) return 0;
    const totalBit = index * bits;
    let byteIdx = totalBit >> 3;
    let bitOff = totalBit & 7;
    let remaining = bits;
    let value = 0;
    let shift = 0;

    while (remaining > 0) {
        const bitsAvailable = 8 - bitOff;
        const bitsToRead = Math.min(bitsAvailable, remaining);
        const mask = (1 << bitsToRead) - 1;
        value |= ((buf[byteIdx] >> bitOff) & mask) << shift;
        shift += bitsToRead;
        remaining -= bitsToRead;
        byteIdx++;
        bitOff = 0;
    }
    return value;
}
```

### 6.3 打包实现

```javascript
function packBitValue(buf, index, value, bits) {
    if (bits === 0) return;
    const totalBit = index * bits;
    let byteIdx = totalBit >> 3;
    let bitOff = totalBit & 7;
    let remaining = bits;
    let v = value;

    while (remaining > 0) {
        const bitsAvailable = 8 - bitOff;
        const bitsToWrite = Math.min(bitsAvailable, remaining);
        const mask = ((1 << bitsToWrite) - 1) << bitOff;
        buf[byteIdx] = (buf[byteIdx] & ~mask) | ((v & ((1 << bitsToWrite) - 1)) << bitOff);
        v >>>= bitsToWrite;
        remaining -= bitsToWrite;
        byteIdx++;
        bitOff = 0;
    }
}
```

## 7. 调色板

### 7.1 每个条目的 NBT 结构

```
TAG_Compound
  TAG_String "name" = "minecraft:xxx"
  TAG_Compound "states"
    TAG_Int "某状态" = 值
  TAG_Int "version" = 18168865
```

### 7.2 读调色板

```javascript
const paletteCount = view.getUint32(pos, true);
pos += 4;

const palette = [];
for (let i = 0; i < paletteCount; i++) {
    const nbt = parseNbt(data, pos);
    pos += nbt.bytesRead;
    palette.push({
        name: nbt.value.name.value,
        states: nbt.value.states.value,
        version: nbt.value.version ? nbt.value.version.value : 18168865
    });
}
```

### 7.3 写调色板

```javascript
function makeBlockPaletteEntry(name, states) {
    const stateEntries = Object.keys(states || {}).map(k => {
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

## 8. 完整的 parseSubChunk

```javascript
function parseSubChunk(data) {
    try {
        let pos = 0;
        const version = data[pos++];
        const layerCount = data[pos++];
        let subY = 0;
        if (version === 9) subY = new Int8Array([data[pos++]])[0];

        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const layers = [];

        for (let li = 0; li < layerCount; li++) {
            if (pos >= data.length) break;
            const storageFormat = data[pos++];
            const bits = storageFormat >> 1;
            const indexByteCount = (4096 * bits) >> 3;
            const indexBytes = data.slice(pos, pos + indexByteCount);
            pos += indexByteCount;

            const paletteCount = view.getUint32(pos, true);
            pos += 4;

            const palette = [];
            for (let i = 0; i < paletteCount; i++) {
                const nbt = parseNbt(data, pos);
                pos += nbt.bytesRead;
                palette.push({
                    name: nbt.value.name.value,
                    states: nbt.value.states.value,
                    version: nbt.value.version ? nbt.value.version.value : 18168865
                });
            }
            layers.push({ bits, indexBytes, palette });
        }

        // 保留 layer0 字段兼容旧调用
        const l0 = layers[0] || { bits: 0, indexBytes: new Uint8Array(0), palette: [] };
        return {
            version, subY, layerCount, layers,
            bits: l0.bits,
            indexBytes: l0.indexBytes,
            palette: l0.palette
        };
    } catch (e) { return null; }
}
```

## 9. 完整的 serializeSubChunk

```javascript
function serializeSubChunk(subY, layerBlockLists) {
    // layerBlockLists: [ [ {x,y,z,name,states}, ... ], [ ... ] ]
    const buf = [];
    buf.push(9);
    buf.push(layerBlockLists.length);
    buf.push(subY & 0xFF);

    for (const blocks of layerBlockLists) {
        const localPalette = [];
        const palMap = new Map();

        function addPal(name, states) {
            const stateKeys = Object.keys(states || {}).sort()
                .map(k => k + '=' + states[k].type + ':' + states[k].value)
                .join(',');
            const key = name + '|' + stateKeys;
            if (palMap.has(key)) return palMap.get(key);
            const stateEntries = Object.keys(states || {}).map(k => {
                const tag = states[k];
                return { name: k, type: NBT_TYPE_IDS[tag.type] || 3, value: tag.value };
            });
            localPalette.push(bSerializeBE([
                { name: 'name', type: 8, value: name },
                { name: 'states', type: 10, value: stateEntries },
                { name: 'version', type: 3, value: 18168865 }
            ]));
            const idx = localPalette.length - 1;
            palMap.set(key, idx);
            return idx;
        }

        addPal('minecraft:air', {});
        for (const b of blocks) addPal(b.name, b.states);

        const pc = localPalette.length;
        const bits = pc <= 1 ? 0 : (pc <= 4 ? 2 : (pc <= 16 ? 4 : 8));
        const indexByteCount = (4096 * bits) >> 3;
        const indexBytes = new Uint8Array(indexByteCount);

        for (const b of blocks) {
            const localIdx = addPal(b.name, b.states);
            packBitValue(indexBytes, b.x * 256 + b.z * 16 + b.y, localIdx, bits);
        }

        buf.push((bits << 1) | 0);
        for (let i = 0; i < indexBytes.length; i++) buf.push(indexBytes[i]);
        buf.push(pc & 0xFF, (pc >> 8) & 0xFF, (pc >> 16) & 0xFF, (pc >> 24) & 0xFF);
        for (const pe of localPalette) {
            for (let i = 0; i < pe.length; i++) buf.push(pe[i]);
        }
    }
    return new Uint8Array(buf);
}
```

## 10. 陷阱清单

### 10.1 bits = 0 未短路

```javascript
// ❌ 会崩
const idx = getBitValue(emptyArray, i, 0);

// ✅ 短路
function getBitValue(buf, index, bits) {
    if (bits === 0) return 0;
    // ...
}
```

### 10.2 只读 layer 0

```javascript
// ❌ 水面、雪、草丢失
const palIdx = getBitValue(sub.indexBytes, ...);

// ✅ 逐层遍历
for (const layer of sub.layers) {
    // ...
}
```

### 10.3 索引顺序错（XZY vs YZX）

```javascript
// ❌ 错
const idx = ly * 256 + lz * 16 + lx;

// ✅ 对
const idx = lx * 256 + lz * 16 + ly;
```

### 10.4 subY 有符号问题

```javascript
// ❌ 读时没还原符号
const subY = data[pos];   // 0xFC 会读成 252

// ✅ 还原
const subY = new Int8Array([data[pos]])[0];   // -4
```

### 10.5 bits 选错

```javascript
// ❌ 用 3
const bits = Math.ceil(Math.log2(paletteSize));

// ✅ 只用 2、4、8
const bits = pc <= 4 ? 2 : (pc <= 16 ? 4 : 8);
```

### 10.6 版本号错误

```javascript
// ❌ 用 v8
buf.push(8);

// ✅ 1.18+ 用 v9
buf.push(9);
```

## 11. 常见方块的 states 示例

**楼梯**：

```javascript
{
    name: 'minecraft:oak_stairs',
    states: {
        upside_down_bit: { type: 'Byte', value: 0 },
        weirdo_direction: { type: 'Int', value: 0 }
    }
}
```

**告示牌**：

```javascript
{
    name: 'minecraft:standing_sign',
    states: {
        ground_sign_direction: { type: 'Int', value: 0 }
    }
}
```

**栅栏门**：

```javascript
{
    name: 'minecraft:fence_gate',
    states: {
        in_wall_bit: { type: 'Byte', value: 0 },
        open_bit: { type: 'Byte', value: 0 },
        direction: { type: 'Int', value: 0 }
    }
}
```

**水**（layer 1）：

```javascript
{
    name: 'minecraft:water',
    states: {
        liquid_depth: { type: 'Int', value: 0 }
    }
}
```

## 12. 自检清单

- [ ] SubChunk 版本号是 9（1.18+）
- [ ] subY 用有符号字节处理
- [ ] bits 只取 0、2、4、8
- [ ] `getBitValue` 开头有 `if (bits === 0) return 0`
- [ ] 索引顺序是 `lx * 256 + lz * 16 + ly`（XZY）
- [ ] 遍历了所有层（不只 layer 0）
- [ ] palette 里的 name 完整（含 `minecraft:` 前缀）
- [ ] palette 里的 version 是 18168865（或合适版本号）
- [ ] 空 palette 时能正确处理

## 13. 参考

- 基岩版 SubChunk 格式：https://minecraft.fandom.com/wiki/Bedrock_Edition_level_format#SubChunk
- paletted storage：https://wiki.vg/Chunk_Format
