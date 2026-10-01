// examples/read-mcworld.js
// 读取 .mcworld 里的所有方块和方块实体

const fs = require('fs');
const JSZip = require('jszip');
const u = require('./utils');

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
        const r = u.parseSSTable(bytes);
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
        const sub = u.parseSubChunk(sc.value);
        if (!sub) continue;

        for (let li = 0; li < sub.layers.length; li++) {
            const layer = sub.layers[li];

            for (let lx = 0; lx < 16; lx++) for (let ly = 0; ly < 16; ly++) for (let lz = 0; lz < 16; lz++) {
                const palIdx = u.getBitValue(layer.indexBytes, lx * 256 + lz * 16 + ly, layer.bits);
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
        const beList = u.parseBlockEntities(beBuf);
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
