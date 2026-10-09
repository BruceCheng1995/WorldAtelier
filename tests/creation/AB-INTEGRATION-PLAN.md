# A / B 第一阶段独立集成验收计划

2026-09-07。A 指层级/预制件模块，B 指目标验收模块；下面的“用户甲/乙”才表示两个浏览器身份。本计划依据主目录 `docs/INTEGRATION-VALIDATION.md`、20个用户 Case 及 A/B 已交付 handoff/preflight，**仅制定计划，没有运行未集成用例**。作者27项/22项自测不计为本批独立通过。

唯一独立测试者沿用 `status_vfx_test`：真实 HTTP/WS/SQLite/Agent/Godot 机制在48921、临时数据中串行执行。主集成通过 CUA 操作两个独立登录的真实浏览器，独立测试者复核原件与权威记录。不得以 Playwright CLI/MCP 绕过浏览器限制，不启动或重写生产世界，不伪造 Agent/运行 ACK、截图登记或验收完成状态。

## 执行顺序与开始条件

1. 先收口当前原样内容的圈内重启 +1；保存原失败，独立复验后再由主集成交接 A/B。旧内容8/8、恢复5/5和浏览器索引各属固定基线，不相加为新功能通过。
2. A 第一批只在主集成合入函数级接点、公开面板/能力门禁并交付源码哈希后测存储/迁移/权限。schema2 的真实 Godot 适配和匹配构建未 ready 时，只验证拒绝行为与旧房间继续，不能宣布 Case02/05 完整通过。
3. A 运行适配 ready 后，固定 schema/runtime capability 与完整地址桥接，再做模型、矩阵、拾取、碰撞、父子操作和两人输入。
4. B 必须接通真实 goal/current-run、公共路由/会话挂钩、真实验证与应用因果记录，以及可信截图/观察留存服务。任一缺失则记具体阻塞，不能在测试中直接 put 一条 fake artifact 来绕过。
5. A、B 同一最终源码/构建完成交叉验证和受影响旧内容回归。只扩大失败涉及的相关检查；每个变体保留未执行/失败/通过状态，不用模块文件存在或作者自测代替。

## 计划矩阵

所有行当前状态为 **未执行，等待正式集成基线**。

