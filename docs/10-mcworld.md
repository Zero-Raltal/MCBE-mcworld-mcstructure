# 10 - mcworld 组合

> `.mcworld` = ZIP 包装的 LevelDB 数据库。本文件讲清**如何组装一个完整的 mcworld**。
> 各子模块的细节：`04-sstable.md`、`05-manifest.md`、`06-subchunk.md`、`07-blockentity.md`、`08-leveldat.md`。

## 1. ZIP 布局

```
level.dat                      ← NBT（8 字节头 + NBT 数据）
levelname.txt                  ← 纯文本
world_behavior_packs.json      ← JSON，可以是 []
world_resource_packs.json      ← JSON，可以是 []
world_icon.jpeg                ← 缩略图（可选）
db/CURRENT                     ← "MANIFEST-000004\n"
db/MANIFEST-000004             ← 二进制，LogRecord 序列
db/000005.ldb                  ← 二进制，SSTable
db/000003.log                  ← WriteBatch（可选）
```

**最小可用集**：

```
level.dat
db/CURRENT
db/MANIFEST-000004
db/000005.ldb
```

## 2. 从零生成 mcworld 的完整流程

```
Step 1: 生成 level.dat
Step 2: 收集所有 db 条目（SubChunk + BE + 元数据）
Step 3: 排序
Step 4: buildSSTable → .ldb 字节
Step 5: buildManifestBytes + buildLogRecord → MANIFEST 字节
Step 6: 生成 CURRENT
Step 7: 打包 ZIP
Step 8: 下载
```

## 3. 完整实现代码

### 3.1 主流程

```javascript
async function buildMcworld(options) {
    const {
        worldName = 'Structure World',
        spawnX = 0, spawnY = -60, spawnZ = 0,
        chunkGroups,   // Map<cx,cz, { cx, cz, subChunks: Map<subY, [[layer0blocks], [layer1blocks]]>, blockEntities: [Uint8Array] }>
        autoFlat = true
    } = options;

    // ---- Step 1: level.dat ----
    const levelDat = buildLevelDat(worldName, spawnX, spawnY, spawnZ);

    // ---- Step 2: 收集 db 条目 ----
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

    // 自动填充超平坦（可选）
    if (autoFlat) {
        for (const group of chunkGroups.values()) {
            if (!group.subChunks.has(-4)) {
                group.subChunks.set(-4, [[], []]);
            }
            const subLayers = group.subChunks.get(-4);
            const blocks = subLayers[0];
            const filled = new Set();
            for (const b of blocks) filled.add(b.x + ',' + b.y + ',' + b.z);

            for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
                const addB = function(y, name, states) {
                    if (filled.has(lx + ',' + y + ',' + lz)) return;
                    blocks.push({ x: lx, y, z: lz, name, states });
                };
                addB(0, 'minecraft:bedrock', { infiniburn_bit: { type: 'Int', value: 0 } });
                addB(1, 'minecraft:dirt', {});
                addB(2, 'minecraft:dirt', {});
                addB(3, 'minecraft:grass_block', {});
            }
        }
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

    // ---- Step 3-4: SSTable ----
    const ldbBytes = buildSSTable(entries);

    // ---- Step 5: MANIFEST ----
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

    // ---- Step 6: CURRENT ----
    const currentBytes = new TextEncoder().encode('MANIFEST-000004\n');

    // ---- Step 7: ZIP ----
    const zip = new ZipBuilder();
    zip.addFile('level.dat', levelDat);
    zip.addFile('db/000005.ldb', ldbBytes);
    zip.addFile('db/CURRENT', currentBytes);
    zip.addFile('db/MANIFEST-000004', manifestBytes);
    zip.addFile('levelname.txt', new TextEncoder().encode(worldName));
    zip.addFile('world_behavior_packs.json', new TextEncoder().encode('[]'));
    zip.addFile('world_resource_packs.json', new TextEncoder().encode('[]'));

    return zip.build();
}
```

### 3.2 使用示例

```javascript
// 假设你有一个 mcstructure 的数据
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

// ... 遍历 mcstructure 的方块，调用 addBlockAt 填 chunkGroups

const zipBytes = await buildMcworld({
    worldName: 'My World',
    spawnX: 0, spawnY: -60, spawnZ: 0,
    chunkGroups,
    autoFlat: true
});

// 下载
const blob = new Blob([zipBytes], { type: 'application/octet-stream' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = 'world.mcworld';
document.body.appendChild(a);
a.click();
document.body.removeChild(a);
URL.revokeObjectURL(url);
```

