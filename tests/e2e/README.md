# 独立中央服务 E2E

本目录由唯一独立测试角色维护。`central.test.mjs` 已于 **2026-09-07** 执行首轮真实隔离验收：**11 个顺序阶段通过，0 失败、0 跳过**；Node 的 12 个通过计数包含外层测试。以 `docs/ACCEPTANCE.md` 的完整目标为准，这套协议测试不缩小产品范围。

本轮通过与失败记录已归档到工程内 `.local/evidence/independent-20260907/index.json`。该索引区分协议阶段、原生源码 fixture 渲染与逐图复核；保留原临时路径，归档不包含账户凭据或数据库。下方历史运行的版本与范围保持原样，不因最新代码已更新而追认通过。

**最新核心复验**针对运行时 `37e014c2198a6f5653f128c9e2beaf6a4693e336e0a55a60a50b2169994d5f1a` 及对象历史、可空引用与 epoch 封口修复后的中央服务：**11/11 通过，0 失败、0 跳过**。证据 `/var/folders/16/s7yb42650hz_y104901slcy80000gp/T/world-atelier-central-e2e-Dpt410/observations.json`；真实 authority PID `63009` 同进程应用水位 `45`，18 tick 位移约 `4.8 → 7.2`，服务重启后 PID `63063`、epoch `2`、水位 `93`。本次再次覆盖多账户权限、三方合并/冲突、单控制者和 ACK 消费背压。

同日针对运行时 `d6287318389891375b504692adcd0118033bb82c839c54889e97feea1b490a24` 已复验核心 **11/11**，记录位于 `/var/folders/16/s7yb42650hz_y104901slcy80000gp/T/world-atelier-central-e2e-vWmsUh/observations.json`。新增真实快照消费 ACK 场景：暂停 ACK 时只收到 1 个未确认快照，中央继续推进；恢复精确 ACK 后世界序号从 8 追平至 12。

本次使用运行时 `7451f632d58134c19f8f2442130163dca67c8f715f325f9b74721a654503f0b3` 的真实 macOS 导出宿主。完整阶段观察位于 `/var/folders/16/s7yb42650hz_y104901slcy80000gp/T/world-atelier-central-e2e-7HyZ5P/observations.json`。内容更新前后 authority PID 均为 `54682`、epoch 均为 `1`；18 tick 实际位移由约 `4.8` 变为 `7.2`，角色进度保留。服务重启阶段另起 PID `54708`、epoch `2` 并恢复进度。坏候选 `player_speed=-1` 被实际 Godot 验证拒绝。

测试进程与端口 `48921` 已清理。中央日志只有两次启动记录，authority 日志为 0 字节；因此不把空日志当作全面的运行错误检查。此记录不证明 Web/原生画面、GLB、行为模块、完整离线客户端或跨分支迁移已通过。

## 执行方式

先集成 Godot 工作者的真实游戏、内容、验证入口及桌面/Web 导出，并安装根目录依赖；使用 Node 24 或更新版本：

```sh
npm run build:runtime
node --test tests/e2e/central.test.mjs
```

驱动启动真实 `services/control-plane/server.mjs`，固定使用 `127.0.0.1:48921`，将 `WORLD_ATELIER_DATA` 指向系统临时目录。端口被占用时明确失败，不连接或清理正常服务。测试账户、项目、工作区、世界和数据库全部独立；导出的运行程序作为只读产物复用。`GODOT_BIN` 用于生成导出；E2E 的内容验证和世界宿主必须运行发行清单指定的不可变导出程序，不能回退到读取编辑中源码的 `--path` 启动。

每次执行保留独立临时目录、脱敏服务日志、分阶段实际观察和进程标识。无论成功失败都关闭探针连接和自己启动的服务；不会按端口批量杀进程。服务器缺失、游戏未集成、导出缺失、API 错误或实际验证失败均报告为失败，不使用 skip 将缺口包装成通过。后续依赖阶段在首个失败后停止。

`WORLD_ATELIER_E2E_BUILD_TIMEOUT_MS` 可调整真实构建等待上限，默认 180000 ms；增加等待时间不改变通过条件。

## 本驱动覆盖的计划

