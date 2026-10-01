# 11 - 双向转换算法

> 本文件讲清 `.mcworld` ↔ `.mcstructure` 的**完整转换逻辑**。
> 前置阅读：`04-sstable.md`、`06-subchunk.md`、`07-blockentity.md`、`08-leveldat.md`、`09-mcstructure.md`。

## 1. 转换的核心难点

### 1.1 数据模型差异

| 维度 | mcworld | mcstructure |
|------|---------|-------------|
| 坐标 | 世界绝对坐标 | 结构相对坐标 |
| 布局 | 按 chunk 分块 | 一整块稠密 3D 数组 |
| 索引顺序 | XZY | XYZ |
| 索引类型 | 位打包（0/2/4/8） | Int32 数组 |
| 调色板 | 每子区块独立 | 全局共享 |
| 层数 | layerCount 可 > 1 | 固定 2 层 |
| 空气 | 不存或存 palette | palette[0] 通常是 air |
| 方块实体 | 挂在 chunk 的 0x31 | 挂在 block_position_data |
| 光照/生物群系 | 有独立字段 | 无 |
| 实体（0x32） | 有 | 有（一般空） |

### 1.2 需要转换的关键点

**mcworld → mcstructure**：

1. 扫描所有子区块，找到 **非空气内容范围**（min/max 坐标）
2. 把每个子区块的方块按 XZY → XYZ 转换
3. 展开成稠密数组
4. BE 从世界坐标 → 相对坐标
5. BE 的键从"无键" → `"sx,sy,sz"` 字符串

**mcstructure → mcworld**：

1. 遍历结构的每个方块，按世界坐标分组到 chunk
2. 按 XZY → XYZ 转换
3. 每个 chunk 内的方块按 subY 分组成 SubChunk
4. BE 从相对坐标 → 世界坐标
5. BE 按 chunk 分组，拼成一条 0x31

### 1.3 数据丢失风险

| 源 | 目标 | 丢失 |
|----|------|------|
| mcworld | mcstructure | 光照、生物群系、实体、计划刻、计分板 |
| mcstructure | mcworld | 无（完全覆盖子区块） |

## 2. mcworld → mcstructure

### 2.1 完整流程图

```
Step 1: 加载 ZIP
Step 2: 解析所有 .ldb → key-value
Step 3: 分类：
         - 0x2f（子区块）
         - 0x31（BE）
Step 4: 扫描范围（求 min/max）
Step 5: 收集方块（两层）
Step 6: 收集 BE
Step 7: 展开 Map → Int32Array
Step 8: 构造 mcstructure NBT
Step 9: 下载
```

### 2.2 Step 1-3: 加载和分类

```javascript
async function step1to3(file) {
    const zip = await JSZip.loadAsync(file);

    const ldbFiles = [];
    zip.forEach(function(path) {
        if (path.startsWith('db/') && (path.endsWith('.ldb') || path.endsWith('.log'))) {
            ldbFiles.push(path);
        }
    });

    const allEntries = [];
    for (const path of ldbFiles) {
        const bytes = await zip.file(path).async('uint8array');
        const r = parseSSTable(bytes);
        for (const e of r.entries) allEntries.push(e);
    }

    const subChunkMap = new Map();
    const beBufList = [];

    for (const e of allEntries) {
        if (e.key.length === 10 && e.key[8] === 0x2f) {
            const view = new DataView(e.key.buffer, e.key.byteOffset, e.key.byteLength);
            const cx = view.getInt32(0, true);
            const cz = view.getInt32(4, true);
            const subY = new Int8Array([e.key[9]])[0];
            subChunkMap.set(cx + ',' + cz + ',' + subY, { cx, cz, subY, value: e.value });
        } else if (e.key.length === 9 && e.key[8] === 0x31) {
            beBufList.push(e.value);
        }
    }

    return { subChunkMap, beBufList };
}
```

### 2.3 Step 4: 扫描范围

