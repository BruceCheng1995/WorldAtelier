# 会话中断恢复

## 服务端自动续跑（2026-09-09）

服务器发现执行器断连，或启动时发现仍在执行的持久会话，会在后台核对原线程，不依赖浏览器保持打开。连接与状态核对最多尝试三次，间隔 3、10、30 秒；只有执行器确认原轮次为 interrupted、命令清理完成且权限有效，才沿用原线程和原目标发送一次继续。已经完成、仍在执行、轮次身份不明均不重发。每条用户发起的执行链最多自动续跑一次，恢复本身不会形成无限循环。

主动停止、等待用户回答/审批、权限撤销和 AI 限额不会触发自动续跑。续跑使用原模型、思考强度、权限及执行模式（包括原生 `/goal`），重新生成最新源稿上下文，并要求先核对已有提交，仅继续未完成部分。不会重放旧工具调用，不会消费未发送的草稿或附件。聊天中标记「服务器 · 自动续跑」。旧轮次、清理证据和自动恢复原因/尝试次数保留在原数据库中；没有资格记录的历史已中断会话不批量重新执行。

实现：`services/creation/automatic-session-resume.mjs` 与原 `CreationAgentRuns`。自动续跑仍经过原权限、AI 限额、会话提交锁、目标代次与清理门禁，已保存的取消意图不会被迟到恢复覆盖。此功能不引入自动游戏检查或验收流程。

独立回归：`node --test tests/creation/automatic-session-resume.test.mjs tests/creation/agent-recovery-regression.test.mjs tests/creation/agent-cancel-manager.test.mjs tests/creation/agent-cancel-revocation.test.mjs tests/creation/cancel-cleanup.test.mjs`，49 项通过。使用模拟 Codex 协议和真实临时 SQLite，覆盖一次续跑、定时恢复、重复请求、保留草稿、取消竞争、短暂撤权后恢复、待回答、未知轮次、命令清理及原生 Goal；与真实执行器证据分开记录。

真实执行器故障注入：`.local/automatic-session-resume/live-1788941529053/report.json`。独立数据库与工作区，在命令完成后停止专用 Codex App Server；原轮次确认 interrupted，约 4.3 秒后由定时器在同一真实线程新启一轮，完成剩余文件写入并返回 completed。未启动监听服务、未改正式游戏源稿。另一个命令运行中断连的探针（`live-1788941443452/report.json`）未通过“必定续跑”断言：执行器丢失该命令结束回执，三次核对后仍 cleanup uncertain，平台保持阻挡。这是当前能力边界，不能将空终端列表当成所有旧命令已结束的证明。

## 此前的手动核对与恢复修复

2026-09-09。修复正式 48910 工作台服务中断后旧取消记录锁住整条会话的问题。

- 已终止且清理证据已确认的记录跨重启保留；未确认的命令继续阻挡，迟到命令仍重新打开清理流程。
- 恢复优先匹配已经由执行器确认的 turn ID，不要求恢复历史必须含 userMessage/clientId。只有丢失启动回执、未知 turn ID 时才依赖原消息 ID。
- 原生 Goal 已完成轮次恢复后，可以依据实际 Goal 状态退出 uncertain；不会重放目标。
- 打开受影响会话、协作重连时自动核对状态；输入区提供「恢复会话」、进度和失败重试。草稿保持原会话绑定，迟到恢复响应不覆盖另一会话。
- 失效问题从待回答区移除，保留历史事件；恢复不虚构回答。问题卡间距收紧，底部权限/草稿状态保持一行，快捷说明由「?」浮层展开。

正式数据恢复：在确认无活动 Agent、构建及 Godot 子进程后停止原服务，使用未监听端口的维护实例调用真实 App Server read/resume 和原管理器 reconcile，随后通过 `npm run dev` 重启原 48910 服务。Bruce 的游戏控制器、封面 UI、豌豆射手、西游俄罗斯方块四条会话均返回 canSend=true、cleanup=[]。没有发送新游戏任务。真实回执保存在 `.local/session-recovery-20260909/live-recovery.json`。

独立回归使用隔离 SQLite 与明确标注的模拟执行协议，覆盖取消、迟到命令、原生 Goal、执行身份和失效问题清理；不声称重新验证游戏玩法。真实 Chrome 原工作台已确认底栏缩为一行，帮助浮层展开不会推高输入区。旧实际取消测试的跨重启预期已更新，本次未重新启动模型执行该窄测试。

聊天 HTTP 测试共用隔离端口 48921，必须串行：`node --test --test-concurrency=1 tests/creation/chat-access-input.test.mjs tests/creation/chat-settings.test.mjs tests/creation/chat-presentation.test.mjs tests/creation/session-input.test.mjs tests/creation/session-start-ux.test.mjs`。

## 2026-09-09 重复中断：大工具回执与引用上下文