| 顺序 | 场景 | 验收事实 |
| --- | --- | --- |
| 1 | 五个独立账户、两个项目 | 认证有效；重复 HTTP 创建只产生一个项目，异参复用幂等键被拒；同一 seed 不导致跨项目 revision 覆盖；项目列表和详情隔离 |
| 2 | owner/editor/tester/viewer 权限 | 服务端拒绝无权提交、构建、派单和成员提权；owner 不被降权 |
| 3 | 离线三方合并与分支合并 | 不相交修改均保留；同字段冲突返回具体路径；冲突不推进源码 head |
| 4 | 真实 Godot 验证与发行产物 | 实际日志含 `CONTENT_VALIDATED`；发行关联具体源码；桌面/Web 产物非空、下载哈希和长度匹配且不可变 |
| 5 | 真实 authority、两个 ws 协议端 | 检查固定发行程序及服务子进程关系；用正常输入移动及拾取晶体；共享状态、重复拾取拒绝；相同 request_id 并发/完成后重试返回同一实际 ACK，异参复用被拒；客户端无法提交任意状态 |
| 6 | 离线导入夹带进度 | 允许的内容修改进入 source head；在线晶体和拾取事实不被导入覆盖；不会隐式改变 live release |
| 7 | 分支施工任务 | editing/testing/failed 状态通过明确的 API fixture 产生且不串分支；直接伪报 delivered 被拒绝 |
| 8 | 兼容内容热更新 | 实际构建并由真实 Godot host 应用；旧版本命令被围栏拒绝；同 PID、同 epoch、进度保留；新速度实际改变 distance/tick；对象确有修改且实际应用后任务才 delivered |
| 9 | 坏候选 | 合法 JSON 中的非法玩法参数被实际 Godot 验证拒绝；保留上一个 playable/live release 与进度，世界继续推进 |
| 10 | 同用户控制权交接与断线重连 | 新端准备时旧端仍可玩；交接后旧端失权，不能重复 loaded 夺回控制；两个新端同时 loaded 只留下一个 active 控制者；角色进度不重置 |
| 11 | 服务及 authority 真实重启 | 同一临时数据库恢复账户、世界与已确认进度；新 epoch 拒绝旧命令；明确记录这是进程恢复，不能当作原地热更 |

初始 gameplay 验收使用 Godot 工作者已声明的真实内容：出生点 `(0,6)`，`landing_crystal_0` 位于 `(2,6)`，`landing_crystal_1` 位于 `(3,7)`，`landing_crystal_2` 位于 `(4,5)`；正常 `interact` 范围 5.5，晶体给予 2 crystals 并只允许拾取一次。移动指令每 100 ms 刷新，按 authority 的固定 tick 比较实际位移；没有设置坐标、生命、奖励或世界快照的后门。

## 证据边界与仍需补齐的完整验收

- 两个 ws 端是独立的**协议探针**，会真实接收/解析内容并发送 `loaded` 协议确认；它们不是 Godot 客户端，不证明画面、输入、音频、动画或 Web WASM 已运行。实际 authority 由服务启动，本驱动不连接 `/host`，不代写 `ready/result/applied`。
- 任务状态用明确命名的 API fixture 测试，不表示发生了真实 Codex 开发任务。delivered 必须来自实际构建内容的世界应用，不由测试直接设置。
- 产物哈希验证证明下载完整性；Godot Web/桌面导出仍需实际启动并游玩，留截图、录像和运行遥测。四区域、敌人、Boss、任务与成长完整旅程另做真实游戏验收。
- 核心驱动只覆盖 JSON 内容入口；实际 GLB 与合规规则模块由下述扩展驱动另行验证。任意碰撞网格、通用脚本/场景迁移及所有运行异常的安全恢复仍不能由这些限定场景推定。
- 下述故障驱动已另行覆盖真实旧构建晚完成、成员撤销、下载期间版本变化及 ACK 后崩溃恢复。仍未覆盖隐藏事件视图切换、全部持久化指令边界、权威网络分区、旧输入恰好排在 apply 后面的受控竞态、断点续传/缓存损坏，以及保留策略与长期资源趋势；不能由已过用例推定这些场景通过。
- 离线 JSON 合并和同世界重连不等于完整离线客户端游玩或跨世界跳转。两者需要实际运行对应模式，核对源/目标世界状态及失败恢复。

