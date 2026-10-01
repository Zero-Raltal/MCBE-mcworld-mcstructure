# 12 - 陷阱清单汇总

> 按**严重程度**排序。每条都是实测踩过的坑。
> 症状 → 病因快速查找表在 §2。

## 1. 陷阱清单（18 条）

### 严重（会丢数据）

#### 1. 只读 layer 0

**后果**：水面、雪、草丛、花、地毯、藤蔓全丢。

**修复**：

```javascript
// ❌ 只读第一层
const palIdx = getBitValue(sub.indexBytes, idx, sub.bits);

// ✅ 逐层遍历
for (const layer of sub.layers) {
    const palIdx = getBitValue(layer.indexBytes, idx, layer.bits);
}
```

详见 `06-subchunk.md` §3。

#### 2. ⚠️ `block_position_data` 键写成 `"sx,sy,sz"`

**后果**：**所有**方块实体 NBT 丢失。命令方块指令、告示牌文字、箱子物品都没了。

**修复**：

```javascript
// ❌ 键是 "8,1,8"（坐标字符串）
blockPositionData[sx + ',' + sy + ',' + sz] = entries;

// ✅ 键是 String(structIdx)（扁平索引）
const structIdx = (sx * sizeY + sy) * sizeZ + sz;
blockPositionData[String(structIdx)] = entries;
```

**⚠️ 重要**：社区广泛流传"键必须是 `'x,y,z'`"，这是**错误**的。游戏用 `Number(key)` 得到索引，`Number("8,1,8")` = `NaN`，静默跳过。

详见 `07-blockentity.md` §3。

#### 3. bits=0 未短路

**后果**：全空气/全石头的子区块读出越界，可能崩溃或返回垃圾值。

**修复**：

```javascript
function getBitValue(buf, index, bits) {
    if (bits === 0) return 0;   // ★ 关键短路
    // ...
}
```

详见 `06-subchunk.md` §4.4。

#### 4. 索引顺序搞混 XZY vs YZX

**后果**：方块错位、镜像、扭转。

**修复**：

```javascript
// mcworld 侧（子区块内）
const subChunkIdx = lx * 256 + lz * 16 + ly;   // XZY

// mcstructure 侧（全局）
const structIdx = (sx * sizeY + sy) * sizeZ + sz;   // XYZ
```

详见 `06-subchunk.md` §5 和 `09-mcstructure.md` §3。

### 中等（会导致加载失败）

#### 5. 内部键缺 8 字节尾部

**后果**：整个 SSTable 无法读取。

**修复**：

```javascript
function makeInternalKey(userKey) {
    const ik = new Uint8Array(userKey.length + 8);
    ik.set(userKey, 0);
    ik[userKey.length] = 1;   // value_type
    return ik;
}
```

详见 `04-sstable.md` §4。

#### 6. lastOpenedWithVersion 写成 String

**后果**：游戏提示"升级世界"。

**修复**：

```javascript
// ❌ String
{ name: 'lastOpenedWithVersion', type: 8, value: '1.19.10' }

// ✅ List<Int>
{ name: 'lastOpenedWithVersion', type: 9, value: { itemType: 3, items: [1, 19, 10, 3, 0] } }
```

详见 `08-leveldat.md` §2.2。

#### 7. SpawnY 不是 32767

**后果**：出生点异常，可能在世界外。

**修复**：

```javascript
{ name: 'SpawnY', type: 3, value: 32767 }
```

详见 `08-leveldat.md` §2.3。

#### 8. 单条 `0x31` 超过 32KB

**后果**：该区块**所有** BE 丢失。

**修复**：

1. 过滤 `LastOutput` / `LastOutputParams`
2. 分区块导出
3. 减少命令方块密度

详见 `07-blockentity.md` §2.5。

#### 9. bits 取 3、5、6、7

**后果**：整个子区块错位。

**修复**：

```javascript
// ❌ 任意位宽
const bits = Math.ceil(Math.log2(paletteSize));

// ✅ 只取 0、2、4、8
const bits = pc <= 1 ? 0 : (pc <= 4 ? 2 : (pc <= 16 ? 4 : 8));
```

详见 `06-subchunk.md` §4.3。

#### 10. 子区块版本非 9

**后果**：1.18+ 加载失败。

**修复**：

```javascript
buf.push(9);   // version 9
```

详见 `06-subchunk.md` §2。

#### 11. 元索引块和索引块顺序颠倒

**后果**：整个 .ldb 废掉。

**修复**：元索引块在索引块**之前**。

详见 `04-sstable.md` §2。

#### 12. BlockHandle 的 size 含尾部

**后果**：越界读取。

**修复**：

