// examples/write-mcworld.js
// 从零生成一个简单的 .mcworld：一个 16×4×16 的石头平台 + 一个命令方块

const fs = require('fs');
const u = require('./utils');

async function writeMcworld(outputPath) {
    // ---- Step 1: 准备方块数据 ----
    const cx = 0, cz = 0, subY = -4;

    const layer0Blocks = [];

    // 石头平台：Y = 0，X = 0~15，Z = 0~15
    for (let lx = 0; lx < 16; lx++) {
        for (let lz = 0; lz < 16; lz++) {
            layer0Blocks.push({
                x: lx, y: 0, z: lz,
                name: 'minecraft:stone',
                states: {}
            });
        }
    }

    // 命令方块：Y = 1，X = 8，Z = 8
    layer0Blocks.push({
        x: 8, y: 1, z: 8,
        name: 'minecraft:command_block',
        states: {
            conditional_bit: { type: 'Byte', value: 0 },
            facing_direction: { type: 'Int', value: 0 }
        }
    });

    // ---- Step 2: 序列化 SubChunk ----
    const subChunkBytes = u.serializeSubChunk(subY, [layer0Blocks]);

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

    const beBytes = u.bSerializeBE(beEntries);

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

    entries.push({
        key: makeKey(cx, cz, 0x2f, subY & 0xFF),
        value: subChunkBytes
    });

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
    const ldbBytes = u.buildSSTable(entries);
    console.log('SSTable:', ldbBytes.length, '字节');

    // ---- Step 6: 生成 MANIFEST ----
    const sortedKeys = entries.map(e => e.key).sort(function(a, b) {
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) {
            if (a[i] !== b[i]) return a[i] - b[i];
        }
        return a.length - b.length;
    });

    const manifestRaw = u.buildManifestBytes(
        0, 5, ldbBytes.length,
        sortedKeys[0], sortedKeys[sortedKeys.length - 1]
    );
    const manifestBytes = u.buildLogRecord(new Uint8Array(manifestRaw), 1);

    // ---- Step 7: level.dat ----
    const levelDat = u.buildLevelDat('Test World', 0, -60, 0);

    // ---- Step 8: ZIP ----
    const zip = new u.ZipBuilder();
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
