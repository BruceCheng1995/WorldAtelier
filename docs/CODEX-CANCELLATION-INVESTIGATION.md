# Codex 0.147.0 取消语义与真实进程验证

2026-09-07。仅调查和隔离验证；没有修改 root 产品文件，没有向任何操作系统 PID 发送终止信号。

## 结论

`turn/completed: interrupted` 只证明模型轮次已取消，不证明该轮次创建的执行终端已停止。本次真实验证中，取消后 Python 仍处于 `Ss` 状态并继续写入心跳，排除了 zombie 假阳性。使用官方 `thread/backgroundTerminals/terminate` 精确终止该轮次的终端后，收到真实 command `item/completed`、`status: failed`、`exitCode: -1`，OS PID 消失，心跳停止。保持 App Server 存活至原命令自然结束期限之后，没有出现结束文件。

推荐补齐宿主的“停止本次工作”语义：立即撤销该 run 的世界写入 lease；请求 `turn/interrupt`；继续接收该 turn 的迟到命令事件，按归属调用线程终端接口；向用户分别展示轮次中断和命令清理结果。无需先引入 OS 进程树强杀。

## 官方协议与源码证据

本机 `/opt/homebrew/bin/codex` 为 `0.147.0`；TS 协议由该二进制实际 `app-server generate-ts --experimental` 生成在 `.local/protocol/`。这是本次调用字段的版本依据；以下在线 main 源码只解释行为，不声称它是已安装二进制的对应 commit。

- `v2/TurnInterruptParams.ts`: `{ threadId, turnId }`。
- `v2/ThreadBackgroundTerminalsListParams.ts`: `{ threadId, cursor?, limit? }`。
- `v2/ThreadBackgroundTerminalsListResponse.ts`: `{ data, nextCursor }`；需读完分页。
- `v2/ThreadBackgroundTerminal.ts`: `{ itemId, processId, command, cwd, osPid, cpuPercent, rssKb }`。OS 元数据可为 null，本次均为 null。
- `v2/ThreadBackgroundTerminalsTerminateParams.ts`: `{ threadId, processId }`；response `{ terminated: boolean }`。
- `v2/ThreadItem.ts`: `commandExecution.processId` 是底层 PTY 的执行器标识；不能将数字字符串当 OS PID。
- `v2/CommandExecTerminateParams.ts`: `command/exec/terminate` 的标识是原始客户端 `command/exec` 请求自行指定、connection-scoped 的 ID，不能用于代理自身的 shell item。
- `v2/ProcessKillParams.ts`: `process/kill` 同样仅针对客户端 `process/spawn` 的 `processHandle`。

