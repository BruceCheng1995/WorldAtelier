# 2026-10-23 创作能力独立验证

本报告只记录本轮独立执行得到的结果。源码保存、静态检查、真实 Godot 运行、浏览器行为与真实 Agent 执行分别列证；没有建立产品自动验收门禁。

本报告所列原工作台、真实引擎、客户端接续、存档、合并、离线及真实跨分支续聊均已完成独立复验。首次续聊的配额中止保留为失败历史；用户明确授权临时调整该隔离账号后，仅续跑一次只读 turn，已完成并恢复原额度。全站与正式账号配置未改变。

## 环境与责任

- 唯一独立测试角色审阅并执行所有本报告的验收。主集成、开发 A/B 提供的候选驱动保留开发方作者身份；只有独立角色执行后的结果计入下表。
- 测试服务使用 `48921`、临时数据库、合成账号、独立世界和 headless Chrome。没有向正式 `48910` 导入测试账号、工程或观察。
- Godot 使用 4.6.stable.official.89cea1439、headless/Dummy；浏览器为 Chrome 156.0.8078.47，使用静音，无桌面输入自动化。
- 所有正向准备、基线、控制权和状态确认均来自实际 Godot。网络故障 relay 只延迟、丢弃或随后转发真实包，不制造成功 ACK。
- `.local/creation-verification/next-wave/` 下保存每轮报告、代码和文件身份、日志、截图、固定构建与协议证据。失败报告保留，没有改成通过。私有测试凭据仅在权限为 `0600` 的临时状态文件内。
- 原有证据同时记录整个工作树身份；后续增加 `product_identity`，以区分新增测试文件与被测产品发生变化。以报告中的实际运行、源码与工具链身份为准。

证据层：N 为纯 Node；A 为实际 SQLite/HTTP/WS/文件事务；G 为真实 Godot；B 为真实浏览器；C 为真实 Codex。A 层的合成捕获包与索引替身不会算作 G/B/C。

## 已通过的主要链路

