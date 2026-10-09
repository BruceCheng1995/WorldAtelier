# 资源市场与官方角色库

2026-09-10。资源市场接入原 48910 服务，未创建第二个产品后端。

- 市场：`http://127.0.0.1:48910/market`
- 游戏：`http://127.0.0.1:48910/creation-workspace.html#/games`
- 每项资源：`/market/assets/<asset_id>`；固定版本：同地址加 `?version=<sha256>`。
- 工作台左侧“资源市场”与“预制件”同级，可折叠查看官方素材或展开完整市场。外部导航同时提供“我的游戏”和“资源市场”。

## 首批 6 项官方素材

| ID | 内容 | 运行能力 |
| --- | --- | --- |
| `official-2d-maleAdventurer` | 2D 探险家·男 | CharacterBody2D，8 帧行走、跑步、跳跃、攀爬、受伤、攻击动作 |
| `official-2d-femaleAdventurer` | 2D 探险家·女 | 同上，横版 / 俯视移动可配置 |
| `official-2d-femalePerson` | 2D 城市女孩 | 同上，城市卡通外观 |
| `official-3d-skaterMaleA` | 3D 滑板青年·男 | CharacterBody3D，idle/run/jump 骨骼动画 |
| `official-3d-skaterFemaleA` | 3D 滑板青年·女 | 同上，第三人称 / 俯视固定跟随相机 |
| `official-3d-cyborgFemaleA` | 3D 机械冒险家 | 同上，机械角色外观 |

