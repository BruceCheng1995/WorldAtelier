# 取消后的官方终端清理

2026-09-09 恢复修订：已有终态且 `cleanup_status` 和真实 `cleanup_result.status` 均为 `verified` 的记录跨服务重启保留，不再把旧任务重新变成全会话发送门禁。未确认停止的记录仍须通过原执行器核对；迟到命令仍增加清理代次并重新关闭门禁。打开受影响会话或协作重连时自动恢复状态，输入区也提供「恢复会话」。恢复不发送新目标、不生成用户答案；已失效问题由 `requests_reconciled` 事件移出待回答区。见 [本次恢复记录](SESSION-RECOVERY.md)。下方旧验证记录保留其执行时语义。

`turn/interrupt` 结束模型轮次；其 `turn/completed: interrupted` 不表示后台终端已停止。这是[官方 README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#example-interrupt-an-active-turn) 明示的区分。宿主的“停止本次工作”还需要逐条清理已确认属于该轮次的命令。

## 接入 API

```js
import { drainCancelledTurn } from './cancel-cleanup.mjs';

// Host has authenticated owner, invalidated run lease, persisted cancel intent,
// set cleanup_status=pending, and closed the session's next-turn gate.
const cleanupPromise = drainCancelledTurn(adapter, {
  threadId: run.thread_id,
  turnId: run.turn_id,
  knownItemIds: commandItemIdsFromPrivatePersistedEvents,
  onEvent: event => appendPrivateCleanupAudit(run.id, event),
  timeoutMs: 10_000,
}); // Registers late command event listener synchronously before first await.
await adapter.interrupt(run.thread_id, run.turn_id);
const cleanup = await cleanupPromise;
// Only cleanup.status === 'verified' opens the host next-turn gate.
```

`drainCancelledTurn` 自身不请求 interrupt、不重发目标、不改变 run 状态、不清理整个线程、不发送 OS signal。可以在 interrupt 已请求之后调用；调用者应确保已有事件的真实 command item ID 没有丢失。`knownItemIds` 只允许来自宿主持久化事件，不能接受用户提交的裸 ID。恢复时根服务需核对实际会话 thread 和 owner。

选项：`threadId, turnId, knownItemIds=[], onEvent, timeoutMs=10000`；可选 `quietMs=1000,pollIntervalMs=150`。恢复时可传 `knownItems`（私有持久化真实 ThreadItem）及 `knownTerminations`（真实官方 terminate 确认记录），用于 `thread/read` 返回空 items 的情况；这些选项不向浏览器开放。`onEvent` 可以异步，其结果会等待并记录失败。它输出 `kind:'cancel_cleanup'` 私有审计记录，action 为 started/command_observed/termination_requested/termination_result/uncertain/finished；这些不是伪造的 App Server item 事件。

返回：

```js
{
  status: 'verified' | 'uncertain', threadId, turnId, turnStatus,
  commands: [{itemId,processId,completed,terminationConfirmed,
    terminationAttempted,cwd?,commandStatus?,exitCode?}],
  reason, startedAt, settledAt, remainingOwnedItemIds
}
```

`verified` 要求：观察到真实目标 turn 终态；每个已知命令已完成或被官方 terminate 确认；全部分页列表不存在这些 item；经过至少两个检查以及 1 秒无新变化窗口，最后再次核对 thread 和终端列表。无法确认、断连、RPC 错误/超时、列表重复游标、归属字段变化、审计失败一律 uncertain。`terminate:false` 不自动重发，继续等待真实完成/列表证据；未确认会超时退出 uncertain。

每次 cleanup 调用结束时会注销临时监听。根服务仍须保留 cancelled turn 的持久记录，对更晚到达的 command `item/started` 将 cleanup 重新置 pending 并按同一 turn 再核对。官方没有提供“以后永无迟到命令”的流结束屏障，1 秒安静窗口只是一次有界收口证据，不是无限未来保证。新一轮门禁由 root manager 持有，adapter 的模型轮次 busy 不能替代这个 gate。

只匹配相同 thread 下已证明属于目标 turn 的 itemId；若已有 cwd/processId，列表还须一致。较早 turn 的开发服务器、其他会话命令和未确认归属项不会被终止。`thread/read` 有时返回空 items，因此必须保留事件记录，不能仅凭恢复读取去推断“没有命令”。

## 验证

`node --test tools/test-cancel-cleanup.mjs tools/test-codex-agent.mjs`：9 项明确标注 fake 的清理交互边界，加原 adapter 13 项，共 22 项通过。覆盖 terminal 先于 command started、跨 turn/thread 保留、分页、恢复归属、缺失命令 uncertain、false/超时、仍在列表不可成功、断连、归属变更与审计失败。fake 不是 OS/真实 Codex 验收。

`node tools/test-codex-cancel-process.mjs --helper`：另行启动了新的真实 CLI 0.147.0 / gpt-5.6-sol 执行，证据为 `.local/codex-cancel-process-1788764587198/report.json` 和 `events.jsonl`。本次不是复用先前手动调查记录。

- 新 thread `01a07aad-86fe-74d3-affc-8be1353ca2fb`，turn `01a07aad-8779-7603-bafa-d7f427553da5`。
- `07:03:20.236Z` interrupted，39ms 后 command `item/started` 才到。helper 的初始 knownItemIds 为空，仍捕获了这个竞态。
- 按真实 item ID 精确终止执行器 `35609`，`07:03:20.389Z` 返回 terminated:true 并收到实际 failed/-1 command 终态。
- `07:03:21.471Z` 安静窗口复查后 verified；OS PID 在此之前已不存在，心跳从此固定为 2 行。
- App Server 保持运行到 `07:03:40.481Z`，越过命令 18 秒自然结束期限，结束文件未出现，之后才关闭 App Server。未向 OS PID 发 signal。
- 本次测试报告采用观测记录，关键断言随后通过独立读报告验证；脚本后续已内置同样断言方便回归，无需再重复运行模型来验证断言代码。

本证据只覆盖实际正常执行终端中的短 Python 命令，不声称任意 detached 子进程、跨用户 OS 隔离或产品 UI 已通过。完整原因、原始失败的 zombie 证据不足和源码说明见 [调查报告](CODEX-CANCELLATION-INVESTIGATION.md)。

## 中央运行管理器接线

`services/creation/agent-runs.mjs` 已接入，保留既有消息幂等、bind 单次绑定、reconcile 门禁、动态工具 lease 和逐对象真实世界交付判断。

- run 持久化 `cancel_requested_at`、`cleanup_status: pending|verified|uncertain`、`cleanup_generation`、`cleanup_result`、真实 `command_items` 及 `cleanup_confirmed_terminations`。
- 取消先撤销写入 lease，之后中断模型与清理命令。真实 interrupted 保持原终态，清理未知不会被包装成完成；单独清理状态限制下一轮。
- 所有同 session 的旧取消 run 都参与门禁，包括较新 run 已经存在时更晚出现的旧命令。重复消息 ID 返回原 run，绝不重发目标。
- 真实 command 事件照常持久化；轮次终态后的 started 也归入准确 thread+turn。新条目重新 pending，并用 generation 防止旧 helper 把新清理状态覆盖成 verified。
- 关闭/断连中尚未完成的清理变 uncertain。服务重启保留已确认停止的记录；其他取消记录在会话恢复时从私有事件、官方确认和现有终端列表复查，不自动重跑目标。
- 公开开发状态只显示命令清理中/待核对，不含命令文本、process ID 或私人路径。

根工程验证命令：

```sh
node --check services/creation/agent-runs.mjs
node --check services/creation/codex-agent.mjs
node --check services/creation/cancel-cleanup.mjs
node --test tests/creation/agent-cancel-manager.test.mjs tests/creation/cancel-cleanup.test.mjs
```

共 14 项通过：9 项 fake helper 边界和 5 项 fake Codex / 真实隔离 SQLite 管理器测试。包括门禁、晚事件、幂等、uncertain、官方精确停止、无关终端保留及数据库关闭重开后的恢复。这是管理器接线验证，独立 tester 的实际取消验收另行记录。
