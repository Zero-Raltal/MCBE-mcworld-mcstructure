# 01 - NBT 二进制格式

> 本文件是所有其他文件的基础。NBT 用于 `.mcstructure`、`level.dat`、SubChunk 调色板、BlockEntity 数据。

## 1. 基本结构

### 1.1 TAG 单元

每个 TAG 的格式：

```
[类型 1B][名称长度 uint16 LE][名称 UTF-8][值]
```

**关键点**：

- **所有数值都是小端序（LE）**
- **字符串的长度前缀是 uint16**（不是 int32！）
- **根 TAG 的名称必须是空字符串**
- **根 TAG 的类型必须是 Compound (10)**

### 1.2 类型表

| ID | 类型 | 值编码 | 备注 |
|----|------|--------|------|
| 0 | TAG_End | 无 | Compound 结束标志 |
| 1 | TAG_Byte | 1 B | 有符号 int8 |
| 2 | TAG_Short | 2 B LE | 有符号 int16 |
| 3 | TAG_Int | 4 B LE | 有符号 int32 |
| 4 | TAG_Long | 8 B LE | 有符号 int64 |
| 5 | TAG_Float | 4 B LE | IEEE 754 单精度 |
| 6 | TAG_Double | 8 B LE | IEEE 754 双精度 |
| 7 | TAG_ByteArray | `int32 长度` + 字节 | |
| 8 | TAG_String | `uint16 长度` + UTF-8 | ⚠️ 只有这个是 uint16 |
| 9 | TAG_List | `元素类型 1B` + `int32 数量` + 元素 | 元素类型固定 |
| 10 | TAG_Compound | 子 TAG 序列 + `0x00` 结束 | 无序字典 |
| 11 | TAG_IntArray | `int32 长度` + int32 元素 | |
| 12 | TAG_LongArray | `int32 长度` + int64 元素 | |

### 1.3 长度前缀陷阱（**必读**）

```
TAG_String  →  uint16 长度（最大 65535 字节）
TAG_ByteArray  →  int32 长度
TAG_List  →  int32 长度
TAG_IntArray  →  int32 长度
TAG_LongArray  →  int32 长度
```

**为什么危险**：如果误把 `TAG_String` 的长度按 int32 读，会读进 2 个多余的字节，后续所有解析都错位，通常会抛 `Unknown NBT type` 或读出一个天文数字的长度导致内存爆掉。

**记忆口诀**：**只有 String 是 16 位长度，其他都是 32 位**。

## 2. 类型 ID ↔ 名称映射

```javascript
const NBT_TYPE_NAMES = {
    1: 'Byte', 2: 'Short', 3: 'Int', 4: 'Long', 5: 'Float', 6: 'Double',
    7: 'ByteArray', 8: 'String', 9: 'List', 10: 'Compound',
    11: 'IntArray', 12: 'LongArray'
};

const NBT_TYPE_IDS = {
    Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6,
    ByteArray: 7, String: 8, List: 9, Compound: 10,
    IntArray: 11, LongArray: 12
};
```

## 3. 解析器实现

### 3.1 完整解析器

```javascript
function parseNbt(data, offset) {
    offset = offset || 0;
    let pos = offset;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    function readU8()  { return data[pos++]; }
    function readI16() { const v = view.getInt16(pos, true); pos += 2; return v; }
    function readI32() { const v = view.getInt32(pos, true); pos += 4; return v; }
    function readI64() {
        const lo = view.getUint32(pos, true);
        const hi = view.getUint32(pos + 4, true);
        pos += 8;
        // 用 BigInt 保留精度，返回字符串
        return ((BigInt(hi) << 32n) | BigInt(lo)).toString();
    }
    function readF32() { const v = view.getFloat32(pos, true); pos += 4; return v; }
    function readF64() { const v = view.getFloat64(pos, true); pos += 8; return v; }
    function readStr() {
        const len = readI16();
        const bytes = data.slice(pos, pos + len);
        pos += len;
        return new TextDecoder().decode(bytes);
    }

    function readPayload(type) {
        switch (type) {
            case 1: return readU8();
            case 2: return readI16();
            case 3: return readI32();
            case 4: return readI64();
            case 5: return readF32();
            case 6: return readF64();
            case 7: {
                const len = readI32();
                const arr = data.slice(pos, pos + len);
                pos += len;
                return Array.from(arr);
            }
            case 8: return readStr();
            case 9: {
                const itemType = readU8();
                const len = readI32();
                const items = [];
                for (let i = 0; i < len; i++) items.push(readPayload(itemType));
                return {
                    _list: true,
                    itemType: NBT_TYPE_NAMES[itemType] || itemType,
                    count: len,
                    items
                };
            }
            case 10: {
                const obj = {};
                while (true) {
                    const t = readU8();
                    if (t === 0) break;   // TAG_End
                    const name = readStr();
                    obj[name] = {
                        type: NBT_TYPE_NAMES[t] || t,
                        value: readPayload(t)
                    };
                }
                return obj;
            }
            case 11: {
                const len = readI32();
                const arr = [];
                for (let i = 0; i < len; i++) arr.push(readI32());
                return arr;
            }
            case 12: {
                const len = readI32();
                const arr = [];
                for (let i = 0; i < len; i++) arr.push(readI64());
                return arr;
            }
            default: throw new Error('Unknown NBT type: ' + type);
        }
    }

    const rootType = readU8();
    const rootName = readStr();
    const rootValue = readPayload(rootType);
    return {
        rootType: NBT_TYPE_NAMES[rootType] || rootType,
        rootName,
        value: rootValue,
        bytesRead: pos - offset   // ★ 关键：告诉调用者读了多长
    };
}
```

