# 真实 Codex App Server 接入

适配器：`services/creation/codex-agent.mjs`。2026-09-07 在本机 `/opt/homebrew/bin/codex` **0.147.0** 与已有 ChatGPT CLI 登录上验证。服务使用 `codex app-server --stdio`，不读取凭据文件、不导出 token、不使用固定回复代替执行。

[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 描述公开协议；本实现字段以当前 CLI `generate-ts --experimental` 生成的本地类型为准。协议含实验能力，升级 CLI 必须重新生成并复核字段。

```sh
codex --version
codex login status
codex app-server generate-ts --experimental --out .local/protocol
```

`.local/protocol` 是核对用第三方生成文件，不进入项目 Git。

## 可信宿主 API

```js
import { CodexAgent } from './services/creation/codex-agent.mjs';
const agent = new CodexAgent({
  workspaceRoot: '/absolute/private/creator-workspaces',
  networkAccess: true,
});
agent.on('event', event => persistPrivateEvent(event));
agent.on('request', request => showOwnerRequest(request));
await agent.start();
const catalog = await agent.listModels();
const model = catalog.data.find(m => m.isDefault)?.model;
const scope = { projectId, branchId, userId, sessionId };
const created = await agent.createThread({
  cwd: '/absolute/private/creator-workspaces/one-branch', scope, model,
  dynamicTools, onDynamicTool,
});
// 原子持久化 scope、cwd、threadId、model、dynamicTools，再开放发送。
const threadId = created.thread.id;
const clientUserMessageId = crypto.randomUUID();
// 必须先持久化用户输入、附件快照与 clientUserMessageId，再执行发送。
const started = await agent.sendTurn(threadId, {
  text, attachments, clientUserMessageId,
});
// turn/start 响应仅表示已开始，不能把它当作完成。
const terminal = await agent.waitForTurn(threadId, started.turn.id);
```

所有方法只向中央服务内部暴露；不能把 `threadId` / `requestKey` 直接当作用户授权。宿主必须对每次读取、发送、审批、动态工具及事件订阅验证 session owner、project membership、branch scope 和运行状态。其他协作者不能读私人会话。

| 方法 | 行为 |
| --- | --- |
| `start()` / `stop()` | 启动、初始化或关闭本机进程 |
| `createThread({cwd,scope,dynamicTools,onDynamicTool,model?})` | 创建持久化线程，返回真实 thread/start 响应 |
| `resumeThread({threadId,cwd,scope,dynamicTools,onDynamicTool,expectedTurnId?,expectedClientUserMessageId?})` | 先 read 校验工作目录，再 resume 并返回 reconciliation |
| `readThread(threadId,{includeTurns:true})` | 读取真实持久化线程与 turn 状态 |
| `sendTurn(threadId,{text,attachments,clientUserMessageId,model?,effort?})` | 捕获不可变附件，持有单线程运行锁，发送真实 turn |
| `waitForTurn(threadId,turnId,{timeoutMs,signal})` | 只等真实 completed/interrupted/failed；取消等待不等于取消执行 |
| `interrupt(threadId,turnId?)` | 请求模型轮次中断；仍须等 terminal 事件确认，后台命令需要另行清理 |
| `listBackgroundTerminals(threadId,{cursor,limit,timeoutMs}?)` | 官方 experimental 分页列表，processId 是执行器标识，OS 元数据可空 |
| `terminateBackgroundTerminal(threadId,processId,{timeoutMs}?)` | 官方精确终止；宿主必须先核对所属 turn 的真实 item ID |
| `pendingRequests(threadId?)` / `replyRequest(requestKey,result)` | 列出等待用户的请求，转发方法对应的精确响应 |
| `accountStatus()` / `listModels()` / `rateLimits()` | 从 CLI 读取实际状态和目录 |
| `restart()` | 只重启进程，不恢复、不发送、不重跑 |

Scope 要求四个非空字符串 `projectId/branchId/userId/sessionId`。工作目录必须是 `workspaceRoot` 下独立的真实子目录；创建、恢复和每次发送都核对 realpath。恢复后不能在同一绑定上切换分支或用户。新适配器实例没有宿主的身份数据库，因此跨进程 scope 权限依赖宿主持久化绑定。

## 真实工具、shell 与附件

初始化使用 `experimentalApi:true`。线程使用 `ephemeral:false`、`historyMode:'legacy'`、`sandbox:'workspace-write'`、`approvalPolicy:'on-request'`、`approvalsReviewer:'user'`。每个 turn 同时发送实际 `workspaceWrite` sandbox policy、唯一 cwd 和 writableRoots，排除临时目录写根。普通 shell 与文件编辑能力保留。

用户已授权本任务网络需求，故默认 `networkAccess:true`；这不会自动回答 App Server 发起的审批请求。`workspace-write` 约束写入，**不是完整文件读取隔离**。当前生成的 schema 没有较新文档中的细粒度读取限制字段。要让互不信任的远程用户各自拥有强隔离，需要宿主使用独立 OS 用户/容器/VM；仅不同 cwd 不提供该保证。

```js
const dynamicTools = [{
  type: 'function', name: 'world_read',
  description: 'Read the authorized branch document and exact object versions.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}];
async function onDynamicTool(request) {
  // request: threadId, turnId, callId, namespace, tool, arguments,
  //          requestKey, scope, cwd, signal
  // 此处重新核对 owner/branch/权限/运行状态，而不是相信模型传入的参数。
  const result = await authorizedWorldRead(request.scope, request.arguments);
  return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
}
```

`DynamicToolSpec` 支持上述 function 和 `{type:'namespace',name,description,tools:[function...]}`。`item/tool/call` 回调只允许绑定声明内的工具。失败返回 `success:false` 和真实错误。断连、请求解除或 turn terminal 时 AbortSignal 中止；宿主也必须在真正写入前检查 signal 与持久化 run 状态。

`thread/resume` 在 0.147.0 **没有 dynamicTools 参数**。声明由 Codex 持久化；宿主恢复时提供同一组声明用于回调路由，不把它传到 resume RPC。已用重启后原始 `world_read` 再调用实测。需要改变工具集合时创建新线程，不宣称恢复参数能更改声明。

同一连接重复工具 RPC 的最近 256 个结果会缓存重发，不再次调用 callback。跨连接的副作用幂等性仍由中央服务按 callId/事务 ID 持久化承担。`world_apply` 应执行 expected versions + transaction ID 原子事务；`asset_publish` 应读取 cwd 内真实文件、校验路径/类型/大小后发布不可变 hash。适配器不实现这些世界权限与资源逻辑。

附件在 sendTurn 第一个 await 前复制，校验存在的 project/branch 字段与会话一致，限制 2 MiB，并生成 SHA256。输入把它们作为第二个 text item 的不可变 JSON 观测传给 Codex；附件不是当前权威状态，不因切分支自动改绑。root 应保存附件来源 revision/resource/object/version/坐标。文件与图像可以通过宿主受限资产工具解析；本接口不把任意附件 JSON 冒充视觉图像输入。

## 事件与真实审批

`event` 是完整可持久化流：`{epoch,sequence,receivedAt,kind,...}`。epoch 为一次进程连接 UUID；sequence 在该连接内递增，宿主需追加自己的持久化会话序号。`notification` 保留官方 `{method,params}`，包括 assistant delta、item started/completed、dynamicToolCall、fileChange、commandExecution 及输出。stderr 是 CLI 诊断，不能渲染成助手完成消息。UI 所有输出当文本处理，不能执行工具输出中的 HTML。

其他 kind 包括 submission、serverRequest、serverRequestReply、threadBound、reconciled、requestUncertain、lateResponse、protocolError、disconnected。`terminal` 只来自 `turn/completed` 且状态为 `completed/interrupted/failed`。一段助手文本、一条工具 success 或 turn/start ACK 都不是整个任务完成证明；世界修改是否实际生效还需中央事务与 Godot 真实确认。

取消轮次与停止命令是两个独立结果。中央运行管理器用持久 `cleanup_status` 和新轮次门禁收口，详见 [取消清理接入与证据](CODEX-CANCEL-CLEANUP.md)。

`request` 事件含 `requestKey/category/method/params`。没有自动同意、超时同意或合成用户答案。宿主认证所有者并按原方法验证 response 后调用：

| 请求方法 | result 形状 |
| --- | --- |
| `item/commandExecution/requestApproval` | `{decision:'accept'|'acceptForSession'|'decline'|'cancel'}`，其他更细权限变体需按实际 schema 实现 |
| `item/fileChange/requestApproval` | 同上，呈现改动明细后由用户决定 |
| `item/tool/requestUserInput` | `{answers:{[questionId]:{answers:['实际用户答案']}}}` |
| `item/permissions/requestApproval` | 实际 permissions + scope 对象，不能用通用 decision 替代；尚未实现的 UI 应保留等待并明确显示 |
| `mcpServer/elicitation/request` | 按实际 schema 和请求 form/url 类型回复，不可臆造答案 |

未知请求以 category `unsupported` 转发并保留等待。旧连接请求不可回复；重复回复拒绝。`currentTime/read` 是唯一自动处理的非工具请求，响应本机真实 Unix 秒数 `{currentTimeAt}`。事件可能含用户文件、命令内容与个人账户信息；只向该会话授权人展示，公共证据需脱敏。

## 断线、恢复与模型失败

RPC 超时或断连是 **uncertain**，不是失败终态。适配器不重试 turn/start、工具效果或用户提交。宿主先记录 clientUserMessageId 再调用 sendTurn；如果回执丢失，重启后这样恢复：

```js
const restored = await agent.resumeThread({
  threadId, cwd, scope, dynamicTools, onDynamicTool,
  expectedTurnId: storedRun.turnId || undefined,
  expectedClientUserMessageId: storedRun.clientUserMessageId,
});
// 仅 reconciliation.canSend=true 才允许下一轮。
```

恢复比对 turn ID 和 userMessage.clientId。线程 idle 但没有找到预期消息仍保持 `uncertain:true,missingExpectedTurn:true,canSend:false`；找到持久化的非终态也保持运行锁。已确认的 terminal 才能解除该轮不确定性。`thread/read` 历史缺项或加载失败不能作为“此前没有执行”的证据；应继续人工核对完整 CLI 历史，不能为了重新开放按钮把状态改成 completed。宿主进程重启必须传回已持久化的预期 ID，适配器无法凭空知道丢失的提交。

实测 CLI 配置默认 `gpt-6-astra` 在本机 0.147.0 会真实终态失败：该模型要求更新 CLI。失败原文与事件保存，没有重跑或改写成功。实际 `model/list` 的 isDefault 是 `gpt-5.6-sol`，经用户授权后新测试线程明确选择该模型，三轮成功。新建会话可以使用实际目录 isDefault 并显示名称；既有会话模型不得静默覆写。显式切换模型和重试必须成为新的用户操作，保留此前失败记录。`account/read.requiresOpenaiAuth` 表示服务是否需要授权；不能将其误读为“尚未登录”，应同时检查真实 account。

## 实际验证与边界

```sh
node --test tools/test-codex-agent.mjs
node tools/test-codex-agent-live.mjs
node tools/test-codex-agent-interrupt.mjs .local/codex-live-1788761004165
node tools/test-codex-agent-reconcile.mjs .local/codex-live-1788761004165
```

本轮结果：

- 13 个显式 fake-transport 单元测试通过：审批/input 保留、动态工具范围、原子发送锁、附件快照、terminal/start 竞态、超时与断连、不确定恢复、symlink 路径替换、重复工具回执、终态 callback abort。它们只验证适配器边界，不能算真实 Agent 执行证据。
- `.local/codex-live-1788761004165/report.json`：真实 `gpt-5.6-sol` 同一线程三轮 completed；每轮调用真正的宿主 world_read，再执行原生 fileChange 与 shell 验证。修改只限 `adapter-note.txt`，内容逐轮增加 phase=one/two/three。已验证同进程恢复、进程重启后 thread/read、持久化工具恢复和不可变附件 X=1.25。
- 同目录 `interrupt-report.json`：观察真实 shell 命令开始后请求中断，实际 terminal 与持久化 thread/read 均 interrupted；文件不变，恢复后可继续。
- 同目录 `reconcile-report.json`：使用实际 userMessage.clientId 对应已完成 turn 恢复成功；不存在的预期消息继续关闭发送；此补验没有发送任何新 turn。
- `.local/codex-live-1788760864397/`：保留配置默认模型不兼容的真实失败，未覆盖。

这不是前端 Agent 集成、权限隔离部署、共享场景编辑或三项游戏内容制作验收。那些必须由接入后的工作台、中央事务与 Godot 运行结果单独证明。本适配器没有预制这些验收内容。