| 链路 | 独立结果 | 层次与边界 | 证据 |
| --- | --- | --- | --- |
| 最终集成细粒度合并与离线源回归 | 30/30 | N/A；真实 SQLite/blob/filesystem，原生索引构造使用明确替身，不是引擎运行；含新增属性的邻接约束回归 | [报告](../.local/creation-verification/next-wave/merge-v3-final-independent-2026-10-23T07-13-06-029Z-705dbae6/report.json) |
| 观察/窗口/桥接边界 | 21/21 | N/A；包含错误拥有者不能使合法句柄失效、UTF-8 secret、重绑、世界/代次、预算、重复 ID 与空选择 | [报告](../.local/creation-verification/next-wave/observation-bridge-independent-2026-10-23T05-32-09-805Z-c1c5a937/report.json) |
| 实际观察及延续 HTTP/WS | 6/6 | A；合成捕获明确标注，实际私密权限、图片读取、窗口撤销、原子延续和幂等 | [报告](../.local/creation-verification/next-wave/observation-http-independent-2026-10-23T05-32-09-822Z-7ba84d52/report.json) |
| 浏览器隔离和存档边界 | 7/7 | A/B；薄 HTML 为明确探针，验证 origin、Cookie/凭据、桥消息、IDB 原子冲突和真实迁移 UI，不替代引擎 | [报告](../.local/creation-verification/next-wave/runtime-browser-independent-2026-10-23T06-51-15-909Z-1e52c4cc/report.json) |
| 完全断网的原生离线启动 | 3/3 | A/G；已有缓存后禁止 API，修改入口并新增场景，真实 canonical GameRuntime 运行；源目录不被生成物改写 | [报告](../.local/creation-verification/next-wave/offline-godot-independent-2026-10-23T05-58-02-376Z-95ad167d/report.json) |
| 备份/恢复固定材料 | 4/4 | A；实际备份、校验和恢复，包含未完成上传、运行支持、观察图片；构建元数据为明确测试输入 | [报告](../.local/creation-verification/next-wave/retention-independent-2026-10-23T06-04-00-838Z-b3050082/report.json) |
| 实际试玩 → 60 秒 → 聚焦 → 真实 Agent 修复 | J01–J06 通过 | A/G/B/C；实际 Godot、真实用户输入、普通 UI 发送与真实源提交 | [报告](../.local/creation-verification/next-wave/play-journey-independent-2026-10-23T06-30-56-014Z-70eeef2f/report.json) |
| 修复后的实际运行与明确重开 | JR01/JR02 通过 | A/G/B；跨驱动续验，先核对上轮源/观察/归档字节，再实际输入及 UI 重开；没有再次请求 Agent 修复 | [报告](../.local/creation-verification/next-wave/play-repair-resume-independent-2026-10-23T06-41-04-125Z-ac645356/report.json) |
| 原生客户端准备、接续、故障恢复 | NC01–NC08 通过 | A/G；原始 CLI 与输入探针执行分别标注 | [报告](../.local/creation-verification/next-wave/native-client-independent-2026-10-23T06-43-22-806Z-c9175a10/report.json) |
| 持续按键的原生封口与恢复 | NC09/NC10 通过 | A/G；旧端移动、实际负确认、失败候选、旧端真实恢复；复用原固定构建 | [报告](../.local/creation-verification/next-wave/native-held-transfer-independent-2026-10-23T07-05-22-596Z-7592d483/report.json) |
| 真实 Godot 独立存档、迁移、刷新、升版与 LAN | SL01–SL06 通过 | A/G/B；实际 FileAccess 写读，未通过驱动写入 IDB 制造进度 | [报告](../.local/creation-verification/next-wave/standalone-lan-candidate-2026-10-23T06-55-12-044Z-3fcad02a/report.json) |
| 双 Web 原生共享个人观察与切场景 | SI01–SI07 通过 | A/G/B；两个账号、原工作台加入、真实 ACK；SI05 是真实记录的 API 保存，不是 UI 发送/C | [报告](../.local/creation-verification/next-wave/shared-inspection-candidate-2026-10-23T07-07-10-963Z-79896b08/report.json) |
| 原 UI 多来源合并、补偿、离线工具往返和重开 | MU01–MU07 通过 | A/G/B；原 UI 下载的 CLI、真实 HTTP/原生规范化与 canonical Web；断网本机复开另用明确作者探针 | [报告](../.local/creation-verification/next-wave/merge-offline-ui-candidate-2026-10-23T07-13-04-991Z-569e11fc/report.json) |
| 原 UI 跨分支私有上下文与获准只读续聊 | XC01 + XCR01 通过 | A/B/C；新私有目标线程与来源不同，真实读固定历史和当前源后完成回复；首次配额中止另留记录 | [初次 UI 报告](../.local/creation-verification/next-wave/continuation-journey-independent-2026-10-23T06-41-38-699Z-d6e2e9ae/report.json)、[获准续验](../.local/creation-verification/next-wave/continuation-resume-independent-2026-10-23T07-28-32-080Z-cd41edf9/report.json) |
| 已填草稿等待真实执行器就绪 | READY01 通过 | A/B；只延迟并原样放行实际 agent/status 响应，没有发送消息或启动模型 | [报告](../.local/creation-verification/next-wave/agent-readiness-independent-2026-10-23T07-33-17-200Z-1874b5e5/report.json) |

## 实际试玩与真实 Agent

J01–J06 使用真实作者两场景工程。先按一次 E，实际等待超过 65 秒，再输入被作者 `_input` 消费的 W 和两次 E。门仍关闭，作者计数为 3。默认发送材料只包含最近两次 E 和一次 W，早先 E 已退出 60 秒窗口，发送前没有持续上传捕获。

原“指出这里”动作进入本窗口观察，实际 tick 冻结；框选与进入观察前仍可见的游戏 UI 被保留为真实关键画面。正常聊天发送附带观察和图片，启动真实 run `run-8eece65f-d9f2-4ee6-9d83-dd1d5a3e43bf`。Agent 成功执行 `play_context_read`、`world_read`、`workspace_prepare`、`world_apply`，将 `scripts/main.gd` 的 `allow_open` 默认值设为 `true`，保留两次交互条件。真实保存版本为 `src-050a4d4f7ed3f5e961acfacb6956a4f6af53fb21b739c5c2abddb1d97d9d58fa`。