## 编写时发现的契约边界

已与主 Agent 确认端口环境变量、health、build/world 状态和 release 产物字段。提交阶段可能比 Godot 更早拒绝非法参数；若之后加强 API 校验，应调整坏候选场景并明确其实际拒绝层，不能伪造一次 Godot 运行期失败。

测试驱动只依赖公开 HTTP、游戏客户端 WS 协议及自己启动的进程。当前服务实现仍在集成；独立审查发现的问题已直接反馈给主 Agent，测试文件不修补被测实现。

## 实际资产与脚本扩展

`live-content.test.mjs` 同样使用独立临时数据和端口 48921；须与核心驱动**顺序执行**。它上传真实 `explorer.glb`、校验项目资产读取与发行内嵌字节，将模型绑定至稳定对象并由真实宿主应用。坏 GLB 使用合法头与合法 JSON，但引用不存在的 mesh accessor，要求实际 Godot GLTF 解析拒绝。

行为场景上传 `extends RefCounted` 的完整 `evaluate(context)` 源码。基线规则保持 speed=8，代码根据两个在线玩家计算 speed=12；用真实移动验证变化。语法错误和准备期执行错误须实际构建拒绝。迟发错误候选先正常生效，再通过普通 attack 触发缺字段错误，要求隔离坏发行、真实应用上一完整内容、回退 playable head、客户端重新 loaded、同 PID/epoch 且进度保留。

```sh
node --test tests/e2e/live-content.test.mjs
node --test tests/e2e/central.test.mjs
```

首轮扩展运行针对 `f21b7b4b0da0cf618bc7eec143ed1a4e792b993fa609a3c08f23fcae43ba7baa`：基线阶段通过，第二阶段在 GLB 真实现场应用时失败，返回 `Authority connection lost`；后续五个依赖阶段未执行。证据保留在 `/var/folders/16/s7yb42650hz_y104901slcy80000gp/T/world-atelier-live-content-e2e-qk6RPH/observations.json`。上传和构建成功不被计作现场热更新成功。失败定位为默认 65535 字节 WebSocket 缓冲与约 1.23 MB 模型投递消息不匹配。

缓冲与快照 ACK 修复后的 `d6287318389891375b504692adcd0118033bb82c839c54889e97feea1b490a24` 已通过 **7/7 扩展阶段**。加强回滚世界水位断言后的最终记录为 `/var/folders/16/s7yb42650hz_y104901slcy80000gp/T/world-atelier-live-content-e2e-vfnJIm/observations.json`：真实导出宿主 PID `57407`、epoch `1` 保持；规则基础值 8 未改，上传行为代码使 18 tick 位移约 `4.8 → 7.2`；迟发非法输出触发后，攻击 ACK 世界水位 `83`，完整回滚实际世界水位 `84`，活动列表位置另记为 `28`。坏发行被隔离，playable head 与两个协议端返回先前完整内容，进度与站立位置保留。

本次发行下，缺字段 fixture 的实际拒绝原因是 `invalid behavior output: player_speed`，没有得到 Logger/VM 异常日志；证据证明执行后的非法输出检测与恢复，不能声称验证了通用 VM 异常传播。损坏 GLB 则明确记录 `GLTFDocument` 的 accessor 越界与解析拒绝。

这些仍是协议探针，不能证明 GLB 画面、碰撞网格、Web/原生渲染、任意恶意脚本隔离或完整离线/跨分支流程。错误脚本仅为明确的测试 fixture；没有启动真实 Codex 开发任务。

## 权限、构建乱序与崩溃故障

`faults.test.mjs` 于 2026-09-07 使用固定真实运行时 `9eb9ebc848361cefe7f1d4b998acd7084bb38d321e188151b1dd632c426f11a7` 通过 **5/5 阶段，0 失败、0 跳过**（Node 的 6 个通过含外层）。证据：`/var/folders/16/s7yb42650hz_y104901slcy80000gp/T/world-atelier-faults-e2e-JPOIee/observations.json`。