```javascript
const GROUND_BLOCKS = new Set([
    'minecraft:air', 'minecraft:bedrock', 'minecraft:dirt', 'minecraft:grass_block',
    'minecraft:stone', 'minecraft:deepslate', 'minecraft:podzol', 'minecraft:snow',
    'minecraft:snow_layer', 'minecraft:sand', 'minecraft:gravel', 'minecraft:water'
]);

function step4_scanRange(subChunkMap, ignoreGround) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    const entriesArr = Array.from(subChunkMap.values());

    for (const sc of entriesArr) {
        const sub = parseSubChunk(sc.value);
        if (!sub) continue;

        for (let li = 0; li < sub.layers.length; li++) {
            const layer = sub.layers[li];
            if (!layer.palette || layer.palette.length === 0) continue;

            if (ignoreGround) {
                let allGround = true;
                for (const p of layer.palette) {
                    if (!GROUND_BLOCKS.has(p.name)) { allGround = false; break; }
                }
                if (allGround) continue;
            }

            if (layer.bits === 0) {
                const palEntry = layer.palette[0];
                if (!palEntry) continue;
                if (ignoreGround && GROUND_BLOCKS.has(palEntry.name)) continue;
                const wx0 = sc.cx * 16, wy0 = sc.subY * 16, wz0 = sc.cz * 16;
                if (wx0 < minX) minX = wx0;
                if (wx0 + 15 > maxX) maxX = wx0 + 15;
                if (wy0 < minY) minY = wy0;
                if (wy0 + 15 > maxY) maxY = wy0 + 15;
                if (wz0 < minZ) minZ = wz0;
                if (wz0 + 15 > maxZ) maxZ = wz0 + 15;
            } else {
                for (let lx = 0; lx < 16; lx++) for (let ly = 0; ly < 16; ly++) for (let lz = 0; lz < 16; lz++) {
                    const palIdx = getBitValue(layer.indexBytes, lx * 256 + lz * 16 + ly, layer.bits);
                    if (palIdx < 0 || palIdx >= layer.palette.length) continue;
                    const palEntry = layer.palette[palIdx];
                    if (ignoreGround && GROUND_BLOCKS.has(palEntry.name)) continue;
                    const wx = sc.cx * 16 + lx;
                    const wy = sc.subY * 16 + ly;
                    const wz = sc.cz * 16 + lz;
                    if (wx < minX) minX = wx;
                    if (wx > maxX) maxX = wx;
                    if (wy < minY) minY = wy;
                    if (wy > maxY) maxY = wy;
                    if (wz < minZ) minZ = wz;
                    if (wz > maxZ) maxZ = wz;
                }
            }
        }
    }

    return { x1: minX, x2: maxX, y1: minY, y2: maxY, z1: minZ, z2: maxZ };
}
```

### 2.4 Step 5: 收集方块（两层）