J06 核对原 iframe 与原构建没有自动重启，旧观察 SHA 不变，未知二进制和文本文件不变。Agent 自行报告的 21 项无头断言属于作者验证，不混入独立通过数。

J07 原驱动因聊天抽屉覆盖“更多”按钮而停下。JR01/JR02 续验先核对相同修复源、原构建身份及全部归档 Web 文件哈希、旧观察哈希；再从原工作台实际运行修复，并明确点击“重新开始”。两轮均确认第一次 E 仍关闭、第二次 E 打开，重开产生新运行实例。该结果明确是跨驱动续验，不伪称一条无中断浏览器脚本。

- [真实 Agent 工具事件](../.local/creation-verification/next-wave/play-journey-independent-2026-10-23T06-30-56-014Z-70eeef2f/real-agent-events.json)
- [真实观察和步骤](../.local/creation-verification/next-wave/play-journey-independent-2026-10-23T06-30-56-014Z-70eeef2f/sent-observation-events.json)
- [明确重开后的实际画面](../.local/creation-verification/next-wave/play-repair-resume-independent-2026-10-23T06-41-04-125Z-ac645356/actual-restarted-door-open.png)

## 原生客户端证据边界

NC02 和 NC08 使用未修改的便携启动器、未修改的下载工程，实际校验工具链、导入资源、启动并获得真实控制确认。它使用已安装且匹配的 Godot 编辑器程序执行固定工程，**不是已导出的 macOS/Windows/Linux 可执行应用**。

NC03–NC07、NC09–NC10 的输入来自显式测试 Autoload：仅向真实场景发送 InputEventAction 或真实 Button 信号，执行副本与叠加脚本哈希都有记录。原下载缓存、平台运行代码、发布源和权威实现不被探针改写；探针不生成基线、状态或成功 ACK。

NC04 在扣住新客户端实际 `native_ready` 时，旧客户端仍可操作；放行后同世界、同 epoch、相同作者进度转交。NC05/06 分别验证准备中断与最终基线中断。NC07 区分服务端已提交但最后确认丢失的状态。NC08 使用未修改 CLI，实际丢弃一次最后确认后，启动器查询真实已提交回执并自动重新接续，保留 `attempts=6`。

NC09/10 进一步让旧端持续按住方向。准备中真实运动推进；封口后 motion 为 0，权威 tick 继续而位置和距离稳定；新端随后可移动。NC10 把一个真实旧输入延迟到封口后，收到 `CONTROL_FENCED` 负确认，旧进程仍存活；候选断连后旧端通过真实 Godot 基线/控制确认恢复，旧按键不自动重放，新的按键仍可移动。

## 真实存档与 LAN

SL 使用实际 Godot E/S/L 输入形成存档。迁移的旧 origin 环境由测试浏览器临时路由提供，服务的是校验过哈希的原归档 Web 字节；没有修改产品旧路由、归档或 IDB 内容。它验证真实 Godot 存档格式和迁移，不能据此宣称所有历史应用版本都已运行过。

通过的行为包括：旧存档导出字节一致；明确迁移后新 origin 可用 L 读出 4 次交互；旧存档字节保留；S 保存到 5 后刷新仍能加载；源版本变化后相同存储域仍恢复 5；嵌入 Play 无该持久存档且从初始状态开始。

LAN 使用本机实际地址 `http://10.222.132.142:48921`，运行端为 `http://[::ffff:ade:848e]:48921`。真实 Godot 启动与输入通过，creator token 不存在，跨源管理读取被拒绝。此处 `isSecureContext=false`，界面明确提示局域网试玩暂不播放声音。未验证另一台物理设备、外部网络部署或 LAN 音频。

## 双 Web 共享个人观察

两个独立浏览器上下文、不同账号通过原 `sharedWorldButton` 加入同一实际原生共享权威。A 持续按键后“指出这里”，真实零输入与权威确认完成后进入个人观察；底层游戏 UI 默认隐藏，聚焦图保留观察前 UI。

A 的画面保持在 tick 4377；B 实际按按钮、移动，权威从 tick 4447 推进到 4580。A 的 canvas PNG 哈希、观察 tick 和对象显示保持不变，A 的权威 motion 为 0。A 返回后读取 B 的新状态，没有重放旧按键。

