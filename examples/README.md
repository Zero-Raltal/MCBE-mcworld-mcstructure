## 文件列表

| 文件 | 说明 |
|------|------|
| `read-mcworld.js` | 读取 .mcworld 里的所有方块和 BE |
| `write-mcworld.js` | 从零生成一个简单 .mcworld |
| `read-mcstructure.js` | 读取 .mcstructure |
| `write-mcstructure.js` | 从零生成 .mcstructure |

## 依赖

**Node.js 环境**：

```bash
npm install jszip pako
```

**浏览器环境**：

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js"></script>
```

## 使用方法

```bash
node read-mcworld.js path/to/world.mcworld
```

## 注意

- 所有示例都是**骨架代码**，需要配合 `docs/` 里的完整实现
- 从 `docs/` 里复制的函数：`parseNbt`、`bSerializeBE`、`parseSSTable`、`parseSubChunk`、`serializeSubChunk`、`buildSSTable`、`buildManifestBytes`、`buildLogRecord`、`buildLevelDat`、`ZipBuilder`、`getBitValue`、`packBitValue` 等
- 示例的目的是让你快速验证，不是生产代码
javascript
// examples/read-mcworld.js
// 读取 .mcworld 里的所有方块和方块实体

const fs = require('fs');
const JSZip = require('jszip');

// 从 docs/ 里复制这些函数：
// parseNbt, parseSSTable, parseSubChunk, getBitValue, parseBlockEntities

async function readMcworld(filePath) {
    // Step 1: 加载 ZIP
    const buffer = fs.readFileSync(filePath);
    const zip = await JSZip.loadAsync(buffer);

    // Step 2: 找 db 文件
    const ldbFiles = [];
    zip.forEach(function(path) {
        if (path.startsWith('db/') && (path.endsWith('.ldb') || path.endsWith('.log'))) {
            ldbFiles.push(path);
        }
    });
    console.log('db 文件:', ldbFiles);

    // Step 3: 解析所有 SSTable
    const allEntries = [];
    for (const path of ldbFiles) {
        const bytes = await zip.file(path).async('uint8array');
        const r = parseSSTable(bytes);
        console.log(path, '→', r.entries.length, '条');
        for (const e of r.entries) allEntries.push(e);
    }

    // Step 4: 分类
    const subChunks = [];
    const blockEntities = [];

    for (const e of allEntries) {
        if (e.key.length === 10 && e.key[8] === 0x2f) {
            const view = new DataView(e.key.buffer, e.key.byteOffset, e.key.byteLength);
            subChunks.push({
                cx: view.getInt32(0, true),
                cz: view.getInt32(4, true),
                subY: new Int8Array([e.key[9]])[0],
                value: e.value
            });
        } else if (e.key.length === 9 && e.key[8] === 0x31) {
            blockEntities.push(e.value);
        }
    }

    console.log('子区块数:', subChunks.length);
    console.log('BE 条目数:', blockEntities.length);

    // Step 5: 遍历方块
    const blockCount = {};
    for (const sc of subChunks) {
        const sub = parseSubChunk(sc.value);
        if (!sub) continue;

        for (let li = 0; li < sub.layers.length; li++) {
            const layer = sub.layers[li];

            for (let lx = 0; lx < 16; lx++) for (let ly = 0; ly < 16; ly++) for (let lz = 0; lz < 16; lz++) {
                const palIdx = getBitValue(layer.indexBytes, lx * 256 + lz * 16 + ly, layer.bits);
                if (palIdx < 0 || palIdx >= layer.palette.length) continue;
                const block = layer.palette[palIdx];
                if (block.name === 'minecraft:air') continue;

                blockCount[block.name] = (blockCount[block.name] || 0) + 1;
            }
        }
    }

    console.log('\n方块统计:');
    const sorted = Object.entries(blockCount).sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted.slice(0, 20)) {
        console.log(' ', name, ':', count);
    }

    // Step 6: 遍历方块实体
    console.log('\n方块实体:');
    for (const beBuf of blockEntities) {
        const beList = parseBlockEntities(beBuf);
        for (const be of beList) {
            const id = be.id ? be.id.value : '(无)';
            const x = be.x ? be.x.value : '?';
            const y = be.y ? be.y.value : '?';
            const z = be.z ? be.z.value : '?';
            console.log(' ', id, '@', x, y, z);

            if (id === 'CommandBlock' && be.Command) {
                console.log('    指令:', be.Command.value);
            }
            if (id === 'Sign' && be.FrontText) {
                console.log('    正面:', be.FrontText.value.Text.value);
            }
        }
    }
}

// 使用
const filePath = process.argv[2];
if (!filePath) {
    console.error('用法: node read-mcworld.js path/to/world.mcworld');
    process.exit(1);
}

readMcworld(filePath).catch(console.error);
```