- 成员撤销立即关闭旧控制入口，项目/资产/旧 checkout 拒绝访问，已签发 ticket 也被拒；重新授权后角色进度保留。
- 真实 Godot validator PID `58646` 被 `SIGSTOP` 暂停，较新构建先完成，再 `SIGCONT` 使旧构建真实验证完成；旧构建为 superseded，playable head 不倒退。
- 已消费 65,208 字节的真实 76,324,315 字节下载暂停消费期间，分支发布并实际应用新版本；旧 checkout 准备加入被拒，原下载完成后的长度和 SHA-256 仍匹配原发行。
- 关键拾取 ACK 世界水位 `38` 后 `SIGKILL` 中央服务，旧 authority 断连自行退出；新 authority PID `58682` 在 epoch `2`、水位 `39` 恢复进度，原 request_id 重放返回完全相同的持久化 ACK，旧 epoch 命令被拒。

```sh
node --test tests/e2e/faults.test.mjs
```

这些故障只针对独立服务的已确认子进程注入；没有伪造 `/host` 数据，不证明网络分区下租约隔离或所有崩溃时点。

## 真实运行时升级与失败恢复

`runtime-upgrade.test.mjs` 固定旧运行时 `9eb9ebc848361cefe7f1d4b998acd7084bb38d321e188151b1dd632c426f11a7` 与新运行时 `a83e58fbf8851cf76d702079deb4a5e861c47ff22c8b3f18354c5f8c1d4f1c90`，经实际内容验证后启动发行内的精确 binary。2026-09-07 最终 **4/4 阶段通过**（基线 + 三种交接，Node 5 含外层），0 失败、0 跳过。证据：`/var/folders/16/s7yb42650hz_y104901slcy80000gp/T/world-atelier-upgrade-e2e-xrCLZd/observations.json`。

| 场景 | 实际观察 |
| --- | --- |
| 正常升级 | PID `60836 → 60846`，epoch `1 → 2`；真实冻结 F=`16`、目标水位=`17`；两名玩家的身份、位置、晶体、收集、击杀与等级保留。旧连接保持存在，新端按新发行重新接管成功。 |
| 目标启动失败 | 对实际处于 starting 的新 authority PID `60875` 先暂停再 SIGKILL；恢复旧发行 PID `60888`、epoch `3`，状态来自独立冻结检查点；使用明确 world_id + 旧 release_id 重新接入。分支 head 保留新发行。 |
| 中央服务崩溃 | 冻结检查点持久化后，在目标 starting 时 SIGKILL 中央 PID `60834`；旧目标恢复调度后断连退出。新中央 PID `60949` 启动精确目标 PID `60950`，epoch `3`，升级记录成为 complete 且 recovered_after_restart=true。 |

驱动仅以只读方式打开自己的临时 SQLite，独立重算冻结状态 SHA-256，并核对 checkpoint 的 world/release/epoch/F 与升级记录。新旧连接交接记录使用实际 `authority_epoch` 检查点或真实 `move0` 状态屏障。没有写入测试快照或替换 authority 回复。

首轮真实失败同样保留：`/var/folders/16/s7yb42650hz_y104901slcy80000gp/T/world-atelier-upgrade-e2e-mTyq9M/observations.json`。当时世界升级已完成，但新客户端接管错误地向恢复后尚未上线的角色重新发送旧入口封口命令，transfer 报 `Source control fence rejected`。修复后重跑时仍保留旧 socket，没有靠测试提前断开旧端规避问题。

```sh
node --test tests/e2e/runtime-upgrade.test.mjs
```

`WORLD_ATELIER_E2E_SOURCE_RUNTIME` / `WORLD_ATELIER_E2E_TARGET_RUNTIME` 可指定已存在的真实不可变发行；不能填虚构 hash。升级会更换进程，这不是同进程内容热更。此证据不证明真实渲染客户端自动下载、Web/原生画面接续、任意状态 schema 迁移或全部崩溃边界。

## 休眠与自包含备份恢复

`backup-recovery.test.mjs` 使用 `a83e58fb…` 于 2026-09-07 通过 **4/4 阶段，0 失败、0 跳过**（Node 5 含外层）。证据：`/var/folders/16/s7yb42650hz_y104901slcy80000gp/T/world-atelier-backup-e2e-QNPsbs/observations.json`。