| ID / 对应 Case | 必须实际完成 | 最小失败路径与留证 |
| --- | --- | --- |
| AB00 / 门禁 | 两个隔离旧 flat 场景、现有运行房间、旧附件与已有 Agent 目标；显式迁移时固定 expected_head，前后字段/资产/行为内容对应 | 能力未接时所有新候选入口明确拒绝；旧 live 固定 manifest 继续 tick/input。不能保存成功后因旧 publicState 投影异常向客户端报保存失败；重试不得重复写 |
| A01 / Case02 | 真实 GLB、多轴旋转、非均匀缩放、非零Y，移动父级后子级变换与实际 Godot 世界矩阵一致；保持世界姿态重挂、一次撤销/重做、拖动 Esc/失焦取消 | 完整祖先任一改变拒绝陈旧世界坐标请求；不可表达的局部剪切拒绝且原内容不变；保留 world matrix、local quaternion TRS、实际图形/拾取对照，不能只比较JS函数自算值 |
| A02 / Case05 | 两场景三个同源实例；单例颜色覆盖、独立修改定义、固定影响预览、只升级选中实例；嵌套路牌随小屋移动 | 定义保存不自动改所有 pin；覆盖保留；删除被覆盖节点/路径必须明确冲突和逐项决议，失败不半写，重开后保持。既有 flat 复制品不能推断成新实例 |
| A03 / Case09、10 | 甲乙真实 WS 同文档：不同完整地址修改都保留；同目标 TRS 冲突；甲撤销不覆盖乙的后改；删除当前选中节点 | 订阅代次/迟到预览、条件逆操作、ancestor_version/object_version 不符拒绝；真实浏览器两边的选择/相机/草稿独立 |
| A04 / 运行入口 | 对本次请求的固定 source revision 生成派生包：定义闭包、资产/行为 hash、完整4×4矩阵、地址表进入同一匹配 runtime；两视口及 Play 对齐 | 不把展开平面列表写回 source；不悄悄继续旧 playable；构建 capability 必须纳入 build identity。缺定义、循环、预算/权限拒绝且旧房间保留 |
| B01 / Case13主体 | 同一小屋两个真实目标，只验收其中一个；UI分别显示执行/技术/应用/体验四层；逐条件选择实际试玩证据再 pass/reject/revise | delivery/工具结束不自动 accepted；目标正文、标准和固定 run不可由当前选中对象补齐；未通过条件或缺体验证据不能 pass；纯编辑 requires_application:false 不用于规避玩法验证 |
| B02 / Case13变体 | 各自真实执行：受控工具失败并续修；较长命令中断并核对精确清理后新轮；真实输入/审批由原会话主人答复 | 每变体单列结果；未出现真实请求即未执行，不固定假回复。空 turn 的 MCP 请求留在会话层，不归“最新目标”，连接断开不等于已解决 |
| B03 / 证据可信 | 真实浏览器采集/运行轨迹留字节、服务侧 receipt、sha256、固定 pin；通过认证 resolver 读取再决策 | 任意 URL/本地路径、自报 applied、客户端 JSON pose、技术验证报告不能冒充体验截图；篡改字节、错 goal/run/build/epoch/地址、旧证据全部拒绝；晚采集不能写入新挂载 |
| B04 / 续修与持久 | revise 后同 goal 新 run、新 review cycle，原目标和决定不改写；超时原ID重放同结果；重启恢复历史和完整 backlog | 不每次消息另建无关联 goal；把 goal关联意图纳入指纹；旧 terminal 不覆盖新current run；重复广播不得再append同一持久事件 |
| B05 / Case07、17 | 私人/共享/显式委派、项目 owner、读者和编辑者权限分别实际验证；撤权后的旧页面、重放、读取均重新鉴权 | 项目owner无默认代验；共享读权无审批回复权；公共维护信息不含私人正文、日志/证据路径；证据留存按session权限，不能借公开模型资产路由暴露 |
| X01 / 嵌套目标 | 两座小屋各含同名门：各附到不同真实目标，Agent仅改一个，验收也仅关闭一个；切场景/分支/会话再核对 | 端到端保持 project/branch/resource/instance_path[]/definition_node_id；不能以裸node_id去重。移动祖先后旧空间附件保持原观察，不漂移 |
| X02 / 验收版本 | 对已accepted目标仅推进正常world sequence，应继续有效；然后改源或升级prefab，旧决定保留为historical并要求新cycle | 当前B按整个source revision保守失效，不能写成精细依赖分析。head更新不可伪加入旧run.changes、不可只替换review.revision |
| X03 / 留存恢复 | 保留 review→evidence→artifact字节/inspection→revision/verification/delivery/build 完整链；真实服务重启后可读取 | 旧cycle不是可随意回收的临时文件；当前备份工具若不含creation.sqlite及证据字节则只记缺口，不能借旧备份报告宣称通过 |
| R01 / 原三内容与旧路径 | 同批构建下重走礼花圈外加入/应用、圈内应用和恢复、exit/reentry；珊瑚 E；星门编辑与 Web Play；个人检查→乙继续→返回实时 | 核对三任务原制作来源与hash、真实输入和画面；重启/切分支/取消围栏按受影响代码窄测。旧截图不是新批回归 |

## 必须随证据保存的身份

| 域 | 固定字段 |
| --- | --- |
| 构建与内容 | 实际源码文件SHA/提交、runtime_build_id/capabilities、project/branch/source revision/resource version、固定 prefab_revision 闭包、GLB/GDScript hash |
| 对象和变换 | address(project,branch,resource,instance_path[],definition_node_id)、local node.version与解析object_version各自用途、override/dependency版本、完整ancestor指纹、local quaternion TRS与world/parent matrix；source/applied/frozen分域 |
| 协作请求 | user/session/socket/peer、subscription generation/doc sequence、transaction_id/base/expected_head、条件逆操作、receipt和权限时点 |
| 执行 | creator_session、goal、goal_revision、current run/cycle/lease、client_message_id、真实executor thread/turn/item/process、pending request归属、取消清理证据 |
| 技术与应用 | 本轮因果关联 verification_id、candidate revision/build/state_hash、delivery_id、world/epoch/applied_sequence、真实Godot PID与ACK |
| 体验验收 | review_id/version/criteria、evidence_id/artifact ref/hash/kind、观察world/epoch/sequence/build/address/inspection、decision_id/outcome/actor、幂等ID、previous_review_id |

旧 inspection 没有可靠 runtime_build_id 时不得按现在的构建补写历史事实；要求新采集或明确的不可变历史绑定。读库只能用于核对真实 API/运行产生的记录，不能用于造 fixture 执行成功、目标接受或权威 ACK。

## 保留的后续范围

个人检查中编辑（Case06/11/12 的对应部分）、原生/离线与不同客户端接续（Case19/20）、从空游戏完整旅程 Case18 不由本批局部通过自动关闭。新手是否理解入口/影响范围需要真人走查；Agent自行点通不制造虚构的用户研究结果。

计划交付引用：[主集成矩阵](../../docs/INTEGRATION-VALIDATION.md)、[职责与顺序](../../docs/PARALLEL-EXECUTION.md)、[浏览器证据边界](../../.local/creation-verification/browser/INDEPENDENT-REVIEW.md)。A/B 的具体路由仍以正式集成后的实现为准；本计划不把 handoff 中的建议路由当成已上线接口。