````javascript
// examples/write-mcworld.js
// 从零生成一个简单的 .mcworld：一个 16×4×16 的石头平台 + 一个命令方块

const fs = require('fs');

// 从 docs/ 里复制这些函数：
// bSerializeBE, bPutTag, bPutVal, buildSSTable, buildManifestBytes,
// buildLogRecord, buildLevelDat, ZipBuilder, serializeSubChunk

async function writeMcworld(outputPath) {
    // ---- Step 1: 准备方块数据 ----
    const cx = 0, cz = 0, subY = -4;

    // 收集 layer0 的方块
    const layer0Blocks = [];

    // 石头平台：Y = -64，X = 0~15，Z = 0~15
    for (let lx = 0; lx < 16; lx++) {
        for (let lz = 0; lz < 16; lz++) {
            layer0Blocks.push({
                x: lx, y: 0, z: lz,
                name: 'minecraft:stone',
                states: {}
            });
        }
    }

    // 命令方块：Y = -63，X = 8，Z = 8
    layer0Blocks.push({
        x: 8, y: 1, z: 8,
        name: 'minecraft:command_block',
        states: {
            conditional_bit: { type: 'Byte', value: 0 },
            facing_direction: { type: 'Int', value: 0 }
        }
    });

    // ---- Step 2: 序列化 SubChunk ----
    const subChunkBytes = serializeSubChunk(subY, [layer0Blocks]);

    // ---- Step 3: 准备方块实体 ----
    const beEntries = [
        { name: 'id', type: 8, value: 'CommandBlock' },
        { name: 'Command', type: 8, value: 'say hello' },
        { name: 'CustomName', type: 8, value: '' },
        { name: 'ExecuteOnFirstTick', type: 1, value: 1 },
        { name: 'LPCommandMode', type: 3, value: 0 },
        { name: 'LPCondionalMode', type: 1, value: 0 },
        { name: 'LPRedstoneMode', type: 1, value: 0 },
        { name: 'LastExecution', type: 4, value: 0 },
        { name: 'SuccessCount', type: 3, value: 0 },
        { name: 'TickDelay', type: 3, value: 0 },
        { name: 'TrackOutput', type: 1, value: 1 },
        { name: 'Version', type: 3, value: 19 },
        { name: 'auto', type: 1, value: 1 },
        { name: 'conditionMet', type: 1, value: 0 },
        { name: 'powered', type: 1, value: 0 },
        { name: 'x', type: 3, value: 8 },
        { name: 'y', type: 3, value: -63 },
        { name: 'z', type: 3, value: 8 }
    ];

    const beBytes = bSerializeBE(beEntries);

    // ---- Step 4: 构建 db 条目 ----
    const entries = [];

    function makeKey(cx, cz, tag, subY) {
        const len = subY !== undefined ? 10 : 9;
        const k = new Uint8Array(len);
        const dv = new DataView(k.buffer);
        dv.setInt32(0, cx, true);
        dv.setInt32(4, cz, true);
        k[8] = tag;
        if (subY !== undefined) k[9] = subY & 0xFF;
        return k;
    }

    // SubChunk
    entries.push({
        key: makeKey(cx, cz, 0x2f, subY & 0xFF),
        value: subChunkBytes
    });

    // BlockEntity
    entries.push({
        key: makeKey(cx, cz, 0x31),
        value: beBytes
    });

    // 元数据
    const v2b = new Uint8Array(540);
    for (let i = 0; i < 270; i++) v2b[i * 2] = 0x04;

    entries.push({ key: makeKey(cx, cz, 0x2b), value: v2b });
    entries.push({ key: makeKey(cx, cz, 0x2c), value: new Uint8Array([0x2a]) });
    entries.push({ key: makeKey(cx, cz, 0x36), value: new Uint8Array([2, 0, 0, 0]) });
    entries.push({ key: makeKey(cx, cz, 0x3f), value: new Uint8Array([0xb5, 0x60, 0x75, 0xfd, 0x69, 0x2a, 0x3c, 0x93]) });
    entries.push({ key: makeKey(cx, cz, 0x40), value: new Uint8Array([0x00, 0x0a]) });
    entries.push({ key: makeKey(cx, cz, 0x41), value: new Uint8Array([0x00]) });
    entries.push({ key: makeKey(cx, cz, 0x77), value: new Uint8Array(0) });

    // ---- Step 5: 生成 SSTable ----
    const ldbBytes = buildSSTable(entries);
    console.log('SSTable:', ldbBytes.length, '字节');

    // ---- Step 6: 生成 MANIFEST ----
    const sortedKeys = entries.map(e => e.key).sort(function(a, b) {
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) {
            if (a[i] !== b[i]) return a[i] - b[i];
        }
        return a.length - b.length;
    });

    const manifestRaw = buildManifestBytes(
        0, 5, ldbBytes.length,
        sortedKeys[0], sortedKeys[sortedKeys.length - 1]
    );
    const manifestBytes = buildLogRecord(new Uint8Array(manifestRaw), 1);

    // ---- Step 7: level.dat ----
    const levelDat = buildLevelDat('Test World', 0, -60, 0);

    // ---- Step 8: ZIP ----
    const zip = new ZipBuilder();
    zip.addFile('level.dat', levelDat);
    zip.addFile('db/000005.ldb', ldbBytes);
    zip.addFile('db/CURRENT', new TextEncoder().encode('MANIFEST-000004\n'));
    zip.addFile('db/MANIFEST-000004', manifestBytes);
    zip.addFile('levelname.txt', new TextEncoder().encode('Test World'));
    zip.addFile('world_behavior_packs.json', new TextEncoder().encode('[]'));
    zip.addFile('world_resource_packs.json', new TextEncoder().encode('[]'));

    const zipBytes = zip.build();
    fs.writeFileSync(outputPath, zipBytes);
    console.log('写入:', outputPath, '(', zipBytes.length, '字节)');
}

