// examples/write-mcstructure.js
// 从零生成一个 .mcstructure：16×4×16 石头平台 + 红石控制命令方块 + 上方石头按钮

const fs = require('fs');
const u = require('./utils');

function writeMcstructure(outputPath) {
    const sizeX = 16, sizeY = 4, sizeZ = 16;
    const totalBlocks = sizeX * sizeY * sizeZ;

    // ---- 调色板 ----
    const palette = [
        { name: 'minecraft:air', states: {} },
        { name: 'minecraft:stone', states: {} },
        { name: 'minecraft:command_block', states: {
            conditional_bit: { type: 'Byte', value: 0 },
            facing_direction: { type: 'Int', value: 0 }
        }},
        { name: 'minecraft:stone_button', states: {
            facing_direction: { type: 'Int', value: 1 },
            button_pressed_bit: { type: 'Byte', value: 0 },
            toggle_bit: { type: 'Byte', value: 0 }
        }}
    ];

    // ---- 索引数组 ----
    const indices0 = new Int32Array(totalBlocks).fill(-1);

    // 石头平台：Y = 0，X = 0~15，Z = 0~15
    for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
            const idx = (x * sizeY + 0) * sizeZ + z;
            indices0[idx] = 1;   // stone
        }
    }
    console.log('放置石头: 256 个');

    // 命令方块：Y = 1，X = 8，Z = 8
    const cmdIdx = (8 * sizeY + 1) * sizeZ + 8;
    indices0[cmdIdx] = 2;   // command_block
    console.log('放置命令方块 @ (8, 1, 8) - 红石控制');

    // 石头按钮：Y = 2，X = 8，Z = 8
    const btnIdx = (8 * sizeY + 2) * sizeZ + 8;
    indices0[btnIdx] = 3;   // stone_button
    console.log('放置石头按钮 @ (8, 2, 8)');

    const indices1 = new Int32Array(totalBlocks).fill(-1);

    // ---- 调色板 NBT ----
    const paletteEntries = palette.map(function(p) {
        const stateEntries = Object.keys(p.states).map(function(k) {
            const tag = p.states[k];
            return { name: k, type: u.NBT_TYPE_IDS[tag.type] || 3, value: tag.value };
        });
        return [
            { name: 'name', type: 8, value: p.name },
            { name: 'states', type: 10, value: stateEntries },
            { name: 'version', type: 3, value: 18168865 }
        ];
    });

    // ---- 命令方块 BE（结构相对坐标） ----
    const be = [
        { name: 'id', type: 8, value: 'CommandBlock' },
        { name: 'x', type: 3, value: 8 },              // 结构相对坐标
        { name: 'y', type: 3, value: 1 },
        { name: 'z', type: 3, value: 8 },
        { name: 'isMovable', type: 1, value: 1 },
        { name: 'Command', type: 8, value: 'say hello' },
        { name: 'CustomName', type: 8, value: '' },
        { name: 'ExecuteOnFirstTick', type: 1, value: 0 },
        { name: 'LastExecution', type: 4, value: 0 },
        { name: 'LPCommandMode', type: 3, value: 0 },
        { name: 'LPCondionalMode', type: 1, value: 0 },
        { name: 'LPRedstoneMode', type: 1, value: 0 },
        { name: 'SuccessCount', type: 3, value: 0 },
        { name: 'TickDelay', type: 3, value: 0 },
        { name: 'TrackOutput', type: 1, value: 1 },
        { name: 'Version', type: 3, value: 19 },
        { name: 'auto', type: 1, value: 0 },
        { name: 'conditionMet', type: 1, value: 0 },
        { name: 'powered', type: 1, value: 0 }
    ];

    // ★★★ 关键：block_position_data 的键是扁平索引（String(structIdx)）★★★
    const structIdx = (8 * sizeY + 1) * sizeZ + 8;   // = 536
    console.log('命令方块扁平索引: ' + structIdx);

    const bpEntries = [
        {
            name: String(structIdx),     // ★ 键是 "536"，不是 "8,1,8"
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
    const nbtBytes = u.bSerializeBE(root);
    fs.writeFileSync(outputPath, nbtBytes);
    console.log('写入:', outputPath, '(', nbtBytes.length, '字节)');

    // ---- 生成后自检 ----
    console.log('\n=== 自检 ===');
    const check = u.parseNbt(nbtBytes, 0);
    const checkBpd = check.value.structure.value.palette.value.default.value.block_position_data;
    if (checkBpd && checkBpd.value) {
        const keys = Object.keys(checkBpd.value);
        console.log('block_position_data 条目数: ' + keys.length);
        for (const key of keys) {
            const beCheck = checkBpd.value[key].value.block_entity_data.value;
            console.log('  "' + key + '" → id=' + (beCheck.id ? beCheck.id.value : '(无)'));
            if (beCheck.Command) {
                console.log('      Command: ' + beCheck.Command.value);
            } else {
                console.log('      ⚠️ Command 字段丢失！');
            }
        }
    } else {
        console.log('⚠️ block_position_data 为空或不存在');
    }
}

const outputPath = process.argv[2] || 'test.mcstructure';
writeMcstructure(outputPath);