```javascript
// ✅ size 只包含内容本身
encodeHandle(offset, blockContentBytes.length);
// 不含 5 字节尾部
```

详见 `04-sstable.md` §3。

### 轻微（会错位或丢失部分数据）

#### 13. BE 里 x/y/z 坐标与结构坐标系不一致

**后果**：BE 错位或丢失。

**修复**：mcstructure 侧统一用结构相对坐标。

详见 `07-blockentity.md` §7.3。

#### 14. TAG_String 长度用了 int32

**后果**：NBT 解析失败。

**修复**：

```javascript
// ✅ TAG_String 用 uint16
const len = readI16();

// ✅ 其他数组用 int32
const len = readI32();
```

详见 `01-nbt.md` §1.3。

#### 15. 读取 palette 时误用数组方法

**后果**：`p.find is not a function` 报错。

**修复**：

```javascript
// ❌ 错误（p 是对象，不是数组）
const name = p.find(x => x.name === 'name').value.value;

// ✅ 正确
const name = p.name.value;
```

**原因**：写入时 palette 条目是数组 `[{name, type, value}, ...]`，读取时是对象 `{name: {type, value}, ...}`。两种形态不一致。

详见 `09-mcstructure.md` §5.3。

#### 16. Layer 1 palette 全空气时仍写层

**后果**：文件膨胀，可能不兼容。

**修复**：

```javascript
const writeLayers = (l1.length > 0) ? [l0, l1] : [l0];
```

详见 `06-subchunk.md` §9。

#### 17. 压缩类型用了 1（Snappy）

**后果**：基岩版读不出来。

**修复**：

```
✅ compression_type = 0（无压缩）
✅ compression_type = 4（raw deflate）
❌ compression_type = 1（Snappy）
```

详见 `04-sstable.md` §3.3。

#### 18. mcstructure 未排序

**后果**：block_indices 语义错误。

**修复**：索引必须按公式顺序填充。

详见 `09-mcstructure.md` §3.2。

## 2. 症状 → 病因快速查找

| 症状 | 病因 | 详见 |
|------|------|------|
| 游戏提示"升级世界" | `lastOpenedWithVersion` 不是 List\<Int\> | `08` §2.2 |
| 存档加载失败 | Footer 魔数错误 / MANIFEST 格式错误 | `04` §7 |
| **有方块无指令** | **`block_position_data` 键不是扁平索引** | `07` §3 |
| 有方块但位置错乱 | 索引顺序错（XZY vs YZX） | `06` §5 / `09` §3.3 |
| 整个区块丢失 | 子区块版本不是 9，或 bits 不是 2 的幂 | `06` §2 / §4.3 |
| 命令方块变石头 | 调色板 NBT 结构错误 | `06` §7 |
| 大量方块实体丢失 | 单条 `0x31` 超过 32KB | `07` §2.5 |
| 水面/雪/草丢失 | 未处理 layer 1 | `06` §3 |
| 部分子区块全空 | bits=0 未短路 | `06` §4.4 |
| 出生点异常 | SpawnY 不是 32767 | `08` §2.3 |
| 世界地形随机 | Generator 不是 2 | `08` §2.4 |
| 方块镜像/翻转 | XZY vs XYZ 搞混 | `06` §5 |
| 告示牌空白 | FrontText/BackText 结构错 | `07` §4.2 |
| 箱子物品丢失 | Items List 结构错 | `07` §4.3 |
| 打开后立刻崩溃 | CRC 计算范围错 | `04` §3.3 |
| SSTable 解析失败 | 元索引块和索引块顺序颠倒 | `04` §2 |
| 部分数据读成垃圾 | BlockHandle size 含尾部 | `04` §3.2 |
| NBT 解析异常 | TAG_String 长度用错 | `01` §1.3 |
| `p.find is not a function` | 读取 palette 时误用数组方法 | `09` §5.3 |

## 3. 预防性检查代码

### 3.1 block_position_data 键格式

```javascript
function checkBlockPositionData(bpd, sizeY, sizeZ) {
    for (const key of Object.keys(bpd)) {
        // ✅ 应该是纯数字字符串
        if (!/^\d+$/.test(key)) {
            console.warn('block_position_data 键格式错误:', key, '（应该是纯数字字符串）');
            continue;
        }

        // 反推坐标
        const structIdx = parseInt(key, 10);
        const sx = Math.floor(structIdx / (sizeY * sizeZ));
        const rem = structIdx % (sizeY * sizeZ);
        const sy = Math.floor(rem / sizeZ);
        const sz = rem % sizeZ;

        console.log('  "' + key + '" → (' + sx + ',' + sy + ',' + sz + ')');

        const entry = bpd[key];
        if (!entry.value || !entry.value.block_entity_data) {
            console.warn('  缺少 block_entity_data');
        }
    }
}
```