### 3.2 解析结果的形态

**基本类型**：直接是数字或字符串。

```javascript
// parseNbt 的 root.value 是：
{
    size: { type: 'List', value: { _list: true, itemType: 'Int', count: 3, items: [32, 16, 16] } },
    format_version: { type: 'Int', value: 1 },
    structure_world_origin: { ... }
}
```

**Compound**：`{ 字段名: { type, value } }` —— 注意**每个字段本身是 `{type, value}` 对象**。

**List**：`{ _list: true, itemType: 'Xxx', count: N, items: [...] }`。

**⚠️ 空 List 特殊**：`itemType` 可能是 0（TAG_End），此时 `items` 是空数组。

### 3.3 连续解析（多 NBT 拼接）

`0x31` 键的值是**一串连续的 NBT Compound**。用 `bytesRead` 遍历：

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

## 4. 写入器实现

### 4.1 完整写入器

```javascript
function bPutU16(a, v) { a.push(v & 0xFF, (v >> 8) & 0xFF); }
function bPutI32(a, v) {
    a.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF);
}
function bPutStr(a, s) {
    const b = new TextEncoder().encode(s);
    bPutU16(a, b.length);
    for (let i = 0; i < b.length; i++) a.push(b[i]);
}
function bPutTag(a, type, name, val) {
    a.push(type);
    if (type === 0) return;
    bPutStr(a, name);
    bPutVal(a, type, val);
}
function bPutVal(a, type, val) {
    switch (type) {
        case 1: a.push(val & 0xFF); break;
        case 2: bPutU16(a, val); break;
        case 3: bPutI32(a, val); break;
        case 4: {
            const dv = new DataView(new ArrayBuffer(8));
            dv.setBigInt64(0, BigInt(val), true);
            const u = new Uint8Array(dv.buffer);
            for (let i = 0; i < 8; i++) a.push(u[i]);
            break;
        }
        case 5: {
            const dv = new DataView(new ArrayBuffer(4));
            dv.setFloat32(0, val, true);
            const u = new Uint8Array(dv.buffer);
            for (let i = 0; i < 4; i++) a.push(u[i]);
            break;
        }
        case 6: {
            const dv = new DataView(new ArrayBuffer(8));
            dv.setFloat64(0, val, true);
            const u = new Uint8Array(dv.buffer);
            for (let i = 0; i < 8; i++) a.push(u[i]);
            break;
        }
        case 7:
            bPutI32(a, val.length);
            for (let i = 0; i < val.length; i++) a.push(val[i] & 0xFF);
            break;
        case 8: bPutStr(a, val); break;
        case 9:
            a.push(val.itemType);
            bPutI32(a, val.items.length);
            for (const it of val.items) bPutVal(a, val.itemType, it);
            break;
        case 10:
            for (const t of val) bPutTag(a, t.type, t.name, t.value);
            a.push(0);   // TAG_End
            break;
        case 11:
            bPutI32(a, val.length);
            for (const v of val) bPutI32(a, v);
            break;
    }
}
function bSerializeBE(root) {
    const a = [];
    bPutTag(a, 10, '', root);
    return new Uint8Array(a);
}
```

### 4.2 写入格式约定

**`root` 是一个数组**，元素 `{ name, type, value }`：

```javascript
const root = [
    { name: 'format_version', type: 3, value: 1 },
    { name: 'size', type: 9, value: { itemType: 3, items: [32, 16, 16] } },
    { name: 'structure', type: 10, value: [
        { name: 'block_indices', type: 9, value: { itemType: 9, items: [
            { itemType: 3, items: [...] },
            { itemType: 3, items: [...] }
        ]}}
    ]}
];
const bytes = bSerializeBE(root);
```

