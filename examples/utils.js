// examples/utils.js
// Minecraft 基岩版 .mcworld / .mcstructure 编解码工具库
// UMD：同时支持 Node.js（require）和浏览器（全局 McCodec）
//
// 使用：
//   Node.js:  const u = require('./utils');
//   浏览器:   <script src="../examples/utils.js"></script>
//            const u = window.McCodec;

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        // Node.js
        module.exports = factory();
    } else {
        // 浏览器：暴露到 window.McCodec
        root.McCodec = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {

// ============================================================
// NBT 类型表
// ============================================================

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

// ============================================================
// NBT 解析
// ============================================================

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
                    if (t === 0) break;
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
        bytesRead: pos - offset
    };
}

// 解析结果 → 写入格式
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

// 过滤版本（用于 BE，去掉 LastOutput）
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

// ============================================================
// NBT 写入
// ============================================================

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
            a.push(0);
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

// ============================================================
// CRC32C
// ============================================================

const CRC32C_TABLE = (function() {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
            c = (c & 1) ? (0x82F63B78 ^ (c >>> 1)) : (c >>> 1);
        }
        t[i] = c;
    }
    return t;
})();

function crc32c(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc = CRC32C_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function maskedCRC32C(data) {
    const crc = crc32c(data);
    return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

// ============================================================
// VarInt
// ============================================================

function writeVarInt(buf, value) {
    while (value >= 0x80) {
        buf.push((value & 0x7F) | 0x80);
        value >>>= 7;
    }
    buf.push(value & 0x7F);
}

function readVarInt(data, pos) {
    let result = 0, shift = 0, bytes = 0;
    while (true) {
        const b = data[pos + bytes];
        result |= (b & 0x7F) << shift;
        bytes++;
        if ((b & 0x80) === 0) break;
        shift += 7;
        if (bytes > 5) throw new Error('VarInt too long');
    }
    return { value: result >>> 0, bytes };
}

// ============================================================
// 位打包
// ============================================================

function getBitValue(buf, index, bits) {
    if (bits === 0) return 0;
    const totalBit = index * bits;
    let byteIdx = totalBit >> 3;
    let bitOff = totalBit & 7;
    let remaining = bits;
    let value = 0;
    let shift = 0;
    while (remaining > 0) {
        const bitsAvailable = 8 - bitOff;
        const bitsToRead = Math.min(bitsAvailable, remaining);
        const mask = (1 << bitsToRead) - 1;
        value |= ((buf[byteIdx] >> bitOff) & mask) << shift;
        shift += bitsToRead;
        remaining -= bitsToRead;
        byteIdx++;
        bitOff = 0;
    }
    return value;
}

function packBitValue(buf, index, value, bits) {
    if (bits === 0) return;
    const totalBit = index * bits;
    let byteIdx = totalBit >> 3;
    let bitOff = totalBit & 7;
    let remaining = bits;
    let v = value;
    while (remaining > 0) {
        const bitsAvailable = 8 - bitOff;
        const bitsToWrite = Math.min(bitsAvailable, remaining);
        const mask = ((1 << bitsToWrite) - 1) << bitOff;
        buf[byteIdx] = (buf[byteIdx] & ~mask) | ((v & ((1 << bitsToWrite) - 1)) << bitOff);
        v >>>= bitsToWrite;
        remaining -= bitsToWrite;
        byteIdx++;
        bitOff = 0;
    }
}

// ============================================================
// 压缩（Snappy 保留兼容 + zlib/raw deflate 兜底）
// ============================================================

function snappyDecompress(input) {
    let ip = 0, outLen = 0, shift = 0;
    while (true) {
        const b = input[ip++];
        outLen |= (b & 0x7F) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
    }
    const output = new Uint8Array(outLen);
    let op = 0;
    while (ip < input.length) {
        const tag = input[ip++];
        const type = tag & 3;
        if (type === 0) {
            let len = (tag >> 2) + 1;
            if (len > 60) {
                const extra = len - 60;
                len = 0;
                for (let i = 0; i < extra; i++) len |= input[ip++] << (i * 8);
                len += 1;
            }
            output.set(input.slice(ip, ip + len), op);
            ip += len;
            op += len;
        } else {
            let offset, len;
            if (type === 1) {
                len = ((tag >> 2) & 0x7) + 4;
                offset = ((tag >> 5) << 8) | input[ip++];
            } else if (type === 2) {
                len = (tag >> 2) + 1;
                offset = input[ip++] | (input[ip++] << 8);
            } else {
                len = (tag >> 2) + 1;
                offset = input[ip++] | (input[ip++] << 8) |
                         (input[ip++] << 16) | (input[ip++] << 24);
            }
            for (let i = 0; i < len; i++) {
                output[op] = output[op - offset];
                op++;
            }
        }
    }
    return output;
}

let _pako = null;
function _getPako() {
    if (_pako) return _pako;
    // 浏览器：全局 pako
    if (typeof pako !== 'undefined') { _pako = pako; return _pako; }
    // Node.js：require
    if (typeof module === 'object' && module.exports) {
        try { _pako = require('pako'); } catch (e) { _pako = null; }
    }
    return _pako;
}

function decompressBlock(data, type) {
    if (type === 0) return data;
    if (type === 1) return snappyDecompress(data);
    const pako = _getPako();
    if (type === 2) {
        if (pako) return pako.inflate(data);
        throw new Error('pako 未加载');
    }
    if (type === 3 || type === 4) {
        if (pako) return pako.inflateRaw(data);
        throw new Error('pako 未加载');
    }
    if (pako) {
        try { return pako.inflateRaw(data); } catch (e) {}
        try { return pako.inflate(data); } catch (e) {}
    }
    return data;
}

// ============================================================
// SSTable
// ============================================================

function parseBlockEntries(blockData) {
    const len = blockData.length;
    if (len < 4) return [];
    const view = new DataView(blockData.buffer, blockData.byteOffset, blockData.byteLength);
    const numRestarts = view.getUint32(len - 4, true);
    const restartsStart = len - 4 - numRestarts * 4;
    const entries = [];
    let pos = 0, lastKey = new Uint8Array(0);
    while (pos < restartsStart) {
        try {
            const shared = readVarInt(blockData, pos); pos += shared.bytes;
            const nonShared = readVarInt(blockData, pos); pos += nonShared.bytes;
            const valueLen = readVarInt(blockData, pos); pos += valueLen.bytes;
            if (pos + nonShared.value + valueLen.value > restartsStart) break;
            const keyDelta = blockData.slice(pos, pos + nonShared.value); pos += nonShared.value;
            const value = blockData.slice(pos, pos + valueLen.value); pos += valueLen.value;
            const key = new Uint8Array(shared.value + nonShared.value);
            key.set(lastKey.slice(0, shared.value), 0);
            key.set(keyDelta, shared.value);
            if (key.length >= 8) {
                entries.push({ key: key.slice(0, key.length - 8), value });
            }
            lastKey = key;
        } catch (e) { break; }
    }
    return entries;
}

function readBlock(buffer, offset, size) {
    const dataEnd = offset + size;
    if (dataEnd > buffer.length) return [];
    const compressionType = buffer[dataEnd];
    let blockData = buffer.slice(offset, dataEnd);
    try { blockData = decompressBlock(blockData, compressionType); } catch (e) { return []; }
    return parseBlockEntries(blockData);
}

function parseSSTable(buffer) {
    const result = { entries: [], magicOK: false, indexCount: 0, dataBlockOK: 0, dataBlockFail: 0 };
    if (buffer.length < 48) return result;
    const footerStart = buffer.length - 48;
    const magic = [0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb];
    for (let i = 0; i < 8; i++) {
        if (buffer[footerStart + 40 + i] !== magic[i]) return result;
    }
    result.magicOK = true;

    let pos = footerStart;
    function readAt() {
        const r = readVarInt(buffer, pos);
        pos += r.bytes;
        return r.value;
    }
    try {
        readAt(); readAt();
        const indexOffset = readAt();
        const indexSize = readAt();
        if (indexOffset >= buffer.length || indexSize <= 0) return result;

        const indexEntries = readBlock(buffer, indexOffset, indexSize);
        result.indexCount = indexEntries.length;
        for (const idx of indexEntries) {
            let p = 0;
            const dOff = readVarInt(idx.value, p); p += dOff.bytes;
            const dSize = readVarInt(idx.value, p); p += dSize.bytes;
            const dataEntries = readBlock(buffer, dOff.value, dSize.value);
            if (dataEntries.length > 0) result.dataBlockOK++;
            else result.dataBlockFail++;
            for (const de of dataEntries) result.entries.push(de);
        }
    } catch (e) {}
    return result;
}

function buildSSTable(entries) {
    const sorted = entries.slice().sort(function(a, b) {
        const n = Math.min(a.key.length, b.key.length);
        for (let i = 0; i < n; i++) {
            if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
        }
        return a.key.length - b.key.length;
    });

    function makeInternalKey(userKey) {
        const ik = new Uint8Array(userKey.length + 8);
        ik.set(userKey, 0);
        ik[userKey.length] = 1;
        return ik;
    }

    function blockWithTrailer(blockBytes) {
        const crcInput = new Uint8Array(blockBytes.length + 1);
        crcInput.set(blockBytes, 0);
        crcInput[blockBytes.length] = 0;
        const crc = maskedCRC32C(crcInput);
        const result = new Uint8Array(blockBytes.length + 5);
        result.set(blockBytes, 0);
        result[blockBytes.length] = 0;
        result[blockBytes.length + 1] = crc & 0xFF;
        result[blockBytes.length + 2] = (crc >>> 8) & 0xFF;
        result[blockBytes.length + 3] = (crc >>> 16) & 0xFF;
        result[blockBytes.length + 4] = (crc >>> 24) & 0xFF;
        return result;
    }

    function encodeHandle(offset, size) {
        const buf = [];
        writeVarInt(buf, offset);
        writeVarInt(buf, size);
        return new Uint8Array(buf);
    }

    function buildBlock(blockEntries) {
        const blockData = [];
        const restarts = [];
        for (const item of blockEntries) {
            restarts.push(blockData.length);
            writeVarInt(blockData, 0);
            writeVarInt(blockData, item.key.length);
            writeVarInt(blockData, item.value.length);
            for (let i = 0; i < item.key.length; i++) blockData.push(item.key[i]);
            for (let i = 0; i < item.value.length; i++) blockData.push(item.value[i]);
        }
        for (const r of restarts) {
            blockData.push(r & 0xFF, (r >>> 8) & 0xFF, (r >>> 16) & 0xFF, (r >>> 24) & 0xFF);
        }
        blockData.push(
            restarts.length & 0xFF,
            (restarts.length >>> 8) & 0xFF,
            (restarts.length >>> 16) & 0xFF,
            (restarts.length >>> 24) & 0xFF
        );
        return new Uint8Array(blockData);
    }

    const BLOCK_TARGET = 4096;
    const groups = [];
    let current = [], currentSize = 0;
    for (const entry of sorted) {
        const ik = makeInternalKey(entry.key);
        const est = 15 + ik.length + entry.value.length;
        if (currentSize + est > BLOCK_TARGET && current.length > 0) {
            groups.push(current);
            current = [];
            currentSize = 0;
        }
        current.push({ key: ik, value: entry.value });
        currentSize += est;
    }
    if (current.length > 0) groups.push(current);

    const dataBlocks = [];
    for (const group of groups) {
        dataBlocks.push({
            bytes: buildBlock(group),
            lastKey: group[group.length - 1].key
        });
    }

    const metaIndexBlockBytes = buildBlock([]);
    const metaIndexBlockWithTrailer = blockWithTrailer(metaIndexBlockBytes);

    const dataBlockOffsets = [];
    let offset = 0;
    for (const b of dataBlocks) {
        dataBlockOffsets.push(offset);
        offset += b.bytes.length + 5;
    }
    const indexEntries = [];
    for (let i = 0; i < dataBlocks.length; i++) {
        const handle = encodeHandle(dataBlockOffsets[i], dataBlocks[i].bytes.length);
        indexEntries.push({ key: dataBlocks[i].lastKey, value: handle });
    }
    const indexBlockBytes = buildBlock(indexEntries);
    const indexBlockWithTrailer = blockWithTrailer(indexBlockBytes);

    const metaIndexBlockOffset = offset;
    const indexBlockOffset = metaIndexBlockOffset + metaIndexBlockWithTrailer.length;

    const footerBuf = [];
    writeVarInt(footerBuf, metaIndexBlockOffset);
    writeVarInt(footerBuf, metaIndexBlockBytes.length);
    writeVarInt(footerBuf, indexBlockOffset);
    writeVarInt(footerBuf, indexBlockBytes.length);
    while (footerBuf.length < 40) footerBuf.push(0);
    footerBuf.push(0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb);

    const pieces = [];
    for (const b of dataBlocks) pieces.push(blockWithTrailer(b.bytes));
    pieces.push(metaIndexBlockWithTrailer);
    pieces.push(indexBlockWithTrailer);
    pieces.push(new Uint8Array(footerBuf));

    let total = 0;
    for (const p of pieces) total += p.length;
    const result = new Uint8Array(total);
    let off = 0;
    for (const p of pieces) {
        result.set(p, off);
        off += p.length;
    }
    return result;
}

// ============================================================
// MANIFEST + LogRecord
// ============================================================

function buildManifestBytes(logNumber, fileNumber, fileSize, smallestKey, largestKey) {
    const m = [];

    writeVarInt(m, 1);
    const cmp = 'leveldb.BytewiseComparator';
    writeVarInt(m, cmp.length);
    for (let i = 0; i < cmp.length; i++) m.push(cmp.charCodeAt(i));

    writeVarInt(m, 2); writeVarInt(m, logNumber);

    writeVarInt(m, 7);
    writeVarInt(m, 0);
    writeVarInt(m, fileNumber);
    writeVarInt(m, fileSize);
    writeVarInt(m, smallestKey.length);
    for (let i = 0; i < smallestKey.length; i++) m.push(smallestKey[i]);
    writeVarInt(m, largestKey.length);
    for (let i = 0; i < largestKey.length; i++) m.push(largestKey[i]);

    writeVarInt(m, 6); writeVarInt(m, 2);
    writeVarInt(m, 3); writeVarInt(m, fileNumber + 1);

    return m;
}

function buildLogRecord(data, type) {
    if (type === undefined) type = 1;
    const header = new Uint8Array(7);
    const dv = new DataView(header.buffer);
    dv.setUint16(4, data.length, true);
    header[6] = type;

    const crcRange = new Uint8Array(1 + data.length);
    crcRange[0] = type;
    crcRange.set(data, 1);
    dv.setUint32(0, maskedCRC32C(crcRange), true);

    const result = new Uint8Array(7 + data.length);
    result.set(header);
    result.set(data, 7);
    return result;
}

// ============================================================
// level.dat
// ============================================================

function buildLevelDat(worldName, spawnX, spawnY, spawnZ) {
    const flatLayersJson = JSON.stringify({
        biome_id: 1,
        block_layers: [
            { block_name: "minecraft:bedrock", count: 1 },
            { block_name: "minecraft:dirt", count: 2 },
            { block_name: "minecraft:grass_block", count: 1 }
        ],
        encoding_version: 6,
        preset_id: "ClassicFlat",
        world_version: "version.post_1_18"
    }) + "\n";

    function intList(values) { return { itemType: 3, items: values }; }

    const root = [
        { name: 'LevelName', type: 8, value: worldName || 'Structure World' },
        { name: 'GameType', type: 3, value: 1 },
        { name: 'Difficulty', type: 3, value: 0 },
        { name: 'RandomSeed', type: 4, value: 12345 },
        { name: 'SpawnX', type: 3, value: spawnX || 0 },
        { name: 'SpawnY', type: 3, value: 32767 },
        { name: 'SpawnZ', type: 3, value: spawnZ || 0 },
        { name: 'Generator', type: 3, value: 2 },
        { name: 'FlatWorldLayers', type: 8, value: flatLayersJson },
        { name: 'StorageVersion', type: 3, value: 10 },
        { name: 'baseGameVersion', type: 8, value: '*' },
        { name: 'WorldVersion', type: 3, value: 1 },
        { name: 'NetworkVersion', type: 3, value: 2168 },
        { name: 'InventoryVersion', type: 8, value: '1.19.10' },
        { name: 'BiomeOverride', type: 8, value: 'minecraft:minecraft:' },
        { name: 'lastOpenedWithVersion', type: 9, value: intList([1, 19, 10, 3, 0]) },
        { name: 'MinimumCompatibleClientVersion', type: 9, value: intList([1, 19, 10, 0, 0]) },
        { name: 'showcoordinates', type: 1, value: 1 },
        { name: 'commandsEnabled', type: 1, value: 1 },
        { name: 'hasBeenLoadedInCreative', type: 1, value: 1 }
    ];

    const nbtBytes = bSerializeBE(root);
    const header = new Uint8Array(8);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, 10, true);
    dv.setUint32(4, nbtBytes.length, true);

    const result = new Uint8Array(8 + nbtBytes.length);
    result.set(header);
    result.set(nbtBytes, 8);
    return result;
}

// ============================================================
// SubChunk
// ============================================================

function parseSubChunk(data) {
    try {
        let pos = 0;
        const version = data[pos++];
        const layerCount = data[pos++];
        let subY = 0;
        if (version === 9) subY = new Int8Array([data[pos++]])[0];

        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const layers = [];

        for (let li = 0; li < layerCount; li++) {
            if (pos >= data.length) break;
            const storageFormat = data[pos++];
            const bits = storageFormat >> 1;
            const indexByteCount = (4096 * bits) >> 3;
            const indexBytes = data.slice(pos, pos + indexByteCount);
            pos += indexByteCount;

            const paletteCount = view.getUint32(pos, true);
            pos += 4;

            const palette = [];
            for (let i = 0; i < paletteCount; i++) {
                const nbt = parseNbt(data, pos);
                pos += nbt.bytesRead;
                palette.push({
                    name: nbt.value.name.value,
                    states: nbt.value.states.value,
                    version: nbt.value.version ? nbt.value.version.value : 18168865
                });
            }
            layers.push({ bits, indexBytes, palette });
        }

        const l0 = layers[0] || { bits: 0, indexBytes: new Uint8Array(0), palette: [] };
        return {
            version, subY, layerCount, layers,
            bits: l0.bits,
            indexBytes: l0.indexBytes,
            palette: l0.palette
        };
    } catch (e) { return null; }
}

function serializeSubChunk(subY, layerBlockLists) {
    const buf = [];
    buf.push(9);
    buf.push(layerBlockLists.length);
    buf.push(subY & 0xFF);

    for (const blocks of layerBlockLists) {
        const localPalette = [];
        const palMap = new Map();

        function addPal(name, states) {
            const stateKeys = Object.keys(states || {}).sort()
                .map(k => k + '=' + states[k].type + ':' + states[k].value)
                .join(',');
            const key = name + '|' + stateKeys;
            if (palMap.has(key)) return palMap.get(key);
            const stateEntries = Object.keys(states || {}).map(k => {
                const tag = states[k];
                return { name: k, type: NBT_TYPE_IDS[tag.type] || 3, value: tag.value };
            });
            localPalette.push(bSerializeBE([
                { name: 'name', type: 8, value: name },
                { name: 'states', type: 10, value: stateEntries },
                { name: 'version', type: 3, value: 18168865 }
            ]));
            const idx = localPalette.length - 1;
            palMap.set(key, idx);
            return idx;
        }

        addPal('minecraft:air', {});
        for (const b of blocks) addPal(b.name, b.states);

        const pc = localPalette.length;
        const bits = pc <= 1 ? 0 : (pc <= 4 ? 2 : (pc <= 16 ? 4 : 8));
        const indexByteCount = (4096 * bits) >> 3;
        const indexBytes = new Uint8Array(indexByteCount);

        for (const b of blocks) {
            const localIdx = addPal(b.name, b.states);
            packBitValue(indexBytes, b.x * 256 + b.z * 16 + b.y, localIdx, bits);
        }

        buf.push((bits << 1) | 0);
        for (let i = 0; i < indexBytes.length; i++) buf.push(indexBytes[i]);
        buf.push(pc & 0xFF, (pc >> 8) & 0xFF, (pc >> 16) & 0xFF, (pc >> 24) & 0xFF);
        for (const pe of localPalette) {
            for (let i = 0; i < pe.length; i++) buf.push(pe[i]);
        }
    }
    return new Uint8Array(buf);
}

// ============================================================
// BlockEntity
// ============================================================

function parseBlockEntities(buf) {
    const result = [];
    let p = 0;
    while (p < buf.length) {
        try {
            const nbt = parseNbt(buf, p);
            if (nbt.bytesRead <= 0) break;
            p += nbt.bytesRead;
            result.push(nbt.value);
        } catch (e) { break; }
    }
    return result;
}

const BLOCK_TO_BE_ID = {
    'minecraft:command_block': 'CommandBlock',
    'minecraft:chain_command_block': 'CommandBlock',
    'minecraft:repeating_command_block': 'CommandBlock',
    'minecraft:standing_sign': 'Sign',
    'minecraft:wall_sign': 'Sign',
    'minecraft:hanging_sign': 'Sign',
    'minecraft:wall_hanging_sign': 'Sign',
    'minecraft:chest': 'Chest',
    'minecraft:trapped_chest': 'Chest',
    'minecraft:barrel': 'Barrel',
    'minecraft:hopper': 'Hopper',
    'minecraft:furnace': 'Furnace',
    'minecraft:lit_furnace': 'Furnace',
    'minecraft:blast_furnace': 'BlastFurnace',
    'minecraft:lit_blast_furnace': 'BlastFurnace',
    'minecraft:smoker': 'Smoker',
    'minecraft:lit_smoker': 'Smoker',
    'minecraft:dispenser': 'Dispenser',
    'minecraft:dropper': 'Dropper',
    'minecraft:brewing_stand': 'BrewingStand',
    'minecraft:enchanting_table': 'EnchantTable',
    'minecraft:beacon': 'Beacon',
    'minecraft:jukebox': 'Jukebox',
    'minecraft:mob_spawner': 'MobSpawner',
    'minecraft:noteblock': 'Music',
    'minecraft:end_portal': 'EndPortal',
    'minecraft:end_gateway': 'EndGateway',
    'minecraft:skull': 'Skull',
    'minecraft:flower_pot': 'FlowerPot',
    'minecraft:campfire': 'Campfire',
    'minecraft:soul_campfire': 'Campfire',
    'minecraft:lectern': 'Lectern',
    'minecraft:bed': 'Bed',
    'minecraft:conduit': 'Conduit',
    'minecraft:bell': 'Bell',
    'minecraft:structure_block': 'StructureBlock',
    'minecraft:jigsaw': 'JigsawBlock',
    'minecraft:pistonarmcollision': 'PistonArm',
    'minecraft:sticky_pistonarmcollision': 'PistonArm',
    'minecraft:cauldron': 'Cauldron',
    'minecraft:lava_cauldron': 'Cauldron'
};

// ============================================================
// ZIP
// ============================================================

class ZipBuilder {
    constructor() {
        this.files = [];
        this.centralDir = [];
        this.offset = 0;
    }

    addFile(name, data) {
        const nameBytes = new TextEncoder().encode(name);
        const crc = this._crc32(data);
        const size = data.length;

        const local = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0, true);
        lv.setUint16(8, 0, true);
        lv.setUint16(10, 0, true);
        lv.setUint16(12, 0, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, size, true);
        lv.setUint32(22, size, true);
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true);
        local.set(nameBytes, 30);

        const localHeaderOffset = this.offset;
        this.files.push(local, data);
        this.offset += local.length + size;

        const central = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, 0, true);
        cv.setUint16(14, 0, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, size, true);
        cv.setUint32(24, size, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        cv.setUint32(38, 0, true);
        cv.setUint32(42, localHeaderOffset, true);
        central.set(nameBytes, 46);
        this.centralDir.push(central);
    }

    _crc32(data) {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < data.length; i++) {
            crc ^= data[i];
            for (let j = 0; j < 8; j++) {
                crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
            }
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    build() {
        const centralOffset = this.offset;
        let centralSize = 0;
        for (const c of this.centralDir) centralSize += c.length;

        const end = new Uint8Array(22);
        const ev = new DataView(end.buffer);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(4, 0, true);
        ev.setUint16(6, 0, true);
        ev.setUint16(8, this.centralDir.length, true);
        ev.setUint16(10, this.centralDir.length, true);
        ev.setUint32(12, centralSize, true);
        ev.setUint32(16, centralOffset, true);
        ev.setUint16(20, 0, true);

        const parts = this.files.concat(this.centralDir, [end]);
        let total = 0;
        for (const p of parts) total += p.length;

        const out = new Uint8Array(total);
        let pos = 0;
        for (const p of parts) {
            out.set(p, pos);
            pos += p.length;
        }
        return out;
    }
}

// ============================================================
// 导出（UMD factory 的返回值）
// ============================================================

return {
    // NBT
    NBT_TYPE_NAMES,
    NBT_TYPE_IDS,
    parseNbt,
    parsedToWriterEntries,
    parsedToWriterEntriesFiltered,
    bPutU16, bPutI32, bPutStr, bPutTag, bPutVal,
    bSerializeBE,

    // CRC
    crc32c,
    maskedCRC32C,

    // VarInt
    writeVarInt,
    readVarInt,

    // 位打包
    getBitValue,
    packBitValue,

    // 压缩
    snappyDecompress,
    decompressBlock,

    // SSTable
    parseSSTable,
    buildSSTable,

    // MANIFEST
    buildManifestBytes,
    buildLogRecord,

    // level.dat
    buildLevelDat,

    // SubChunk
    parseSubChunk,
    serializeSubChunk,

    // BlockEntity
    parseBlockEntities,
    BLOCK_TO_BE_ID,

    // ZIP
    ZipBuilder
};

}));