## 4. 读 mcworld 的完整流程

```
Step 1: 用 JSZip 加载
Step 2: 找到 db/*.ldb 和 *.log
Step 3: 对每个 .ldb 调用 parseSSTable
Step 4: 合并所有 key-value
Step 5: 按 key[8] 分类
Step 6: 解释值
```

### 4.1 完整代码

```javascript
async function readMcworld(file) {
    // Step 1: 加载 ZIP
    const zip = await JSZip.loadAsync(file);

    // Step 2: 找 db 文件
    const ldbFiles = [];
    zip.forEach(function(path) {
        if (path.startsWith('db/') && (path.endsWith('.ldb') || path.endsWith('.log'))) {
            ldbFiles.push(path);
        }
    });

    // Step 3: 解析每个 SSTable
    const allEntries = [];
    for (const path of ldbFiles) {
        const bytes = await zip.file(path).async('uint8array');
        const r = parseSSTable(bytes);
        for (const e of r.entries) allEntries.push(e);
    }

    // Step 4: 合并到 dbMap
    const dbMap = new Map();
    for (const e of allEntries) {
        dbMap.set(Array.from(e.key).join(','), e.value);
    }

    // Step 5: 分类
    const subChunks = [];    // [{ cx, cz, subY, value }]
    const blockEntities = []; // [value]
    const others = [];       // [{ key, value }]

    for (const e of allEntries) {
        const key = e.key;
        if (key.length === 10 && key[8] === 0x2f) {
            const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
            subChunks.push({
                cx: view.getInt32(0, true),
                cz: view.getInt32(4, true),
                subY: new Int8Array([key[9]])[0],
                value: e.value
            });
        } else if (key.length === 9 && key[8] === 0x31) {
            blockEntities.push(e.value);
        } else {
            others.push({ key, value: e.value });
        }
    }

    return { subChunks, blockEntities, others, dbMap, allEntries };
}
```

### 4.2 使用示例

```javascript
const world = await readMcworld(file);

// 遍历所有方块
for (const sc of world.subChunks) {
    const sub = parseSubChunk(sc.value);
    if (!sub) continue;

    for (let li = 0; li < sub.layers.length; li++) {
        const layer = sub.layers[li];
        for (let lx = 0; lx < 16; lx++) for (let ly = 0; ly < 16; ly++) for (let lz = 0; lz < 16; lz++) {
            const palIdx = getBitValue(layer.indexBytes, lx * 256 + lz * 16 + ly, layer.bits);
            if (palIdx < 0 || palIdx >= layer.palette.length) continue;
            const block = layer.palette[palIdx];
            if (block.name === 'minecraft:air') continue;

            const wx = sc.cx * 16 + lx;
            const wy = sc.subY * 16 + ly;
            const wz = sc.cz * 16 + lz;

            console.log('方块', block.name, '位置', wx, wy, wz);
        }
    }
}

// 遍历所有方块实体
for (const beBuf of world.blockEntities) {
    const beList = parseBlockEntities(beBuf);
    for (const be of beList) {
        console.log('BE', be.id.value, '位置', be.x.value, be.y.value, be.z.value);
    }
}
```

## 5. 大文件处理

### 5.1 分批次解压

如果 mcworld 有几百个 `.ldb`，一次性加载会占满内存：

```javascript
async function readMcworldBatched(file, onProgress) {
    const zip = await JSZip.loadAsync(file);
    const ldbFiles = [];
    zip.forEach(path => {
        if (path.startsWith('db/') && path.endsWith('.ldb')) {
            ldbFiles.push(path);
        }
    });

    const allEntries = [];
    for (let i = 0; i < ldbFiles.length; i++) {
        const bytes = await zip.file(ldbFiles[i]).async('uint8array');
        const r = parseSSTable(bytes);
        for (const e of r.entries) allEntries.push(e);

        if (onProgress) onProgress((i + 1) / ldbFiles.length);
        await yieldToUI();   // 让浏览器呼吸
    }
    return allEntries;
}

function yieldToUI() {
    return new Promise(function(r) {
        requestAnimationFrame(function() { setTimeout(r, 0); });
    });
}
```

### 5.2 内存估算

| 存档大小 | 预计内存 |
|---------|---------|
| 10 MB | 30~50 MB |
| 100 MB | 300~500 MB |
| 500 MB | 1.5~2.5 GB（浏览器可能崩） |