原作者为 Kenney。2D 来源：[Toon Characters](https://kenney.nl/assets/toon-characters)；3D 来源：[Animated Characters Protagonists](https://kenney.nl/assets/animated-characters-protagonists)。当次原包中的 `License.txt` 确认为 CC0，允许个人、教育、商业用途；原包与许可保存在服务器 staging，每个上架包包含原许可及控制器适配的 CC0 声明。没有采用只允许在游戏内使用、禁止素材再分发的免费包。

2D 将原动作帧整理为 SpriteFrames 和纹理图集；3D 经后台 Blender 将 FBX 模型、独立动画与皮肤转为独立 GLB。模型与动作文件的骨骼基准姿势不同，因此按骨骼矩阵逐帧适配后导出，避免动作名称存在但角色保持 T pose。3D 封面来自后台 Godot 渲染；2D 封面展示实际动作帧。网页详情提供可选择的动画预览，模型还支持旋转、缩放和线框。

默认输入为 WASD / 方向键、空格跳跃、Shift 奔跑；可关闭键盘后由 `set_move_input` 接入 AI/触屏输入。控制器提供速度、加速度、重力、跳跃、相机开关等原生导出属性。2D 俯视使用同一侧身美术，并非四方向角色包。动作素材不自动赋予攻击伤害或完整战斗规则。SpringArm 排除角色自身碰撞，避免镜头贴入胶囊。

## 扩充后的 26 项官方资产

本次新增 20 项，服务器共 26 项，5 项 2D、21 项 3D，约 25.3 MiB 原始包。旧 ID 和历史版本继续保留。所有新美术在原作者页面确认 CC0，来源 URL、下载字节 SHA-256 和取回日期在 `tools/asset-market/sources.json`，每项包自带许可 / 来源记录。

| 新资源 ID 后缀（默认前缀 official-3d-） | 数量 | 内容与能力 |
| --- | --- | --- |
| kaykit-knight / kaykit-barbarian / kaykit-mage / kaykit-rogue | 4 | 白银骑士、荒野战士、秘法师、游侠刺客；每包 76 段原始动画（含 T-Pose 参考姿态），移动 / 跳跃、生命值、受伤 / 死亡、近战短射线接口 |
| soldier / hazmat | 2 | 突击士兵、防化枪手；17 动画，移动 / 跳跃、射线攻击、冷却、伤害事件 |
| zombie-basic / zombie-chubby / zombie-ribcage | 3 | 感染者、重型僵尸、残躯爬行者；16 / 16 / 9 动画；可被 AI 输入驱动或开启玩家输入 |
| monster-demon / monster-orc / monster-blob | 3 | 赤焰恶魔、重装兽人、绿沼史莱姆；14 / 14 / 9 动画和原生控制器 |
| vehicle-suv / vehicle-race / vehicle-police / vehicle-truck | 4 | 越野车、跑车、警车、卡车；前进、倒车、加速、转向、刹车、碰撞和跟随镜头 |
| weapon-rifle / weapon-shotgun | 2 | 步枪、霰弹枪独立 GLB 与 fire(exclude) 单射线组件 |
| official-2d-zombie / official-2d-robot | 2 | 僵尸、战斗机器人，8 类动画姿态，横版 / 俯视移动 |

新来源：[KayKit Adventurers](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0)、[Quaternius Toon Shooter](https://quaternius.com/packs/toonshootergamekit.html)、[Zombie Apocalypse](https://quaternius.com/packs/zombieapocalypsekit.html)、[Ultimate Monsters](https://quaternius.com/packs/ultimatemonsters.html)、[Kenney Car Kit](https://kenney.nl/assets/car-kit)。KayKit 使用其官方公开仓库中动画齐全的版本，未取用付费 EXTRA。GLTF / GLB 的纹理与缓冲区均打包到独立 GLB，车辆原本的外部 colormap 已内嵌；实际截图来自静音后台 Godot。

行为边界写在每个详情页：动画数量包含可选动作，并不代表翻滚、施法等技能全部实现；敌人不自带自动寻路和追踪 AI，默认键盘与相机关闭。车辆为街机控制器，不含悬架 / 轮胎动画 / 上下车。武器为单射线适配（霰弹枪也需游戏扩展散射），没有弹药、换弹、音效或特效系统。残躯默认攻击伤害为 0。游戏按这些接口接入自己的规则。

### 发现、筛选与排序

- 输入中文、英文、作者或完整 ID；空格分隔的多个关键词使用 AND，并支持 zombie / 僵尸、shooter / 射击、vehicle / 载具等别名。
- 9 个维度：类型、2D / 3D、来源、对象、玩法、风格、能力、许可及关键词；前 8 个结构化筛选字段通过 catalog 字典公开。
- 同字段逗号分隔为 OR，capability 为全部具备，字段间 AND。facets 去除本字段条件后计数，保留其他筛选，可发现相邻选择。
- 六种排序：相关度 / 官方优先、最新收录、最近更新、名称、体积最小、动画最多；同值按 ID 稳定排序。limit 1–60、offset 非负整数，网页提供 12 / 24 / 48 每页和前后翻页。
- 网页提供射击 / 动作 / 僵尸 / 怪物 / 载具快捷集合、可移除的条件、清除筛选、空结果恢复和 URL 查询状态。忽略较早搜索响应，避免快速输入时旧结果覆盖新条件。
- Agent 的 asset_catalog / asset_search / asset_detail 在规划模式可用，asset_import 仍只允许实施模式、有效租约和可编辑分支；不会把僵尸或车辆作为未指定外观的人形默认主角。

### 制作与安装工具

`prepare-packages.py` 准备 Kenney 2D / 初代 3D；`prepare-expansion.py` 把新 GLTF 依赖内嵌并生成 Godot 场景与动作 / 驾驶 / 武器适配器；`prepare-preview.mjs` 准备隔离预览工程；`catalog-preview.gd` 测量模型并后台渲染；`normalize-expansion.py` 按测得尺寸适配角色、车辆碰撞和枪口方向；`install-official.mjs` 将最终包写入正式市场不可变对象归档及当前目录。

下载、源美术、包输出、引擎缓存均位于 `.local/asset-market/`，不进入 Git。安装市场资产只写市场记录，既不添加用户游戏中的对象，也不发布游戏。

## 人与 Agent 的使用

人类从详情点击“添加到当前游戏”，或在外部市场选择自己的游戏/分支。导入后入口 `.tscn` 登记为游戏内预制件，可打开独立编辑器、拖入场景。素材导入本身不自动在关卡摆放主角。

Agent 动态工具：

1. `asset_catalog()` 查看可用类别、筛选和排序；`asset_search({publisher:"official",dimension:"2d" 或 "3d",role:"humanoid",capability:"controllable,animated"})` 搜索简要目录。
2. `asset_detail({asset_id,version})` 读取功能、许可、截图及文件引用。
3. `asset_import({asset_id,version,base_revision,transaction_id})` 通过现有中央原生事务复制资源并登记预制件。
4. 合并 / 准备更新后的可编辑工程，保留未提交改动，将预制件实例化到目标场景并适配玩法。

每轮资产指导与会话投影技能都包含默认策略：需要可操控的人形主角且未指定外观时，优先使用合适的官方角色；已有适用角色则复用；用户指定外观时遵从要求。坦克、棋盘等无需人形主角的游戏不添加角色。游戏宿主没有恢复默认玩家、默认 InputMap 或默认玩法相机。

## 存储、身份与版本

`market_asset` 保存资产身份与当前版本，`market_version` 保留全部不可变发布版本。`data/market/objects/<hash前2位>/<hash>` 保存按 SHA-256 核对的原始字节。首次安装及离线维护通过 `tools/asset-market/install-official.mjs`，官方身份没有公共写接口。

每次导入复制到 `assets/market/<asset_id>/<transaction_id>/`，重定位文本中的包内 `res://` 依赖，并保留 `provenance.json` 中的资产 ID、固定版本、作者、许可、原始文件哈希与详情链接。未知外部依赖拒绝提交。游戏文件通过自己的源版本变化；不会回写市场原件。重复同一请求返回原回执，不重复添加。新请求创建新副本；旧发行与已有副本不随市场版本升级而变动。

导入调用既有 `CreationService.committed` / 原生事务，保持编辑权限、源基线、Agent 租约、原子提交与协作广播。源稿保存、固定构建、游戏公开发行保持三个独立动作。素材发布到市场也不发布任何游戏。

备份工具 `tools/backup-creation.mjs` 已包含所有发布过的市场版本与原件；还原不依赖下载原站。未发布上传暂存不属于发布历史备份。

## 开发者上传与 API

支持角色、载具、武器、模型、特效、材质、贴图、音频、控制器、场景及其他资源。开发者选择多文件或文件夹，填写描述、功能、使用说明、许可、入口路径和封面。发布生成资源 ID 与详情 URL。上传需要服务器开发者权限；发布者固定为当前账号，不接受客户端伪造官方身份。

| API | 作用 |
| --- | --- |
| `GET /creation-api/market/catalog` | 公共分类字典、可用筛选值、排序和查询语法 |
| `GET /creation-api/market` | 公共检索；q / dimension / category / publisher / role / genre / style / capability / license / sort / limit / offset；返回 facets 和 has_more |
| `GET /creation-api/market/:id?version=` | 公共详情与固定版本文件清单 |
| `GET /creation-api/market/:id/versions/:version/files/:path` | 读取该版本登记且经哈希核对的原件 |
| `POST /creation-api/market/files` | 原始文件上传；`X-Asset-Name` 为编码后的相对路径 |
| `POST /creation-api/market` | 元数据与已上传文件哈希发布；必须确认再分发权利 |
| `POST /creation-api/projects/:p/branches/:b/market-import` | 有编辑权限的用户导入固定资产副本 |

当前为免费素材市场，许可选项为 CC0-1.0、CC-BY-4.0、MIT、Apache-2.0；上传者须拥有再分发权利。单文件最多 32 MiB、整包 128 MiB、最多 500 文件。资源包不得覆盖 project.godot、.atelier、addons 或平台来源记录。模型交互预览使用独立 GLB；图片 / 2D 图集与音频使用相应只读预览。任意资源脚本不会在市场网页中执行。整工程、编辑器插件、付费交易与版权审核流程不在本次实现范围。

## 扩充版本验证（2026-09-10）

- 26 个包逐个检查入口、许可、截图、GLB 依赖闭包及动画清单；21 个 3D 原件使用 Godot 后台实际渲染。原件已安装到 48910，26 个当前 ID、35 个不可变历史 / 当前版本，205 个包文件，26,572,061 字节。
- 新搜索测试 6/6 通过：中英别名 / AND、同字段 OR / capability ALL、去自身计数、6 排序、稳定分页、坏参数、历史版本、公开 HTTP 与 Agent 参数一致。规划模式只读可用，失效租约与无权导入拒绝。
- 新 action / vehicle / weapon 控制器 18 包 516 断言；原 6 包及新增 2D 僵尸 / 机器人共 8 包 243 断言。共 26 包 759 项实际 Godot 断言通过，包含骨骼变化、键盘输入、位移、命中 / 冷却 / 伤害、死亡，以及转向 / 刹车 / 倒车。数据均为隔离副本。
- 枪手、僵尸、SUV 经中央市场导入、native_nodes 查询、统一项目装配与 GameRuntime 启动，3/3 确认实际移动和原工程入口保留。
- 原 HTTP / 副本 / 幂等 / 归档版本测试及市场备份还原回归通过。一次同时启动两个 48921 HTTP 测试发生端口争用，拆开运行后通过；相同端口测试需串行执行。
- 全目录独立浏览器检查通过：26/26 封面解码，5 个 2D 与 15 个骨骼 GLB 的动画和暂停，6 个静态 GLB（4 载具 / 2 武器）旋转；快捷集合 / AND 搜索 / 筛选 / 排序 / 12–12–2 翻页 / 48 全量 / 深链回填，以及真实选择游戏导入 SUV。无 pageerror 或市场 HTTP 失败。
- 正式 48910 的目录、快捷集合、骑士 WebGL 详情、手机页面已检查：26 项、无 pageerror、手机无横向溢出。详情默认选择待机姿态，其他动画可选、播放与暂停。
- 原通用浏览器 5/5 回归通过：匿名检索 / 深链、GLB / 手机布局、真实登录上传与开发者登记、外部导入副本、工作台同级市场面板与展开；证据 `browser-1b9c0096-e8f7-4ea0-87dc-794fa388f0cd/`。独立 48921 服务、临时数据与测试 Chrome 已清理。
- 安装前后：7 游戏、8 分支、136 源版本、51 会话、6 账号数量不变。未向正式游戏插入验证对象，未构建或发布任何游戏。

证据根：`.local/creation-verification/asset-market/`；搜索为 `search-20260910T080652Z/`，新原生包为 `expanded-runtime-889a3d98-f9d5-4bae-a938-e1a9d48223ef/`，正式页面为 `expansion-live/`。全目录浏览器证据为 `expanded-browser-7d0ebaa6-ec5a-4e71-8321-8a209b146b4d/`，中央导入为 `expanded-canonical-e0c11fef-cc3e-4599-bc15-46f50cad5414/`，8 个 Kenney 包回归为 `controllers-1d1fa610-5317-4829-942f-4e944458e112/`。Agent 技能投影回归 2/2 通过。安装前 SQLite 备份在 `.local/asset-market/before-expansion/`。

## 首批交付验证记录

- `tests/creation/asset-market.test.mjs`：真实 HTTP、SQLite、Godot 导入；检索、身份、权限、固定版本、幂等、包依赖、原子性、两个独立副本及原件哈希保持。
- `tests/creation/asset-market-browser.mjs`：独立 Chrome headless；真实上传表单、选游戏导入、工作台同级面板、直接 URL、GLB 交互与小屏布局。
- `tests/creation/asset-market-controllers.test.mjs`：6 个真实官方包，最终合计 189 个 Godot 断言（2D 每包 27 项，3D 含相机排除自身碰撞每包 36 项），包括实际物理移动、动画帧 / 骨骼姿态、停止、键盘动作、跳跃和俯视移动。
- `tests/creation/asset-market-backup.test.mjs`：删除原数据后从备份还原当前和历史原件。
- 原备份回归 15 项、Agent 资产上传与技能投影 4 项通过。Godot 仅 headless / 受控 `--wa-render` 静音后台运行，没有桌面输入。
- 正式 48910 公共目录返回 6 个官方资产，3D / 2D 详情及动画预览真实加载，浏览器无 pageerror。截图与报告位于 `.local/creation-verification/asset-market/`，正式检查没有向用户游戏写入测试素材。

最终补充：真实官方 2D / 3D 包经市场导入、中央原生索引、`snapshotProjectRuntime` / `assembleProject` 和统一 GameRuntime 启动后，均确认加载目标场景并实际移动；证据 `canonical-723019ad-e028-4265-87cb-d67048cc8f1e/`。六包真实网页动画与暂停、深色预览工具、三列目录及宽搜索框验收见 `official-browser-df96803b-dc70-4a35-8082-bf9a69d515fd/`；无浏览器 pageerror。相机修复后的 3D 复验见 `controllers-0384e7c0-5990-459a-bc89-d911d1bbb122/`。这些目录均在 `.local/creation-verification/asset-market/`，所有临时服务已关闭。

## 后台上下架与统计（2026-09-10）

唯一管理员使用 `/admin#/market` 管理全部官方/开发者资源。下架阻止公开列表、详情、固定版本原件和新导入；原件及已导入游戏的副本保留。官方包更新和服务器重启不会重新上架被管理员下架的资源。操作要求原因和当前治理版本，审计、请求幂等与状态原子保存。

成功导入记录为整包下载，重试不重复；显式单文件下载另计。公开详情请求计浏览，近 7 个 UTC 自然日热度为浏览 + 5 × 导入；上线前历史未补算，后台查看和普通预览文件不计热度。后台同时展示市场、游戏源对象和模型目录的真实占用、市场历史/未引用文件、缺失对象与磁盘剩余空间。详细口径见 [管理后台](ADMIN-DASHBOARD.md)。
