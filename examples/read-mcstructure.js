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
        // ★ 修复：palette 条目是对象 {name: {type, value}, states: {...}, version: {...}}
        // 不是数组，不能用 p.find(...)
        const name = p.name.value;
        console.log(' ', i, ':', name);
    }

    console.log('\n=== 方块统计 ===');
    const biItems = root.structure.value.block_indices.value.items;
    const blockIndices0 = biItems[0].items || biItems[0];

    const counts = {};
    for (let i = 0; i < blockIndices0.length; i++) {
        const idx = blockIndices0[i];
        if (idx < 0) continue;
        // ★ 修复：同上，用 p.name.value
        const name = palette[idx].name.value;
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
            // ★ 键是扁平索引字符串，反推坐标
            const structIdx = parseInt(key, 10);
            let coordStr = '';
            if (!isNaN(structIdx)) {
                const sx = Math.floor(structIdx / (sizeY * sizeZ));
                const rem = structIdx % (sizeY * sizeZ);
                const sy = Math.floor(rem / sizeZ);
                const sz = rem % sizeZ;
                coordStr = ' → (' + sx + ',' + sy + ',' + sz + ')';
            }

            const beData = bpd.value[key].value.block_entity_data.value;
            const id = beData.id ? beData.id.value : '(无)';
            console.log(' "' + key + '"' + coordStr + ' → ' + id);

            if (id === 'CommandBlock') {
                const cmd = beData.Command ? beData.Command.value : '(空)';
                console.log('    指令:', cmd);
                if (beData.auto) {
                    console.log('    模式:', beData.auto.value === 1 ? '自动' : '红石控制');
                }
            }
            if (id === 'Sign' && beData.FrontText) {
                console.log('    正面:', beData.FrontText.value.Text.value);
            }
            if (id === 'Chest' && beData.Items) {
                const items = beData.Items.value.items || [];
                console.log('    物品数:', items.length);
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