随后 B 通过真实 Next 按钮进入 `journey-b`、generation 2，两端当前观察/场景身份更新；先前 A 观察的版本、场景、代次与 SHA 保持固定。SI05 使用真实 A 包、真实捕获像素与鼠标框，经生产缓冲器保存，单列 API 层；真实 UI 发送与 Agent 链路仍由 J05/J06 证明。

## 跨分支上下文与获准续验

XC01 原 UI 创建新的私有目标会话，固定来源消息截止点、原观察和目标初始 head；没有重绑来源会话、运行线程或控制权。

XC02 创建了真实新线程 `01a1677e-704d-7750-8610-0a1724f63464`。六次 `session_context_read` 成功后，产品测试账号的每日 token 用量达到上限，run 被真实中止并完成清理。没有源修改；该首次尝试未完成最终回复，**原 XC02 不改为通过**。

[真实配额中止证据](../.local/creation-verification/next-wave/continuation-journey-independent-2026-10-23T06-41-38-699Z-d6e2e9ae/actual-quota-interruption.json)；[XC 报告](../.local/creation-verification/next-wave/continuation-journey-independent-2026-10-23T06-41-38-699Z-d6e2e9ae/report.json)。

随后用户明确批准：仅该隔离合成账号每日 token 上限由 100 万临时调为 200 万，完成一次只读续验并恢复原额度。通过临时服务的管理员身份配置和正常管理 API 执行，没有直接写库，也没有改正式账号或全站政策。两次界面准备失败没有创建新 turn，均在 finally 恢复额度；最终只运行了一个获准新 turn。

XCR01 的 `run-866410b0-3a4e-47a8-89ef-00f69bb1ebd4` 沿原私有目标线程继续，成功执行三次 `session_context_read` 和两次 `world_read`，完成最终回复：区分旧运行观察、来源已保存修复和目标当前 `allow_open=true`。目标线程仍不同于来源线程，来源/目标 head 均未改变，没有文件修改、写工具、验证、发布或引擎启动。

finally 已通过正常 API 恢复该账号每日上限 **1,000,000**；政策版本为 7（审计递增），保留实际用量 **1,394,210**。全站政策及版本与变更前一致；没有再请求新的模型 turn。[额度恢复证据](../.local/creation-verification/next-wave/continuation-resume-independent-2026-10-23T07-28-32-080Z-cd41edf9/restored-quota.json)、[最终只读回复](../.local/creation-verification/next-wave/continuation-resume-independent-2026-10-23T07-28-32-080Z-cd41edf9/authorized-real-continuation-reply.json)。

本次 C 页面加载于 `80a10d8`。执行期间 `d00ceee` 仅修改静态工作台 JS，报告因此如实标记 `product_changed_during_execution=true`；后台、Godot 与固定工程未改变。C 结果不用于证明该静态修复。之后 READY01 在新页面单独扣住真实成功的 `agent/status` 响应，先输入草稿确认按钮禁用，再原样放行；没有新增输入事件（2→2）即恢复按钮可用，且消息和模型 turn 都为 0。

## 原工作台合并与离线往返

MU 在两个真实协作者账号和三个源分支上执行。原 UI 明确选择来源顺序，将局部 `counter_step` 冲突手工组合为 7；“与 Agent 讨论”只创建私有草稿和固定合并上下文，没有启动 Agent。复核不写源，保存才产生一个合并提交，独立新增属性和未知二进制保留。之后另一协作者编辑新字段，历史补偿产生新提交并保留该后改。

通过原“本机与离线工作区”面板下载的便携 CLI 实际 checkout、同步本地修改和新增二进制，同时合入另一账号的在线编辑。新源已提交时，既有 Web 局仍使用旧构建和旧运行实例，门仍关闭；明确重开后从新源初始状态启动，第二次交互打开门。

最后禁止 CLI 网络访问，加入未同步的作者探针并通过已缓存支持准备 canonical 工程，实际执行两次 headless/Dummy GameRuntime。两次均从初始状态启动且读取 `counter_step=17`。该探针直接调用作者交互方法，仅计引擎/离线启动证据，不称作键盘输入验收；Web 的真实 E 输入已在 MU06 验证。源工作区哈希和中央 head 不受本地准备/运行影响。