[官方 App Server README 的取消和终端例子](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#example-interrupt-an-active-turn) 明确区分轮次取消和后台终端清理，并说明后者需要 experimental API。adapter 已启用 `capabilities.experimentalApi: true`。

[官方 process_manager.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/process_manager.rs) 的 `terminate_process` 从当前线程的 process registry 查找执行器 ID，调用 `terminate_confirmed`，并通过实际条目引用检查避免删除已替换条目。[process.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/process.rs) 将这一操作交给实际 Local 或 ExecServer process handle。以上源码读本保存在 `.local/codex-cancellation-source/`，没有纳入产品源码。

## 真实窄测试

脚本：`tools/test-codex-cancel-process.mjs`。

证据：`.local/codex-cancel-process-1788764153568/report.json` 与同目录 `events.jsonl`。

- 真正 App Server；实际目录默认模型 `gpt-5.6-sol`。
- 新线程 `01a07aa6-e924-7bb2-beec-084af309e7f6`，新 turn `01a07aa6-e999-7ea2-bcd7-721a7165baa5`，独立 branch cwd。
- 模型只执行一次 `python3 cancel_probe.py`，不带后台 `&`。脚本每 0.2 秒追加一行心跳，18 秒后自然写结束文件。
- OS PID `5942`，真实执行器 process ID `17577`。PID 只用于 `ps` 只读观察；从不发送 OS signal。
- 中断前实际 Python 为 `Ss`，心跳 1 行。
- `06:56:00.845Z`，真实 `turn/completed: interrupted`。
- **`06:56:00.870Z`，`item/started commandExecution` 迟到，在轮次终态后 25ms 才出现。**
- 中断前后立即请求 `backgroundTerminals/list` 均为空；3 秒后列表出现该条目。
- 中断后 1 秒心跳 6 行、3 秒 16 行，`ps` 一直为 `Ss`。此时有实际副作用继续，不能将其判作已停止或 zombie。
- 对列表中同时匹配该 turn 的 item ID、process ID、独立 cwd 的条目调用 `/terminate`。`06:56:03.852Z` 返回 `{terminated:true}`，同时实际 command 完成事件为 `failed / -1`。
- 5 秒、10 秒、19 秒：PID 不存在，心跳保持 16 行，结束文件不存在。19 秒列表为空。
- `06:56:20.262Z` 才开始关闭 App Server。停止发生在 shutdown 之前，因此不是靠关服务得出的结果。
- `thread/read` 的 turn 仍为 `interrupted`，但其 items 为空；本次进程归属及命令完成证据来自实时 item 事件，而不能只依赖恢复后的 turn 内容。

该测试不涉及游戏数据、world 工具或产品 UI，不代表所有 shell/PTY/子进程形态都已验收。

## 建议的最小宿主修复

1. 在可信 adapter/manager 内记录每个真实 `item/started commandExecution` 的 `{threadId, turnId, itemId, processId, cwd}`，包括轮次终态之后到达的事件。记录持久化到会话私有 events；不要在公共消息泄露命令和路径。
2. 用户取消时，先撤销 run lease，标记该 turn 的取消意图并关闭下一 turn 的并发入口。发送 `turn/interrupt`；其 ACK 和终态保持原义，不假造 command 完成。
3. 获取线程后台终端的所有分页。只对 `itemId + processId + cwd` 与该被取消 turn 的真实记录一致的项调用 `/terminate`。不使用 UI 传来的裸 processId，不终止同 thread 较早轮次有意创建的服务。
4. 不能仅在 `turn/completed` 后查询一次：本次首个列表为空。监听该 cancelled turn 的迟到 `item/started` 后再次核对和清理；保留 cancelled-turn 的监听记录，不因短时间空列表而丢弃归属。
5. 命令清理有单独状态（如 pending / stopped / uncertain）。`terminated:false` 或超时不是成功；重查列表和真实 item 完成事件。短轮询可覆盖已观察的登记竞态，但不能将任意固定等待时间宣称为协议保证。若已知 inProgress 项仍未能确认停止，保留门禁并显示具体待清理项。
6. 只在收到清理证据后说“本次已启动命令已停止”。`item/completed` 在取消下为 failed/-1 是实际执行器输出，应保留；不能把它变成模型 turn failed 或伪造 exitCode=0。
7. 重复取消返回同一取消/清理记录，不能再次发送目标。恢复后重新核对原 thread；事件缺失、无法确认归属时保留 uncertain，不根据 PID 数值推断。

不建议对每次取消直接 `backgroundTerminals/clean`，因为它会清理整个线程的终端，包括之前轮次保留的开发服务。也不建议关共享 App Server，会影响其他 creator session。若未来需要强约束任意脱离 PTY 的后台进程、独立孙进程或互不信任用户，再设计每会话 OS/container 隔离及其生命周期；这超出了本次一个原生 Python 命令所证明的范围。

## 原测试断言修正

原 CA05 只用 `kill(pid,0)` 得出“PID 活着”，证据不足以区分执行、zombie 或复用，原报告失败应保留并附更正。新的回归测试应结合 `ps` 状态/启动身份、持续副作用计数、结束标记和实际 command 终态；让 App Server 保持运行越过自然结束截止，再关服务，以区分 interrupt、专用 terminate 和 shutdown 的效果。