休眠在真实 F=`11`、tick=`16` 停止旧 PID `61060`，重复休眠不推进水位，状态哈希保持。旧 socket 保持存在时重新加入，真实启动 PID `61085`、epoch `2`，两名玩家进度保留。

随后备份包含数据库、资产、两个历史发行及完整运行时，共 **25 文件 / 342,552,539 字节**。原数据目录改名退场，恢复到全新的 data 和 runtime 目录；逐文件复核长度与 SHA-256 后，以 `WORLD_ATELIER_RUNTIME_ROOT` 指向恢复目录启动中央服务。恢复 authority PID `61101` 的实际执行路径位于 `restored-runtimes` 内，epoch `2 → 3`；保留已确认的旧 ACK，正常新拾取产生水位 `31`。旧发行的 **76,326,045 字节** macOS 包仍可真实下载且哈希匹配。

```sh
node --test tests/e2e/backup-recovery.test.mjs
```

所有 E2E 驱动共享隔离端口 `48921`，必须顺序执行。此项证明备份中的实际程序与数据库可在本机新目录恢复运行，不等于渲染离线游戏、异地灾备演练、备份权限安全审计、长期保留策略或每个备份中断时点均已验收。

## 对象批注、版本历史与逐世界交付

`object-history.test.mjs` 于 2026-09-07 使用固定真实运行时 `a83e58fbf8851cf76d702079deb4a5e861c47ff22c8b3f18354c5f8c1d4f1c90` 通过 **5/5 阶段，0 失败、0 跳过**（Node 6 含外层）。证据：`/var/folders/16/s7yb42650hz_y104901slcy80000gp/T/world-atelier-object-history-e2e-EBMHKK/observations.json`。

测试创建同主干的两个真实 world，以及一个独立分支 world。源码领先现场时，以 live 来源批注固定现场 release 对应的 revision、object hash 与观察水位；错误 hash、旧 release、其他分支 world、不可达 source revision 均被拒。实际 build 自动 testing，真实 world A 应用后记录 delivered revision/hash/release/world/水位；world B 的实际 authority overlay 仍为 testing + awaiting_world，保持旧对象 hash。world B 真正更新后才显示 applied。分支历史和任务不会混入主干。

坏候选改变对象颜色并设置 `player_speed=-1`，由实际 Godot validator 拒绝，两个主干现场均收到 failed 任务态。已验证的发行、对象 hash、进度与进程保留。测试没有直接 PATCH delivered，也没有伪造 host ACK。

首轮历史查询真实返回 SQLite 参数错误，证据保留于 `/var/folders/16/s7yb42650hz_y104901slcy80000gp/T/world-atelier-object-history-e2e-7k6e9q/observations.json`；当时仅基线阶段通过，后续依赖阶段停止。根 revision 的可空父引用修复后才取得上述最终结果。

```sh
node --test tests/e2e/object-history.test.mjs
```

这些批注是明确的 API fixture，两端仍是协议探针；尚不能由此声称 Portal 版本历史的实际渲染、真正 Codex 开发周期、任意依赖图引起的对象变化识别或模型画面验收通过。

## 敌人预警边界独立检查

`tools/godot-telegraph-tests.gd` 已由独立测试角色于 2026-09-07 在完整隔离源码副本中执行。副本逐文件核对运行时 `37e014c2198a6f5653f128c9e2beaf6a4693e336e0a55a60a50b2169994d5f1a` 的 source_files，使用 Godot 编辑器 binary 的 `--headless --path` 模式，退出 0、日志错误 0。证据：`/var/folders/16/s7yb42650hz_y104901slcy80000gp/T/world-atelier-telegraph-e2e-j1_ccagq/independent-run.json` 与 `report/report.json`。

**6/6 边界 fixture 通过**：sentinel、stalker、artillerist、brute、boss 两阶段。实际 AI 发出的 warning、真正 Node3D/TorusMesh 几何及 impact 中心/半径一致；半径内 0.05 米角色受到伤害、半径外 0.05 米角色均为 0 伤害；火炮锁定后目标移动不改变落点。

场景坐标、boss 阶段和边界角色为明确 seed，直接检查攻击解析。`rendered=false`，没有截图；此记录不等于战役进度、窗口渲染或 release 包体边界测试。

