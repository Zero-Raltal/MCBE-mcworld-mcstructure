// examples/read-mcstructure.js
// 读取 .mcstructure，输出方块统计和所有 BE

const fs = require('fs');
const u = require('./utils');

function readMcstructure(filePath) {
    const buffer = fs.readFileSync(filePath);
    const bytes = new Uint8Array(buffer);

    const nbt = u.parseNbt(bytes, 0);
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
