# A+B：嵌套实例目标与固定验收的真实交叉验证

独立驱动：`tests/creation/hierarchy-review-live.test.mjs`。仅在明确允许真实 Agent 调用时运行；每次创建新的独立用户、项目、会话和世界，真实执行两轮 Codex。它不启动或停止服务，不操作浏览器，不应指向普通用户现场。

```sh
WORLD_ATELIER_RUN_REAL_CROSS_REVIEW=1 \
WORLD_ATELIER_CREATION_CODE_ROOT=/absolute/path/to/frozen/code \
WORLD_ATELIER_EXPECT_RUNTIME_BUILD=<64-hex-build-id> \
node --test tests/creation/hierarchy-review-live.test.mjs
```

服务固定为 `http://127.0.0.1:48921`，需要实际 Agent、Godot worlds 与 hierarchy 功能已启用，冻结代码的 Godot import 缓存已准备完毕。模型取实际 `/agent/status` 返回的默认值。运行时源文件与构建 ID 必须匹配。驱动只清理自己的 WS/角色控制，并保留项目及 0600 私有访问文件供后续 UI 复查；不会终止共享服务。若真实 turn 超时，不可直接重跑而重复派发目标，应先核对同一 run 的终态。

| 阶段 | 实际路径和断言 |
| --- | --- |
| AX01 | 新项目显式迁移到 schema2；两个同名门通过两层固定 prefab 实例化，实际 GLB/行为资产装载；完整地址和运行时 ID 各自独立。 |
| AX02 | 同一真实会话的两个新目标，各有固定附件和真实 thread/turn 关联；右门只读验证/应用，左门只修改自己的实例颜色覆盖，再真实验证/应用。 |
| AX03 | 对照完整源稿证明右门、两个定义和 TRS 不变；Godot 验证报告给出两份真实节点地址、矩阵和资产。 |
| AX04 | 两份服务端原始 runtime_trace 固定版本、世界、序号和 SHA；实际输入只使左门计数 0→1，右门仍 0；委托审核员提交证据和决定，继续 tick 后仍有效。 |
| AX05 | 重试同一决定返回原回执；撤销审核委托后旧请求 403；撤销项目成员后读/写及旧 WS 都被拒绝，原决定不变。 |
| AX06 | 修改门定义不会自动改变旧实例；显式固定预览由内到外只升级左门，真实发布后保留计数；旧验收转为历史，新版本不能借用旧 run 创建验收。 |

首次实际运行：2026-09-07，固定构建 `1dde489c662e22971a8cf586aa7c278f92451d13c21944ed8d91f6666bbd0b25`，**6/6 阶段通过**（Node 含父测试 7/7，exit 0）。证据目录：`.local/creation-verification/hierarchy-review/2026-09-07T11-05-00-459Z-e8c9d3ec/`，以 `SUMMARY.md`、固定 `report.json`、`executed-driver.mjs` 和 `independent-audit.json` 为准。

边界：本套是实际 HTTP/WS、Codex 和 headless Godot 验收。通用 beacon 模型作为门的模型 fixture；计数脚本复用前一轮真实 Agent 生成的不可变资产，明确没有由测试者预写本轮 Agent 修改。AX06 的后续定义改动由测试驱动通过普通编辑 API 执行，不是 Agent 交付。两份 runtime_trace 的 `render_verified` 为 false；不计浏览器鼠标、实际视觉、Case02/05/13 UI 或任意 Agent 能力通过。源分支 head 改变时审核按全局 revision 保守失效，即使另一对象内容未变，也不能称为目标级局部验收失效策略。

首轮 Agent 有两次真实 `world_apply` 参数格式拒绝，均未写入源稿；随后 Agent 自行只读查询契约示例，第三次调用成功。最终功能通过不代表无操作摩擦。后置只读审计曾两次误解 capture request、原始 pin 与保存 artifact 元数据的区别，修正审计器后通过；这些审计失败保存在 `audit-attempts.json`，未改动产品或原六阶段结果。