const outputPath = process.argv[2] || 'test.mcworld';
writeMcworld(outputPath).catch(console.error);
```

````javascript
// examples/read-mcstructure.js
// 读取 .mcstructure，输出方块统计和所有 BE

const fs = require('fs');

// 从 docs/ 里复制：
// parseNbt

function readMcstructure(filePath) {
    const buffer = fs.readFileSync(filePath);
    const bytes = new Uint8Array(buffer);

    const nbt = parseNbt(bytes, 0);
    const root = nbt.value;

    console.log('=== 结构信息 ===');
    const sizeX = root.size.value.items[0];
    const sizeY = root.size.value.items[1];
    const sizeZ = root.size.value.items[2];
    console.log('尺寸:', sizeX, '×', sizeY, '×', sizeZ);
    console.log('总方块数:', (sizeX * sizeY * sizeZ).toLocaleString());

    if (root.structure_world_origin) {
        const o = root.structure_world_origin.value.items;
        console.log('原点:', o[0], o[1], o[2]);
    }

    console.log('\n=== 调色板 ===');
    const palette = root.structure.value.palette.value.default.value.block_palette.value.items;
    console.log('共', palette.length, '项');
    for (let i = 0; i < Math.min(palette.length, 20); i++) {
        const p = palette[i];
        const name = p.find(x => x.name === 'name').value.value;
        console.log(' ', i, ':', name);
    }

    console.log('\n=== 方块统计 ===');
    const biItems = root.structure.value.block_indices.value.items;
    const blockIndices0 = biItems[0].items || biItems[0];

    const counts = {};
    for (let i = 0; i < blockIndices0.length; i++) {
        const idx = blockIndices0[i];
        if (idx < 0) continue;
        const name = palette[idx].find(x => x.name === 'name').value.value;
        counts[name] = (counts[name] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted.slice(0, 20)) {
        console.log(' ', name, ':', count);
    }

    console.log('\n=== 方块实体 ===');
    const bpd = root.structure.value.palette.value.default.value.block_position_data;
    if (bpd && bpd.value) {
        const keys = Object.keys(bpd.value);
        console.log('共', keys.length, '个');
        for (const key of keys) {
            const beData = bpd.value[key].value.block_entity_data.value;
            const id = beData.id ? beData.id.value : '(无)';
            console.log(' ', key, ':', id);

            if (id === 'CommandBlock' && beData.Command) {
                console.log('    指令:', beData.Command.value);
            }
            if (id === 'Sign' && beData.FrontText) {
                console.log('    正面:', beData.FrontText.value.Text.value);
            }
        }
    }
}

const filePath = process.argv[2];
if (!filePath) {
    console.error('用法: node read-mcstructure.js path/to/structure.mcstructure');
    process.exit(1);
}

readMcstructure(filePath);
```