### 3.2 NBT 类型检查

```javascript
function checkNbtString(data, pos) {
    const len = new DataView(data.buffer, data.byteOffset + pos).getUint16(0, true);
    if (len > 100000) {
        console.warn('可能的 NBT 长度异常:', len);
    }
    return len;
}
```

### 3.3 SubChunk 完整性检查

```javascript
function checkSubChunk(sub) {
    if (!sub) return false;

    for (const layer of sub.layers) {
        if (layer.bits === 0 && layer.palette.length !== 1) {
            console.warn('bits=0 但 palette 长度不是 1');
        }
        if (layer.bits !== 0 && layer.bits !== 2 && layer.bits !== 4 && layer.bits !== 8) {
            console.warn('bits 异常:', layer.bits);
        }
    }
    return true;
}
```

### 3.4 level.dat 完整性检查

```javascript
function checkLevelDat(root) {
    const errors = [];

    if (!root.lastOpenedWithVersion || root.lastOpenedWithVersion.type !== 'List') {
        errors.push('lastOpenedWithVersion 不是 List');
    }
    if (!root.lastOpenedWithVersion || root.lastOpenedWithVersion.value.itemType !== 'Int') {
        errors.push('lastOpenedWithVersion 元素不是 Int');
    }
    if (!root.SpawnY || root.SpawnY.value !== 32767) {
        errors.push('SpawnY 不是 32767');
    }
    if (!root.Generator || root.Generator.value !== 2) {
        errors.push('Generator 不是 2');
    }
    return errors;
}
```

## 4. 附录：常见错误的完整示例

### 4.1 ❌ 错误的 block_position_data

```javascript
// ❌ 错误：键是坐标字符串
const bpEntries = [
    { name: '8,1,8', type: 10, value: [
        { name: 'block_entity_data', type: 10, value: [
            { name: 'id', type: 8, value: 'CommandBlock' },
            { name: 'Command', type: 8, value: 'say hello' }
        ]}
    ]}
];

// 游戏读不到，所有命令方块变成空
// 原因：Number("8,1,8") = NaN
```

### 4.2 ✅ 正确的写法

```javascript
// ✅ 正确：键是扁平索引字符串
const sizeY = 4, sizeZ = 16;
const sx = 8, sy = 1, sz = 8;
const structIdx = (sx * sizeY + sy) * sizeZ + sz;   // = 536

const bpEntries = [
    { name: String(structIdx), type: 10, value: [   // "536"
        { name: 'block_entity_data', type: 10, value: [
            { name: 'id', type: 8, value: 'CommandBlock' },
            { name: 'Command', type: 8, value: 'say hello' },
            { name: 'x', type: 3, value: sx },          // 8（相对坐标）
            { name: 'y', type: 3, value: sy },          // 1
            { name: 'z', type: 3, value: sz }           // 8
        ]}
    ]}
];
```

### 4.3 ❌ 错误的 SubChunk 索引

```javascript
// ❌ 错误：YZX 顺序
const idx = ly * 256 + lz * 16 + lx;

// ❌ 错误：XYZ 顺序
const idx = lx * 16 + ly * 256 + lz * 4096;

// ✅ 正确：XZY 顺序
const idx = lx * 256 + lz * 16 + ly;
```

### 4.4 ❌ 错误的 mcstructure 索引

```javascript
// ❌ 错误：XZY 顺序
const structIdx = sx * 256 + sz * 16 + sy;

// ❌ 错误：ZYX 顺序
const structIdx = sz * sizeX * sizeY + sy * sizeX + sx;

// ✅ 正确：XYZ 顺序
const structIdx = (sx * sizeY + sy) * sizeZ + sz;
```

### 4.5 ❌ 读取 palette 时误用数组方法

```javascript
// ❌ 错误（parseNbt 后 palette 条目是对象）
const name = p.find(x => x.name === 'name').value.value;

// ✅ 正确
const name = p.name.value;
```

## 5. 自检清单

**写代码前**：

- [ ] 读过 `01-nbt.md`
- [ ] 读过 `04-sstable.md`
- [ ] 读过 `06-subchunk.md`
- [ ] 读过 `07-blockentity.md`
- [ ] 读过 `08-leveldat.md`
- [ ] 读过 `09-mcstructure.md`

**提交代码前**：

- [ ] 18 条陷阱都避免
- [ ] 症状反查表里没有你遇到的
- [ ] 用了预防性检查代码
- [ ] 测试了方块、BE、layer 1、多 chunk

## 6. 参考

- 详见各章节