**关键约定**：

- 基本类型：`value` 直接是数字/字符串
- `List`：`{ itemType: 数字, items: [...] }`
- `Compound`：递归的 `[{ name, type, value }]` 数组

**⚠️ 数字是类型的 ID，不是字符串**：

```javascript
// ✅ 正确
{ name: 'Command', type: 8, value: 'say hello' }   // type: 8 = String

// ❌ 错误
{ name: 'Command', type: 'String', value: 'say hello' }   // 写不出去
```

## 5. 解析结果 → 写入格式

从 `parseNbt` 得到的对象结构是 `{ 字段名: { type, value } }`，写回时需要转成 `[{ name, type, value }]` 数组。

```javascript
function parsedToWriterEntries(compoundObj) {
    const entries = [];
    for (const name of Object.keys(compoundObj)) {
        const tag = compoundObj[name];
        const typeId = NBT_TYPE_IDS[tag.type];
        if (typeId === undefined) continue;
        let value = tag.value;

        if (tag.type === 'Compound') {
            value = parsedToWriterEntries(value);
        } else if (tag.type === 'List') {
            const itemTypeId = NBT_TYPE_IDS[value.itemType] || 0;
            let items;
            if (value.itemType === 'Compound') {
                items = value.items.map(item => parsedToWriterEntries(item));
            } else {
                items = value.items;
            }
            value = { itemType: itemTypeId, items };
        }
        entries.push({ name, type: typeId, value });
    }
    return entries;
}
```

### 5.1 过滤版本（用于 BE 数据）

命令方块的 `LastOutput` / `LastOutputParams` 会撑爆 32KB 限制，可以过滤：

```javascript
const BE_SKIP_FIELDS = ['LastOutput', 'LastOutputParams'];

function parsedToWriterEntriesFiltered(compoundObj) {
    const entries = [];
    for (const name of Object.keys(compoundObj)) {
        if (BE_SKIP_FIELDS.indexOf(name) >= 0) continue;
        const tag = compoundObj[name];
        const typeId = NBT_TYPE_IDS[tag.type];
        if (typeId === undefined) continue;
        let value = tag.value;
        if (tag.type === 'Compound') {
            value = parsedToWriterEntriesFiltered(value);
        } else if (tag.type === 'List') {
            const itemTypeId = NBT_TYPE_IDS[value.itemType] || 0;
            let items;
            if (value.itemType === 'Compound') {
                items = value.items.map(item => parsedToWriterEntriesFiltered(item));
            } else {
                items = value.items;
            }
            value = { itemType: itemTypeId, items };
        }
        entries.push({ name, type: typeId, value });
    }
    return entries;
}
```

**注意**：过滤会丢失"命令方块上次执行输出"的界面显示，**不影响指令本身**。是否过滤由调用者决定。

## 6. 常见 NBT 片段模板

### 6.1 Int List（用于版本号）

```javascript
function intList(values) {
    return { itemType: 3, items: values };
}

// 用于 lastOpenedWithVersion
{ name: 'lastOpenedWithVersion', type: 9, value: intList([1, 19, 10, 3, 0]) }
```

### 6.2 空 List

```javascript
{ name: 'entities', type: 9, value: { itemType: 10, items: [] } }
```

**注意**：空 List 的 `itemType` 惯例用 10（Compound），游戏兼容性最好。

### 6.3 带状态的方块调色板条目

```javascript
{
    name: 'name', type: 8, value: 'minecraft:oak_stairs'
},
{
    name: 'states', type: 10, value: [
        { name: 'upside_down_bit', type: 1, value: 0 },
        { name: 'weirdo_direction', type: 3, value: 0 }
    ]
},
{
    name: 'version', type: 3, value: 18168865
}
```

## 7. 自检清单

- [ ] `TAG_String` 的长度前缀用的是 **uint16**
- [ ] `TAG_List` / `TAG_ByteArray` / `TAG_IntArray` 的长度前缀用的是 **int32**
- [ ] 所有数值都按小端序读写（`DataView.getXxx(pos, true)`）
- [ ] 根 TAG 名称是空字符串，类型是 Compound (10)
- [ ] `TAG_Long` 用 BigInt 或字符串保存（避免精度丢失）
- [ ] 写入时 `type` 是数字 ID（不是 'String' 这种字符串）
- [ ] Compound 结尾必须写 `0x00` (TAG_End)
- [ ] 空 List 的 `itemType` 用 10

## 8. 参考

- 官方 NBT 规范：https://wiki.vg/NBT
- 基岩版差异：https://minecraft.fandom.com/wiki/Bedrock_Edition_level_format