````javascript
// examples/write-mcstructure.js
// 从零生成一个 .mcstructure：3×3×3 的石头 + 一个命令方块

const fs = require('fs');

// 从 docs/ 里复制：
// bSerializeBE, bPutTag, bPutVal, NBT_TYPE_IDS

function writeMcstructure(outputPath) {
    // ---- 结构参数 ----
    const sizeX = 16, sizeY = 4, sizeZ = 16;
    const totalBlocks = sizeX * sizeY * sizeZ;

    // ---- 调色板 ----
    const palette = [
        { name: 'minecraft:air', states: {} },
        { name: 'minecraft:stone', states: {} },
        { name: 'minecraft:command_block', states: {
            conditional_bit: { type: 'Byte', value: 0 },
            facing_direction: { type: 'Int', value: 0 }
        }}
    ];

    // ---- 索引数组 ----
    // 石头平台：Y = 0，X = 0~15，Z = 0~15
    // 命令方块：Y = 1，X = 8，Z = 8
    const indices0 = new Int32Array(totalBlocks).fill(-1);

    for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
            const idx = (x * sizeY + 0) * sizeZ + z;
            indices0[idx] = 1;   // stone
        }
    }

    const cmdIdx = (8 * sizeY + 1) * sizeZ + 8;
    indices0[cmdIdx] = 2;   // command_block

    const indices1 = new Int32Array(totalBlocks).fill(-1);

    // ---- 调色板 NBT ----
    const paletteEntries = palette.map(function(p) {
        const stateEntries = Object.keys(p.states).map(function(k) {
            const tag = p.states[k];
            return { name: k, type: NBT_TYPE_IDS[tag.type] || 3, value: tag.value };
        });
        return [
            { name: 'name', type: 8, value: p.name },
            { name: 'states', type: 10, value: stateEntries },
            { name: 'version', type: 3, value: 18168865 }
        ];
    });

    // ---- 方块实体 ----
    const be = [
        { name: 'id', type: 8, value: 'CommandBlock' },
        { name: 'Command', type: 8, value: 'say hello' },
        { name: 'CustomName', type: 8, value: '' },
        { name: 'ExecuteOnFirstTick', type: 1, value: 1 },
        { name: 'LPCommandMode', type: 3, value: 0 },
        { name: 'LPCondionalMode', type: 1, value: 0 },
        { name: 'LPRedstoneMode', type: 1, value: 0 },
        { name: 'SuccessCount', type: 3, value: 0 },
        { name: 'TickDelay', type: 3, value: 0 },
        { name: 'TrackOutput', type: 1, value: 1 },
        { name: 'Version', type: 3, value: 19 },
        { name: 'auto', type: 1, value: 1 },
        { name: 'conditionMet', type: 1, value: 0 },
        { name: 'powered', type: 1, value: 0 },
        { name: 'x', type: 3, value: 8 },
        { name: 'y', type: 3, value: 1 },
        { name: 'z', type: 3, value: 8 }
    ];

    // ★ 键是 "sx,sy,sz" 字符串
    const bpEntries = [
        {
            name: '8,1,8',
            type: 10,
            value: [
                { name: 'block_entity_data', type: 10, value: be }
            ]
        }
    ];

    // ---- 构造 root ----
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
        { name: 'structure_world_origin', type: 9, value: { itemType: 3, items: [0, 0, 0] } }
    ];

    // ---- 序列化 ----
    const nbtBytes = bSerializeBE(root);
    fs.writeFileSync(outputPath, nbtBytes);
    console.log('写入:', outputPath, '(', nbtBytes.length, '字节)');
}

