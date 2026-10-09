# schema2 派生运行包：待接入契约

2026-09-07。按主集成请求由独立协作 agent 只读准备；**这是待讨论方案，未实施、未运行测试、未声明运行能力。** A 的已交付源稿接口保持不变。主集成在自然交接点固定契约后，才分配实施范围。本方案不向现有任务注入执行指令。

| 包内信息 | 来源与边界 |
| --- | --- |
| 固定身份 | 主服务选择授权的不可变 revision，记录 project / branch / resource / source_revision / resource_version；关联实际 runtime_build_id、包格式与内容摘要 |
| 节点及地址 | `resolveScene()` 的完整 address、parent_key、定义版本、object_version、ancestry_hash 与覆盖后的 node；跨资源用 `scopedAddressKey()`。如需短运行 ID，保留可逆映射，内容版本变化不改变存活实例身份 |
| 局部 / 世界姿态 | 保留 local_transform、parent_world_matrix、完整 world_matrix；world_transform 为 null 时不能靠分解丢弃剪切 |
| 实例挂载 | 沿固定资源 instances 与 prefab_revisions 递归提取挂载路径、父地址、挂载 TRS、固定定义版本及定义根地址 |
| 模型与行为依赖 | 从展开后的 node 提取 model_hash、行为 script_hash 与配置，去重并核对项目权限；授权 URL 仅追加到交付副本，不进入规范内容摘要；行为状态按完整地址隔离 |
| 实际世界观察 | 保持 `resolveObjectReference()` 的 source_pose / observed_pose 分域；applied / frozen 由世界给实际矩阵和 revision / world / epoch / sequence，不能用布局姿态代填 |

**挂载接点：A 的 rows 没有独立 mount 行。** 实例根的 parent_key 跳过挂载节点，但 parent_world_matrix 已包含挂载变换。直接按 parent_key + local TRS 建树会漏乘挂载，必须在固定契约中选择显式挂载节点或精确世界矩阵读模型。

主集成固定契约时需确定四项：

1. 装配采用显式挂载节点还是世界矩阵读模型；两者都保留挂载身份及精确矩阵。
2. 首版展开数量、变换范围和剪切物理支持；A 的 4000 展开上限不等于当前运行时能力。
3. 旧 flat ID、完整实例地址、节点删除及行为变更的状态保留 / 迁移规则。
4. “继续现有 live”和“试玩当前源稿”的入口语义；按实际固定构建校验编辑预览、验证 / 发布及 join，旧 flat 世界继续工作。

可隔离准备的范围是包投影、挂载提取、地址映射、资产闭包和确定性摘要。公共 assets / worlds 接入、客户端能力、Godot 装配 / 物理 / 行为、拾取和冻结观察，以及实际迁移 / 应用，均等待固定基线及正式写入范围。

读取边界：A hierarchy.mjs `eb2b1916…5956b1`、hierarchy-references.mjs `89be6106…b42625`；主目录 assets.mjs `399e994a…9d89394`、worlds.mjs `e0085386…a15c67`。这是读取窗口的指纹缩写，worlds 已不同于 A 前次预检，实施前必须重新固定完整哈希清单。

关联：[本批验收矩阵](../INTEGRATION-VALIDATION.md)、[不抢占调度规则](../PARALLEL-EXECUTION.md#不抢占的任务调度)。被动待办见 `.local/coordination/parallel-20260907-152356/tasks.json`。