[候选作者与独立审阅执行边界](../.local/creation-verification/next-wave/merge-offline-ui-candidate-2026-10-23T07-13-04-991Z-569e11fc/independent-review.json)。

## 本轮发现与修复

1. 嵌套运行页的 CSP 与本机安全上下文问题在实际浏览器中暴露并修复。本机新运行 origin 使用 `wa-runtime.localhost`，真实浏览器安全上下文通过，不依靠测试安全标志。
2. **实际 Godot IDBFS 保存 `Int8Array`。** 旧读取器只接受 Uint8Array/ArrayBuffer，会静默丢失文件 contents。失败证据见 [实际类型](../.local/creation-verification/next-wave/standalone-lan-candidate-2026-10-23T06-47-29-480Z-f874d71d/actual-legacy-idb-types.json)。`b3752f9` 改为按视图原 buffer/offset/length 读字节，并对未知文件格式明确失败。独立 Chrome 回归覆盖 -128/-1、非零 offset、导出、幂等和未知原件保留，随后 SL 全链路通过。
3. **原生持续输入跨控制封口到达。** 旧端收到普通致命错误后退出，失去恢复机会；[原失败](../.local/creation-verification/next-wave/native-held-transfer-independent-2026-10-23T06-59-49-803Z-94b96d46/report.json)保留。`c6d8a0e`/`5962226` 将明确封口态的旧输入变为结构化负确认，认证与权限错误仍不放行。NC09/NC10 真实复验通过，原固定包未重写。
4. **真实 Godot 规范化后的独立新增属性产生额外顺序冲突。** MU02 首轮预期一个属性冲突，却出现一个属性冲突和两个顺序冲突；[原报告](../.local/creation-verification/next-wave/merge-offline-ui-candidate-2026-10-23T06-57-08-799Z-52166e51/report.json)保留。`9b444d6` 只放宽互异独立 property 插入，保留双方邻接约束；矛盾共同新增键、旧键重排和 section/node 顺序仍需决议。独立 N/A 回归 30/30 和原真实 MU01–MU07 均复验通过。
5. **执行器就绪后已填草稿按钮仍保持禁用。** 原 bootstrap 只更新状态显示，缺少发送按钮刷新。`d00ceee` 在 `renderAgentStatus` 末尾统一更新发送按钮；READY01 对真实响应进行延迟后独立复验通过，没有预先写入就绪状态或重复输入来掩盖问题。

隐藏兼容 textarea、暂停前截图与暂停后 tick 的采样竞争、聊天抽屉/出包 dialog 遮挡、登录初始化竞争属于测试驱动问题。修正只调整正常 UI 操作和真实状态等待，没有强制设置产品模式、跳过权限或写入完成态。旧失败目录保留。

## 清理与当前剩余项

每轮驱动只关闭自身创建的浏览器、服务和 Godot 进程，并核对 `48921` 释放。临时测试数据和不可变证据为复查保留；正式 `48910` 由主集成管理并继续运行，独立测试不停止它。最后一次独立清理再次只读核对账号额度 100 万、全站政策不变、该保留数据库共三个真实 run（来源修复一次、首次被配额中止的目标续聊一次、获准只读续跑一次），无活动执行和遗留独立进程，`48921` bind 探测成功后立即关闭。[最终清理报告](../.local/creation-verification/next-wave/final-restored-independent-cleanup-2026-10-23T07-34-53-117Z-8b0a07e7/report.json)。

最终后端复验基于 `80a10d8`，MU 与新增 N/A 回归均记录产品身份未变。正式入口由主集成在最终后端修复后重启并检查，见 [正式服务启动报告](../.local/pre-next-wave-20261023-0645/final-startup-report.json)；它与独立运行测试分开。

本报告定义的链路没有剩余失败门禁；原失败历史继续保留。未执行项目不会被静态检查、作者测试或其他链路替代。没有验证外部部署、另一物理 LAN 设备、LAN 音频或跨平台原生可执行应用；这些不由本报告扩大宣称。
