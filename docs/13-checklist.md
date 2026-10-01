# 13 - Agent 自检清单

> 完成任务前，逐条核对。这是所有其他文档的自检清单的**汇总**。

## 1. NBT 编码（`01-nbt.md`）

- [ ] `TAG_String` 的长度前缀用的是 **uint16**
- [ ] `TAG_List` / `TAG_ByteArray` / `TAG_IntArray` 的长度前缀用的是 **int32**
- [ ] 所有数值都按小端序读写（`DataView.getXxx(pos, true)`）
- [ ] 根 TAG 名称是空字符串，类型是 Compound (10)
- [ ] `TAG_Long` 用 BigInt 或字符串保存（避免精度丢失）
- [ ] 写入时 `type` 是数字 ID（不是 'String' 这种字符串）
- [ ] Compound 结尾必须写 `0x00` (TAG_End)
- [ ] 空 List 的 `itemType` 用 10

## 2. 底层原语（`02-primitives.md`）

- [ ] CRC32C 用多项式 `0x82F63B78`（不是 `0xEDB88320`）
- [ ] ZIP 内部 CRC 用 `0xEDB88320`（不是 `0x82F63B78`）
- [ ] SSTable 块 CRC 计算范围是 `block + compression_type`
- [ ] 日志记录 CRC 计算范围是 `type + data`
- [ ] VarInt 只用于无符号数
- [ ] BlockHandle 的 size **不含** 5 字节尾部

## 3. LevelDB 结构（`03-leveldb.md`）

- [ ] CURRENT 内容格式为 `"MANIFEST-000004\n"`（含 `\n`）
- [ ] MANIFEST 里的 smallest/largest key 是**原始 user key**（不带 8 字节尾部）
- [ ] entries 按 key 字节序排序
- [ ] 每个 chunk 都写了全部 7 个元数据键
- [ ] subY 是有符号字节（负值用 `& 0xFF`）
- [ ] .ldb 文件扩展名是 `.ldb`
- [ ] ZIP 里文件路径用 `/`

## 4. SSTable（`04-sstable.md`）

- [ ] 元索引块在索引块**之前**
- [ ] 每个块都有 5 字节尾部（compression_type + CRC32C）
- [ ] CRC 计算范围包含 compression_type
- [ ] BlockHandle 的 size **不含** 5 字节尾部
- [ ] Footer 魔数是 `57 FB 80 8B 24 75 47 DB`
- [ ] SSTable 里所有 key 都加了 8 字节 internal key 尾部
- [ ] MANIFEST 里的 smallest/largest key **没有** 8 字节尾部
- [ ] entries 按 user key 字节序排序
- [ ] 每个数据块的 restart interval 是 16
- [ ] 索引块用 restart interval = 1
- [ ] 每个块末尾的 restart 数量是 `uint32 LE`
- [ ] 压缩类型用 0 或 4，不用 1（Snappy）

## 5. MANIFEST/CURRENT（`05-manifest.md`）

- [ ] CURRENT 内容以 `\n` 结尾
- [ ] CURRENT 里的文件名和实际 MANIFEST 文件名一致
- [ ] MANIFEST 里的 file_number 和实际 .ldb 文件名一致
- [ ] MANIFEST 里的 smallest/largest key **不带** 8 字节尾部
- [ ] LogRecord 的 CRC 计算范围是 `type + data`
- [ ] LogRecord 的 length 字段是 `data.length`（不含 header）
- [ ] MANIFEST 记录 type = 1（FULL）
- [ ] Comparator 名称是 `"leveldb.BytewiseComparator"`

## 6. SubChunk（`06-subchunk.md`）

- [ ] SubChunk 版本号是 9（1.18+）
- [ ] subY 用有符号字节处理
- [ ] bits 只取 0、2、4、8
- [ ] `getBitValue` 开头有 `if (bits === 0) return 0`
- [ ] 索引顺序是 `lx * 256 + lz * 16 + ly`（XZY）
- [ ] 遍历了所有层（不只 layer 0）
- [ ] palette 里的 name 完整（含 `minecraft:` 前缀）
- [ ] palette 里的 version 是 18168865（或合适版本号）
- [ ] 空 palette 时能正确处理
- [ ] Layer 1 全空时不写层