```javascript
function step5_collectBlocks(subChunkMap, bounds, ignoreGround) {
    const { x1, x2, y1, y2, z1, z2 } = bounds;
    const sizeX = x2 - x1 + 1;
    const sizeY = y2 - y1 + 1;
    const sizeZ = z2 - z1 + 1;

    const blocksMap0 = new Map();
    const blocksMap1 = new Map();
    const palette = [];
    const paletteMap = new Map();

    function addPal(name, states, version) {
        const stateKeys = Object.keys(states || {}).sort()
            .map(k => k + '=' + states[k].type + ':' + states[k].value)
            .join(',');
        const key = name + '|' + stateKeys;
        if (paletteMap.has(key)) return paletteMap.get(key);
        palette.push({ name, states: states || {}, version: version || 18168865 });
        const idx = palette.length - 1;
        paletteMap.set(key, idx);
        return idx;
    }
    addPal('minecraft:air', {});

    const entriesArr = Array.from(subChunkMap.values());

    for (const sc of entriesArr) {
        const sub = parseSubChunk(sc.value);
        if (!sub) continue;

        for (let li = 0; li < sub.layers.length; li++) {
            if (li >= 2) break;
            const layer = sub.layers[li];
            if (!layer.palette || layer.palette.length === 0) continue;
            const targetMap = (li === 0) ? blocksMap0 : blocksMap1;

            if (layer.bits === 0) {
                const palEntry = layer.palette[0];
                if (!palEntry || palEntry.name === 'minecraft:air') continue;
                const finalIdx = addPal(palEntry.name, palEntry.states, palEntry.version);
                for (let lx = 0; lx < 16; lx++) for (let ly = 0; ly < 16; ly++) for (let lz = 0; lz < 16; lz++) {
                    const wx = sc.cx * 16 + lx, wy = sc.subY * 16 + ly, wz = sc.cz * 16 + lz;
                    if (wx < x1 || wx > x2 || wy < y1 || wy > y2 || wz < z1 || wz > z2) continue;
                    const sx = wx - x1, sy = wy - y1, sz = wz - z1;
                    const structIdx = (sx * sizeY + sy) * sizeZ + sz;
                    targetMap.set(structIdx, finalIdx);
                }
            } else {
                for (let lx = 0; lx < 16; lx++) for (let ly = 0; ly < 16; ly++) for (let lz = 0; lz < 16; lz++) {
                    const palIdx = getBitValue(layer.indexBytes, lx * 256 + lz * 16 + ly, layer.bits);
                    if (palIdx < 0 || palIdx >= layer.palette.length) continue;
                    const palEntry = layer.palette[palIdx];
                    if (palEntry.name === 'minecraft:air') continue;
                    const wx = sc.cx * 16 + lx, wy = sc.subY * 16 + ly, wz = sc.cz * 16 + lz;
                    if (wx < x1 || wx > x2 || wy < y1 || wy > y2 || wz < z1 || wz > z2) continue;
                    const finalIdx = addPal(palEntry.name, palEntry.states, palEntry.version);
                    const sx = wx - x1, sy = wy - y1, sz = wz - z1;
                    const structIdx = (sx * sizeY + sy) * sizeZ + sz;
                    targetMap.set(structIdx, finalIdx);
                }
            }
        }
    }

    return { blocksMap0, blocksMap1, palette, sizeX, sizeY, sizeZ };
}
```

### 2.5 Step 6: 收集 BE

```javascript
function step6_collectBE(beBufList, bounds) {
    const { x1, x2, y1, y2, z1, z2 } = bounds;
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

    return { blockPositionData, beTotal, beKept, beFail };
}
```

### 2.6 Step 7-9: 展开 + 构造 + 下载

```javascript
function step7to9(blocksResult, beResult, bounds) {
    const { blocksMap0, blocksMap1, palette, sizeX, sizeY, sizeZ } = blocksResult;
    const { blockPositionData } = beResult;
    const { x1, y1, z1 } = bounds;

    const totalBlocks = sizeX * sizeY * sizeZ;

    const indices0 = new Int32Array(totalBlocks).fill(-1);
    for (const kv of blocksMap0) indices0[kv[0]] = kv[1];

    const indices1 = new Int32Array(totalBlocks).fill(-1);
    for (const kv of blocksMap1) indices1[kv[0]] = kv[1];

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

    const bpEntries = Object.keys(blockPositionData).map(function(key) {
        return {
            name: key,
            type: 10,
            value: [
                { name: 'block_entity_data', type: 10, value: blockPositionData[key] }
            ]
        };
    });

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
        { name: 'structure_world_origin', type: 9, value: { itemType: 3, items: [x1, y1, z1] } }
    ];

    return bSerializeBE(root);
}
```

### 2.7 完整实现

```javascript
async function mcworldToMcstructure(file, options) {
    const { ignoreGround = false } = options || {};

    // Step 1-3
    const { subChunkMap, beBufList } = await step1to3(file);

    // Step 4
    const bounds = step4_scanRange(subChunkMap, ignoreGround);
    if (bounds.x1 === Infinity) {
        throw new Error('未找到任何非地面内容');
    }

    // Step 5
    const blocksResult = step5_collectBlocks(subChunkMap, bounds, ignoreGround);

    // Step 6
    const beResult = step6_collectBE(beBufList, bounds);

    // Step 7-9
    return step7to9(blocksResult, beResult, bounds);
}
```

## 3. mcstructure → mcworld

### 3.1 完整流程图