本次 `session-ef5ea960-41c1-4487-90b2-80aaadf17720` 的 `world_read(resource_id=scene-cover)` 两次各返回 31,436,287 字节：错误地包含完整工程 manifest（约 30 MB），并重复携带所选节点索引。JSON 转义后的回执为 34,850,483 字节，超过执行器接收行 33,554,432 字节保护上限。第一次自动续跑再次调用同一读取，重复中断后触及一次续跑熔断。历史版本没有保存无 threadId 的 transport 诊断，因此历史 SIGTERM 原因属于回执尺寸和现有保护路径共同支持的定位；本轮增加明确诊断，不能把旧日志里不存在的退出原因伪称为已记录。

- 原生单资源读取只返回所选资源，全部场景/预制件仍以轻量目录提供；不展开全工程 manifest，不重复 native_nodes。原生文件读取和固定工程装配继续保留全部源内容。
- 所有创作工具成功结果按 JSON 编码后的实际 UTF-8 大小限为 256 KiB。大结果保存在当前会话 `outputs/tool-results/<sha256>.json`，只回传文件、字节数、哈希和简短摘要。提交成功保持 success=true；旧幂等回执重放也经过限流，不重新执行副作用。文本投影结果可按字段读取，禁止要求 Agent 整份输出大文件；原始资产字节不落入这些结果文件。
- 无线程 ID 的协议故障与断连记录保存为服务器诊断，断连原因绑定到受影响 run；仍保留原协议保护上限。
- 引用正文使用 `[@名称](attachment:稳定ID)`。Agent 输入及默认上下文只包含短引用索引；经文本投影的快照单独放在当前会话 `context/attachments/<sha256>.json`，需要时按文件读取。资产、引擎节点、矩阵不再随引用默认展开。原中央消息、附件与历史提交证据不改写，跨项目/分支校验不变。同名引用按 ID、源版本和哈希区分。
- 此次 4 个真实引用原为 227,730 字节，新索引 2,283 字节，约减少 99%。历史已发送的模型上下文不会被事后删除；后续回合使用新路径。

验证：`tests/creation/semantic-native-modes.test.mjs`、`reference-components.test.mjs`、`agent-tool-result.test.mjs`、`agent-recovery-regression.test.mjs`、`automatic-session-resume.test.mjs`、`agent-cancel-manager.test.mjs`、`agent-cancel-revocation.test.mjs`、`cancel-cleanup.test.mjs` 共 87 项通过，涵盖大数据、UTF-8/转义边界、幂等回执、短引用、不可变捕获与取消/恢复门禁。另 `agent-environment.test.mjs` 的 existing session 定点回归通过。测试使用模拟协议/独立临时数据库，不计作真实执行器证据。

真实执行器独立测试：`.local/agent-payload-fix/live-1788947610931/report.json`。62,914,684 字节合成数据通过文件回执缩为每次 770 字节，同一真实 Codex 进程连续两回合完成并读取校验标记，无协议故障或断连。没有改正式游戏源稿。

正式服务在确认无活动 Agent、构建或 Godot 子进程后受控重启，继续使用唯一 48910。原会话的最新已中断轮次经实际 reconcile 和清理门禁后，通过原 HTTP turns 接口续跑，保留同一 executor_thread_id。恢复请求先核对最新 run 与空草稿，短时本机维护登录随后撤销；不修改运行状态冒充执行结果。证据位于 `.local/agent-payload-fix/formal-recovery.json` 和 `incident.json`。执行开始与最终游戏任务完成是不同事实。

正式运行复验（18:00）：同一原线程已成功完成原先崩溃的 `world_read(scene-cover)`，回执 3,987 字节；接着 `workspace_prepare` 成功返回 51,849 字节，四条实际命令已完成，执行继续且没有断连。见 `.local/agent-payload-fix/formal-progress.json`。这是读取/恢复链路的当前证明，不把尚未结束的按钮制作任务标为完成。

另尝试运行旧 `tests/creation/agent.test.mjs`，其初始化向原生工程提交已退役的 `put_object`，在 Agent 启动前收到 422（`未知原生场景操作：put_object`），未计入上述通过数。该旧 flat 端到端夹具需要独立迁移；本轮真实执行器与原会话证据来自上面的专用测试和正式运行。

后续完成核对：原会话沿同一线程的 `run-69f98b58-979a-4b3e-a968-60c87c6e3cbe` 已实际 completed，17 条命令完成，保存源版本 `src-3045ede3a0462700daf5d66a3360053cbe8bfd3ad11ccd45c279f021788f4fae`。后续用户要求资源仅引用，因此进一步统一过滤源文件读取、附件文件、语义属性、工具回执和工程上下文，启动前自动准备 Godot 文本工作区；详见 [Agent 环境](AGENT-ENVIRONMENTS.md)。