## 7. BlockEntity（`07-blockentity.md`）

- [ ] block_position_data 键是 `"sx,sy,sz"` 字符串（无空格）
- [ ] 每个值都包了 `block_entity_data`
- [ ] BE 内 x/y/z 用结构相对坐标
- [ ] mcworld 侧 BE 内 x/y/z 用世界坐标
- [ ] BE id 是驼峰（CommandBlock / Sign / Chest）
- [ ] 缺失 id 时从方块名推断
- [ ] 单条 `0x31` 记录 < 32 KB
- [ ] 过滤了 `LastOutput` / `LastOutputParams`（除非明确要保留）
- [ ] BE 坐标在结构范围内
- [ ] 告示牌用 `FrontText` / `BackText`（1.19.80+）
- [ ] 箱子 `Items` 是 List\<Compound\>

## 8. level.dat（`08-leveldat.md`）

- [ ] 头部版本号是 10
- [ ] 头部 NBT 长度 = 实际 NBT 数据长度
- [ ] `lastOpenedWithVersion` 是 List\<Int\>
- [ ] `MinimumCompatibleClientVersion` 是 List\<Int\>
- [ ] `SpawnY` = 32767
- [ ] `Generator` = 2
- [ ] `FlatWorldLayers` 是合法 JSON，末尾加 `\n`
- [ ] `NetworkVersion` 用 2168（1.19.10）
- [ ] `InventoryVersion` 用 `"1.19.10"`
- [ ] `BiomeOverride` 是 `"minecraft:minecraft:"`
- [ ] 有 `LevelName` 字段
- [ ] `levelname.txt` 与 `LevelName` 一致

## 9. mcstructure（`09-mcstructure.md`）

- [ ] 根是 Compound (10)
- [ ] `format_version` = 1
- [ ] `size` 是 `[sizeX, sizeY, sizeZ]`
- [ ] 索引公式是 `(sx * sizeY + sy) * sizeZ + sz`
- [ ] `block_indices` 有两层
- [ ] 每层长度 = sizeX * sizeY * sizeZ
- [ ] layer 1 全空时用全 -1 数组（不要省略）
- [ ] `block_position_data` 的键是 `"sx,sy,sz"`
- [ ] 每个 BE 包了 `block_entity_data`
- [ ] BE 内 x/y/z 用结构相对坐标
- [ ] palette 里每个条目有 name / states / version
- [ ] version 是 18168865
- [ ] `structure_world_origin` 是 3 个 Int

## 10. mcworld 组合（`10-mcworld.md`）

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

## 11. 转换算法（`11-conversion.md`）

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

## 12. 陷阱清单（`12-pitfalls.md`）

- [ ] 18 条陷阱都避免
- [ ] 症状反查表里没有你遇到的
- [ ] 用了预防性检查代码
- [ ] 测试了方块、BE、layer 1、多 chunk

## 13. 最终验证

### 13.1 生成的文件能被游戏加载

- [ ] 放到 `behavior_packs/你的包/structures/`
- [ ] 用 `/structure load` 加载
- [ ] 世界能打开
- [ ] 命令方块能点开并显示指令
- [ ] 告示牌显示正反面文字
- [ ] 箱子保留物品
- [ ] 水面、雪、草正常存在

### 13.2 反向转换一致

- [ ] A → B → A' 时 A' 与 A 等价
- [ ] 方块数量一致
- [ ] BE 数量一致
- [ ] 命令方块指令一致
- [ ] 告示牌文字一致

### 13.3 边界情况

- [ ] 空结构
- [ ] 单方块结构
- [ ] 超大结构（> 1000 万方块）
- [ ] 负坐标
- [ ] 多层结构（有 layer 1）
- [ ] 大量 BE（> 100 个）

## 14. 交付前检查

- [ ] 所有代码可运行（无语法错误）
- [ ] 处理了异常（try/catch）
- [ ] 有进度提示（长任务）
- [ ] 有内存保护（超阈值警告）
- [ ] 有调试日志（可关闭）
- [ ] 有使用说明（README）

## 15. 参考

- `SKILL.md` 目录
- 各章节详情