```
Step 1: 解析 mcstructure NBT
Step 2: 读 size / palette / layer0 / layer1 / block_position_data
Step 3: 遍历方块（两层），按 chunk 分组
Step 4: 处理 BE
Step 5: 构建 db 条目
Step 6: SSTable + MANIFEST + ZIP
Step 7: 下载
```

### 3.2 Step 1-2: 解析

```javascript
function step1to2_parse(bytes) {
    const nbt = parseNbt(bytes, 0);
    const root = nbt.value;

    const sizeX = root.size.value.items[0];
    const sizeY = root.size.value.items[1];
    const sizeZ = root.size.value.items[2];

    let originX = 0, originY = 0, originZ = 0;
    if (root.structure_world_origin && root.structure_world_origin.value) {
        const items = root.structure_world_origin.value.items;
        originX = items[0]; originY = items[1]; originZ = items[2];
    }

    const structure = root.structure.value;
    const palette = structure.palette.value.default.value.block_palette.value.items;

    const biItems = structure.block_indices.value.items;
    const blockIndices0 = biItems[0].items || biItems[0];

    let blockIndices1 = null;
    if (biItems.length > 1) {
        const arr = biItems[1].items || biItems[1];
        let hasAny = false;
        for (let i = 0; i < arr.length; i++) {
            if (arr[i] >= 0) { hasAny = true; break; }
        }
        if (hasAny) blockIndices1 = arr;
    }

    return {
        sizeX, sizeY, sizeZ,
        originX, originY, originZ,
        palette, blockIndices0, blockIndices1,
        structure
    };
}
```

### 3.3 Step 3: 遍历方块

```javascript
function step3_groupBlocks(parsed, px, py, pz) {
    const { sizeX, sizeY, sizeZ, palette, blockIndices0, blockIndices1 } = parsed;
    const chunkGroups = new Map();

    function getOrCreate(cx, cz) {
        const key = cx + ',' + cz;
        if (!chunkGroups.has(key)) {
            chunkGroups.set(key, {
                cx, cz,
                subChunks: new Map(),
                blockEntities: []
            });
        }
        return chunkGroups.get(key);
    }

    function addBlockAt(structIdx, palIdx, layerIdx) {
        const palEntry = palette[palIdx];
        const blockName = palEntry.name.value;
        if (blockName === 'minecraft:air' || blockName === 'minecraft:structure_void') return;

        const sx = Math.floor(structIdx / (sizeY * sizeZ));
        const rem = structIdx % (sizeY * sizeZ);
        const sy = Math.floor(rem / sizeZ);
        const sz = rem % sizeZ;

        const worldX = px + sx, worldY = py + sy, worldZ = pz + sz;
        const cx = Math.floor(worldX / 16);
        const cz = Math.floor(worldZ / 16);
        const subY = Math.floor(worldY / 16);

        const group = getOrCreate(cx, cz);
        if (!group.subChunks.has(subY)) {
            group.subChunks.set(subY, [[], []]);
        }
        const subLayers = group.subChunks.get(subY);
        subLayers[layerIdx].push({
            x: worldX - cx * 16,
            y: worldY - subY * 16,
            z: worldZ - cz * 16,
            name: blockName,
            states: palEntry.states.value
        });
    }

    const totalStructureBlocks = sizeX * sizeY * sizeZ;
    for (let structIdx = 0; structIdx < totalStructureBlocks; structIdx++) {
        const palIdx0 = blockIndices0[structIdx];
        if (palIdx0 >= 0) addBlockAt(structIdx, palIdx0, 0);
        if (blockIndices1) {
            const palIdx1 = blockIndices1[structIdx];
            if (palIdx1 >= 0) addBlockAt(structIdx, palIdx1, 1);
        }
    }

    return chunkGroups;
}
```

### 3.4 Step 4: 处理 BE