## 每个预制件与系统的独立场景

`prefab-scenes.test.mjs` 在隔离源码副本中运行实际 Godot，读取工作者的场景生成器和检查器，同时独立核对清单、唯一 ID、每类断言数、完整执行标记及日志。2026-09-07 运行时 `37e014c2…` 对应源码通过 **3/3 阶段**（清单、headless、原生渲染；Node 4 含外层），0 失败、0 跳过。证据已归档到 `.local/evidence/independent-20260907/prefab-37e014c2/`。

实际生成并实例化 **290 个 PackedScene**：227 个已摆放物件、1 个未摆放的 platform、46 个敌人、16 个系统场景；覆盖全部 15 种支持的物件和 5 种敌人。headless 与渲染运行各自核对 **1,928 条断言**。渲染运行留下 **36 张**真实代表截图，全部逐张查看。

首轮四种任务状态的文字与选中标签重叠，其余 32 张未见阻断性预览渲染问题；原图与问题记录保留在 `prefab-37e014c2/visual-review.json`。修复后从新源码副本重拍 editing、testing、delivered、failed、selection 五张图，进程均退出 0、日志错误 0；五张实际图逐张确认任务文字与 SELECTED 已分开。修复复核位于 `.local/evidence/independent-20260907/status-spacing-0.1.2-source/`，不覆盖或删除旧失败证据。

```sh
node --test tests/e2e/prefab-scenes.test.mjs
WORLD_ATELIER_E2E_RENDER=1 node --test tests/e2e/prefab-scenes.test.mjs
```

渲染命令须独占 GPU，不能与其他 Web/原生画面测试并发。默认命令只运行两个自动阶段，不将未请求的渲染记成通过。最早一次独立驱动因 macOS `/var` 与 `/private/var` 路径别名检查失败，未运行 Godot 阶段；修正测试路径比较后的真实结果另存，初次日志保留于 `prefab-initial-harness-failure/`。

这些是明确 seed 的系统与对象 fixture，使用 Godot 编辑器 binary 的 `--path` 模式，原生 OpenGL Compatibility / Apple M5 Pro；不是已导出的客户端验收。系统截图是静态预览，部分游戏断言在独立 Game 实例中执行，不能把静态图当作移动、死亡恢复或动画过程证据。模型绑定实际生成 Mesh 节点，游戏碰撞仍按 XZ 圆形、桥矩形与区域边界规则判断，不等于 GLB 网格碰撞。完整 Web/原生战役、离线磁盘恢复、审美细节与帧性能另行验收。

## 配置服务地址与本地反向代理

`public-address.test.mjs` 使用独立中央服务 `127.0.0.1:48921`，设置 `WORLD_ATELIER_PUBLIC_URL=http://127.0.0.1:48922`，在 48922 启动只转发真实请求与 WebSocket 字节的本地 HTTP 代理。2026-09-07 固定实际运行时 **0.1.2 / `636968d30a10bb8a66b89a83e3f5a9ba927da235b5eeaef91950af857bb4588d`**，通过 **3/3 阶段，0 失败、0 跳过**（Node 4 含外层）。归档为 `.local/evidence/independent-20260907/public-address-636968d3/`。

实际 Godot 验证后启动不可变导出宿主 PID `66460`；prepare-join 返回 `ws://127.0.0.1:48922`，与 Web 入口查询参数一致。入口经代理真实返回 200、5,494 字节；请求中的不可信 Host/Forwarded 声明不会改写显式配置。协议客户端经代理 `/play` 接入，正常拾取获得 2 晶体、ACK 水位 `5`，18 tick 实际移动约 `4.8`，宿主 PID 保持；代理错误 0。

```sh
node --test tests/e2e/public-address.test.mjs
```

固定运行时可用 `WORLD_ATELIER_E2E_TARGET_RUNTIME` 指向另一个已真实导出的 hash；运行后才能对新版本给出结果。本记录不追认随后生成的 0.1.3。该驱动只证明本机两个端口间的配置地址与代理接入，不等于公网部署、TLS/WSS 证书、跨机器网络或 Godot Web 画面验收。驱动没有连接 `/host`、没有制造 authority 回复，停止时只清理自己创建的服务与代理。