**建议**：加进度条 + 超时取消。

## 6. 修改已有 mcworld

### 6.1 整体流程

```
1. 加载 ZIP
2. 解析所有 .ldb → key-value Map
3. 修改 Map（增删改）
4. 重新排序
5. 重新 buildSSTable
6. 替换 ZIP 里的 db/000005.ldb
7. 更新 MANIFEST
8. 重新打包
```

### 6.2 修改示例

```javascript
async function modifyMcworld(file, modifier) {
    const world = await readMcworld(file);

    // 用户自定义修改
    const newEntries = modifier(world.allEntries);

    // 重新生成
    const ldbBytes = buildSSTable(newEntries);

    const sortedKeys = newEntries.map(e => e.key).sort(function(a, b) {
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

    // 从原 ZIP 复制 level.dat
    const zip = new ZipBuilder();
    // 注意：ZipBuilder 需要支持从原 ZIP 复制文件
    // 或者用 JSZip 重新打包
    // ...

    return zip.build();
}
```

## 7. 元数据键的作用

每个 chunk 必须包含以下 7 个元数据键（否则游戏可能不认）：

| Tag | 值 | 作用 |
|-----|-----|------|
| `0x2B` | 540 字节 `04 00` 模式 | 光照数据占位 |
| `0x2C` | `2A` | ChunkVersion = 42 |
| `0x36` | `02 00 00 00` | Data2D |
| `0x3F` | `B5 60 75 FD 69 2A 3C 93` | 生物群系哈希 |
| `0x40` | `00 0A` | 未知 |
| `0x41` | `00` | 未知 |
| `0x77` | 空 | 未知 |

**⚠️ 缺任何一个会怎样**：

| 缺失 | 后果 |
|------|------|
| `0x2B` | 光照错乱，可能黑屏 |
| `0x2C` | 游戏可能不认这个 chunk |
| `0x36` | chunk 加载失败 |
| `0x3F` | 生物群系异常 |
| 其他 | 一般无影响，但建议保留 |

## 8. 常见问题

### 8.1 生成的 mcworld 打开后地形异常

**排查**：

1. 检查 `level.dat` 的 `Generator` 是否 = 2
2. 检查 `FlatWorldLayers` JSON 是否正确
3. 检查 SubChunk 索引顺序（XZY）

### 8.2 命令方块变石头

**排查**：

1. 检查 `block_position_data` 的键格式（必须是 `"sx,sy,sz"`）
2. 检查 `0x31` 键的值是否是合法 NBT 拼接
3. 检查 BE 内 x/y/z 是否是世界坐标

### 8.3 水面/雪/草丢失

**排查**：

1. 检查是否处理了 layer 1
2. 检查 layer 1 是否被当作全空
3. 检查 `layerCount` 是否正确

### 8.4 部分 chunk 丢失

**排查**：

1. 检查 `0x2C`（ChunkVersion）是否存在
2. 检查 entries 是否排序正确
3. 检查 MANIFEST 的 smallest/largest key

### 8.5 打开后立刻崩溃

**排查**：

1. 检查 SSTable 的 Footer 魔数
2. 检查 CRC 计算范围
3. 检查压缩类型（用 0 或 4，不用 1）

## 9. 自检清单

- [ ] `level.dat` 的 8 字节头正确
- [ ] `level.dat` 的 `lastOpenedWithVersion` 是 List\<Int\>
- [ ] `level.dat` 的 `SpawnY` = 32767
- [ ] `level.dat` 的 `Generator` = 2
- [ ] 每个 chunk 都写了全部 7 个元数据键
- [ ] entries 按 key 字节序排序
- [ ] SSTable 的 key 有 8 字节 internal key 尾部
- [ ] MANIFEST 的 smallest/largest key **没有** 8 字节尾部
- [ ] CURRENT 是 `"MANIFEST-000004\n"`
- [ ] CURRENT 里的文件名和实际 MANIFEST 文件名匹配
- [ ] MANIFEST 里的 file_number 和实际 .ldb 文件名匹配
- [ ] ZIP 用 `/` 分隔路径
- [ ] 有 `levelname.txt` 且与 `LevelName` 一致

## 10. 参考

- Bedrock level format：https://minecraft.fandom.com/wiki/Bedrock_Edition_level_format
- LevelDB：https://github.com/google/leveldb