const outputPath = process.argv[2] || 'test.mcstructure';
writeMcstructure(outputPath);
```

---

**这是最后一批：`10-mcworld.md`、`11-conversion.md`、`12-pitfalls.md`、`13-checklist.md` + `examples/`。**

现在完整的 skill 包已经**全部输出**，结构如下：

```
minecraft-bedrock-codec/
├── SKILL.md                    ← 总纲 + 导航
├── docs/
│   ├── 01-nbt.md               ← NBT 编码 + 解析/写入器
│   ├── 02-primitives.md        ← CRC32C / VarInt / BlockHandle / ZIP
│   ├── 03-leveldb.md           ← LevelDB 整体
│   ├── 04-sstable.md           ← SSTable 详细
│   ├── 05-manifest.md          ← MANIFEST + CURRENT
│   ├── 06-subchunk.md          ← SubChunk + layer + 位打包
│   ├── 07-blockentity.md       ← BlockEntity
│   ├── 08-leveldat.md          ← level.dat
│   ├── 09-mcstructure.md       ← mcstructure 完整
│   ├── 10-mcworld.md           ← mcworld 组合
│   ├── 11-conversion.md        ← 双向转换
│   ├── 12-pitfalls.md          ← 陷阱清单（18 条）
│   └── 13-checklist.md         ← Agent 自检清单
├── examples/
│   ├── README.md
│   ├── read-mcworld.js
│   ├── write-mcworld.js
│   ├── read-mcstructure.js
│   └── write-mcstructure.js
└── LICENSE
```

**放到 GitHub 上的步骤**：

```bash
# 1. 创建目录
mkdir minecraft-bedrock-codec
cd minecraft-bedrock-codec

# 2. 创建目录结构
mkdir docs examples

# 3. 逐个文件复制上面的内容
# （SKILL.md, docs/01-nbt.md, ..., examples/*.js）

# 4. 加 LICENSE
cat > LICENSE << 'EOF'
CC BY 4.0
...
EOF

# 5. Git 初始化
git init
git add .
git commit -m "Initial commit: minecraft-bedrock-codec skill"
git remote add origin https://github.com/你的用户名/minecraft-bedrock-codec.git
git push -u origin main
```

**注意事项**：

1. **examples 里的代码依赖 `docs/` 里的函数**。要让示例真正能跑，最好在 `examples/utils.js` 里汇总所有 helper 函数，然后示例 require 它。或者把 docs 里的代码复制到示例文件顶部。
2. **docs 里的代码片段是教学性质**，可以直接用，但要保证每个文件自洽（函数不重复定义）。
3. 如果**完全按照 `examples/*.js` 直接跑**，需要在文件顶部 import 所有用到的函数。