```javascript
function step4_processBE(parsed, chunkGroups, px, py, pz) {
    const { sizeX, sizeY, sizeZ, palette, blockIndices0, structure } = parsed;

    const defaultCompound = structure.palette.value.default.value;
    if (!defaultCompound.block_position_data || !defaultCompound.block_position_data.value) {
        return;
    }
    const bpd = defaultCompound.block_position_data.value;
    const beKeys = Object.keys(bpd);

    function getOrCreate(cx, cz) {
        const key = cx + ',' + cz;
        if (!chunkGroups.has(key)) {
            chunkGroups.set(key, {
                cx, cz,
                subChunks: new Map(),
                blockEntities: []
            });
        }
        return chunkGroups.get(key);
    }

    for (const key of beKeys) {
        const beData = bpd[key].value;
        if (!beData.block_entity_data || !beData.block_entity_data.value) continue;
        const be = beData.block_entity_data.value;

        let sx = null, sy = null, sz = null;
        const cm = key.match(/^(-?\d+),\s*(-?\d+),\s*(-?\d+)$/);
        if (cm) {
            sx = parseInt(cm[1]); sy = parseInt(cm[2]); sz = parseInt(cm[3]);
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

        // 世界坐标
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

### 3.5 Step 5-6: 构建 mcworld

```javascript
async function step5to6(chunkGroups, worldName, spawnX, spawnY, spawnZ) {
    const levelDat = buildLevelDat(worldName, spawnX, spawnY, spawnZ);

    const entries = [];
    const v2b = new Uint8Array(540);
    for (let i = 0; i < 270; i++) v2b[i * 2] = 0x04;
    const tag2c = new Uint8Array([0x2a]);
    const tag36 = new Uint8Array([2, 0, 0, 0]);
    const tag3f = new Uint8Array([0xb5, 0x60, 0x75, 0xfd, 0x69, 0x2a, 0x3c, 0x93]);
    const tag40 = new Uint8Array([0x00, 0x0a]);
    const tag41 = new Uint8Array([0x00]);
    const tag77 = new Uint8Array(0);

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

    for (const group of chunkGroups.values()) {
        // SubChunk
        for (const [subY, subLayers] of group.subChunks) {
            const l0 = subLayers[0] || [];
            const l1 = subLayers[1] || [];
            if (l0.length === 0 && l1.length === 0) continue;
            const writeLayers = (l1.length > 0) ? [l0, l1] : [l0];
            const scBytes = serializeSubChunk(subY, writeLayers);
            entries.push({
                key: makeKey(group.cx, group.cz, 0x2f, subY & 0xFF),
                value: scBytes
            });
        }

        // BlockEntity
        let totalBe = 0;
        for (const be of group.blockEntities) totalBe += be.length;
        const combinedBe = new Uint8Array(totalBe);
        let off = 0;
        for (const be of group.blockEntities) {
            combinedBe.set(be, off);
            off += be.length;
        }
        entries.push({ key: makeKey(group.cx, group.cz, 0x31), value: combinedBe });

        // 元数据
        entries.push({ key: makeKey(group.cx, group.cz, 0x2b), value: v2b });
        entries.push({ key: makeKey(group.cx, group.cz, 0x2c), value: tag2c });
        entries.push({ key: makeKey(group.cx, group.cz, 0x36), value: tag36 });
        entries.push({ key: makeKey(group.cx, group.cz, 0x3f), value: tag3f });
        entries.push({ key: makeKey(group.cx, group.cz, 0x40), value: tag40 });
        entries.push({ key: makeKey(group.cx, group.cz, 0x41), value: tag41 });
        entries.push({ key: makeKey(group.cx, group.cz, 0x77), value: tag77 });
    }

    const ldbBytes = buildSSTable(entries);

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

    const zip = new ZipBuilder();
    zip.addFile('level.dat', levelDat);
    zip.addFile('db/000005.ldb', ldbBytes);
    zip.addFile('db/CURRENT', new TextEncoder().encode('MANIFEST-000004\n'));
    zip.addFile('db/MANIFEST-000004', manifestBytes);
    zip.addFile('levelname.txt', new TextEncoder().encode(worldName));
    zip.addFile('world_behavior_packs.json', new TextEncoder().encode('[]'));
    zip.addFile('world_resource_packs.json', new TextEncoder().encode('[]'));

    return zip.build();
}
```

### 3.6 完整实现

```javascript
async function mcstructureToMcworld(file, options) {
    const {
        worldName = 'Structure World',
        spawnX = 0, spawnY = -60, spawnZ = 0
    } = options || {};

    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = step1to2_parse(bytes);

    const px = spawnX;
    const py = spawnY;
    const pz = spawnZ;

    const chunkGroups = step3_groupBlocks(parsed, px, py, pz);
    step4_processBE(parsed, chunkGroups, px, py, pz);

    return step5to6(chunkGroups, worldName, px, py, pz);
}
```

## 4. 数据完整性检查

### 4.1 转换前后对比

```javascript
function verifyConversion(original, converted) {
    // 检查方块数量
    // 检查 BE 数量
    // 检查关键方块（命令方块、告示牌）
}
```

### 4.2 关键点自检

**mcworld → mcstructure**：

- [ ] 方块总数接近预期
- [ ] BE 数量接近预期
- [ ] 命令方块有 `Command` 字段
- [ ] 告示牌有 `FrontText` / `BackText`
- [ ] 水面、雪、草在 layer 1

**mcstructure → mcworld**：

- [ ] chunk 数量合理
- [ ] 每个 chunk 有 `0x31`
- [ ] 每个 chunk 有 7 个元数据键
- [ ] `0x31` 值 < 32 KB

## 5. 常见转换错误

### 5.1 方块错位

**症状**：方块位置不对，但数量和种类对。

**病因**：索引顺序错。

**排查**：

- mcworld 侧：`lx * 256 + lz * 16 + ly`（XZY）
- mcstructure 侧：`(sx * sizeY + sy) * sizeZ + sz`（XYZ）

### 5.2 BE 丢失

**症状**：方块对，但命令方块是空、告示牌是空。

**病因**：

1. `block_position_data` 键写成扁平索引
2. 没包 `block_entity_data`
3. BE 内 x/y/z 是世界坐标而不是相对坐标

**排查**：用 NBT 查看器打开 `.mcstructure` 看键格式。

### 5.3 水面丢失

**症状**：水、雪、草都不见。

**病因**：只处理了 layer 0。

**排查**：检查 `parseSubChunk` 返回的 `layers` 数组长度。

### 5.4 部分 chunk 丢失

**症状**：某些区域是空的。

**病因**：

1. 未处理某些 subY（比如负值）
2. 排序错误
3. SSTable 的键编码错误

## 6. 性能优化

### 6.1 大文件（> 100 MB）

**分批处理**：

```javascript
for (let i = 0; i < ldbFiles.length; i++) {
    // 处理 ldbFiles[i]
    if (i % 5 === 0) await yieldToUI();
}
```

### 6.2 稀疏存档

**问题**：稀疏存档（方块分散在很大范围）会创建巨大的稠密数组。

**解决**：

1. 扫描时识别稀疏区域
2. 提示用户缩小范围
3. 或分多个 mcstructure

### 6.3 单 chunk BE 过多

**问题**：一个 chunk 里 100+ 个命令方块，`0x31` 超 32 KB。

**解决**：

1. 过滤 `LastOutput`
2. 分区块导出
3. 减少命令方块密度

## 7. 自检清单

**mcworld → mcstructure**：

- [ ] 处理了所有 subY（含负值）
- [ ] 处理了 layer 0 和 layer 1
- [ ] `getBitValue` 有 bits=0 短路
- [ ] 索引公式是 `(sx * sizeY + sy) * sizeZ + sz`
- [ ] `block_position_data` 键是 `"sx,sy,sz"`
- [ ] BE 内 x/y/z 是相对坐标
- [ ] 内存估算合理（< 1000 万方块）

**mcstructure → mcworld**：

- [ ] 索引反向推导正确
- [ ] SubChunk 用 version 9
- [ ] 每个 subY 一个 SubChunk
- [ ] 每个 chunk 有 7 个元数据键
- [ ] `0x31` 单条 < 32 KB
- [ ] BE 内 x/y/z 是世界坐标
- [ ] `level.dat` 的 `lastOpenedWithVersion` 是 List\<Int\>

## 8. 参考

- mcstructure 格式：https://learn.microsoft.com/en-us/minecraft/creator/
- level.dat：https://minecraft.fandom.com/wiki/Level.dat
- SubChunk 格式：https://minecraft.fandom.com/wiki/Bedrock_Edition_level_format
