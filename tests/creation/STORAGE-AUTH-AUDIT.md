# 存储、认证与既有通道复用审查

日期：2026-09-07。源码 HEAD：`78b0b51eafeb28a2c06c8e613ec6aaf48dcc4d18`，工作树有修改；本轮源码清单哈希见 `.local/creation-verification/audit-matrix.json`。**只读结论，未运行新服务或故障测试。** 下列是当前代码事实及对新增协作创作的约束，不把原型的已声明限制泛称安全漏洞。

## 1. 可复用基础与必须守住的条件

| # | 当前源码事实 | 新路径的必要条件 |
| --- | --- | --- |
| 1 | `storage.mjs:9–18` 使用 SQLite WAL/FULL 和 `(kind,id)` JSON upsert；`:40–49` transaction 是同步函数。`server.mjs:706–714` 的旧 commit/import **已经**由同步事务包住 | 扩展时将资源修订、manifest head、文档序列、操作日志与幂等结果一起提交。不可在该 transaction 回调中 await。网络、Godot、Agent 等异步步骤先准备，提交时重新 CAS，commit 后才广播。不要把先前只读到 commitContent 函数体的误判记为现存半提交缺陷 |
| 2 | `storage.mjs:51–69` 是按 project 的全局 activity，最新 100 条，无文档或订阅游标；`:29–33` list(kind) 全量读出 | 不能把 activity_sequence 用作文档/Agent 连续序列。需要 `(project,branch,resource)` 的持久文档序列与日志、原子基线衔接、游标分页/缺口语义；会话历史不能截为最后 100 条冒充长期保存。容量尚待新实测 |
| 3 | `server.mjs:86–94,140–148` 的 `session` 是哈希 bearer token，7 天过期。用户密码 salt+scrypt；`:78–84` 只提供 project membership 与 owner/editor 写门禁 | CreatorSession/消息/run 使用独立记录和生命周期。新 edit WS、Agent 工具、直接资源读取须验证当前成员与动作权限；actor/name 由认证身份派生。分支读写限制若引入，不能仅靠客户端 branch 参数 |
| 4 | `server.mjs:344–372` 在路由 projectFor 之前回放幂等响应；`:387–391` 的 operation 读取仅按 user_id | 新操作结果涉及私有会话/资产时，需保存 scope 并在回放/查询时重查访问权。相同 ID 异参拒绝可复用，但不能把缓存响应作为绕过撤权的读取路径。此项为只读可达性风险，未执行撤权复现 |
| 5 | `server.mjs:494–539` 修改角色和删除成员；删除会关闭旧 gameplay clients；角色修改没有相同的 socket 关闭逻辑。现有 `/play` command 在接收和出队重复 membership/epoch/control 检查（`:1416–1496`） | 给新 edit subscribers、presence、短租约、排队写入和运行中的 Agent 建立对应撤权/降权逻辑；必须在实际提交时再次检查。不要只在 WS hello 或任务排队时授权一次。公共相机状态不需要挪用玩家控制槽 |
| 6 | `server.mjs:470–492` 项目 GET 返回所有 task/activity。`object-history.mjs:19–34` 把 task.title 写入公共 activity；`worlds.mjs:566–579` 给权威发去掉 history 后的完整 task | 私人 Goal/附件/工具参数不得直接塞入这些旧 task 对象。新公共状态需要专门投影白名单：授权对象地址、公开身份、操作状态及可公开变更。会话列表/内容/事件/资产均分别核验可见性，不能以对象可见推定整个会话可见 |
| 7 | `server.mjs:1106–1116` 只有 `/host` 和 `/play`。玩家 control Map 按 user.id；`worlds.mjs:162–193` 的实际宿主身份与 epoch 围栏是独立机制 | 新 `/edit` 是文档权威通道；相机/presence/个人检查不能复用玩家命令/全局 control 切换。检查只停本人输入，持续接收状态；旧 freeze/sleep 是整个世界机制，不能用于个人暂停 |
| 8 | `server.mjs:435–447` 创建项目固定加载 Starfall schema 1；`content.mjs:35–36` 只接受 schema 1。旧整份 commit/import、merge 与新 SceneDocument 结构不同；`server.mjs:1002–1034` 通过对象 hash 变化自动标 task delivered | 新 schema 2 分支要有唯一 manifest/事务入口，旧入口明确拒绝或转换，不能形成双重事实。空游戏不可默认复制固定战役。旧 task delivered 不能作为新 goal completed；新目标必须绑定 run/change/verification/delivery 因果链 |
| 9 | `services/preview/server.mjs` 为 localhost 模型预览：全局目录与 uploads、同 Origin 导入，没有用户/project 认证。`workspace.js` 使用页面内固定用户、分支、会话与本地布局草稿，Play 仍明确不可用 | 保留渲染与输入能力，但不要把预览服务或页面“切用户”当认证、多项目资产授权、数据持久化或真实多人 Play。新 GLB 必须由项目权限保护并绑定不可变依赖；两个实际用户各自认证 |

旧 hash 资产、宿主 epoch 围栏、queued command 二次核验和 SQLite 同步事务是可复用机制。它们的旧验收不自动覆盖新资源/会话/Agent 路径。旧 merge 调用（`server.mjs:720–748`）和 HTTP operation 结果落盘与内容提交并非同一事务；新增强原子提交不要复制这种分散写入结构。

## 2. 接口就绪前需要明确的最小契约

这些是待接入字段，不是声称现有端点已支持。主集成者确认后，测试驱动绑定实际 API，而不另造一套服务。

1. 新服务入口与隔离环境变量；创建空项目/schema 2 的方式；项目/分支稳定 ID、resource catalog 与不可变 manifest 的读写入口。
2. 编辑 WS 的认证、subscribe/baseline/delta/replay、作用域和 generation；事务请求/响应、冲突体、幂等键、持久化序号，以及坏操作不部分提交的可观察结果。
3. Presence 的真实 user/client identity、相机坐标约定、单调更新号、过期时限、权限撤销与取消预览语义。只读成员是否允许展示相机与选中需由明确权限契约决定。
4. CreatorSession、messages/attachments、Goal/Run、事件游标与可见性；真实 executor thread/turn/tool 关联；审批/输入、取消、续聊和恢复的接口。没有可用执行器时明确 unavailable，不返回固定完成文本。
5. SceneAssembler 与运行时支持范围，TRS 使用四元数的中央存储与欧拉角 Inspector 转换、资源 closure、真实 authority/client 启动参数和报错渠道。
6. Play 固定目标、Inspection 基线/零输入/最新缓存/恢复门禁；可读诊断只描述真实状态，不允许测试写入模拟状态或运行 ACK。

## 3. 本轮尚未验证

没有双用户 WS、服务器重启、权限故障、Agent 执行、Godot authority 或浏览器运行结果。新增代码由主集成者继续开发；本轮只落独立验收计划与审计矩阵。三项真实创作任务及全部公共状态表现仍需新证据。
