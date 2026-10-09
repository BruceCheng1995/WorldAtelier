# 批注上下文

2026-09-10 新增点选、画框、笔刷批注及合并到新 Agent 草稿的闭环，见 [视口导航与批注](VIEWPORT-ANNOTATIONS.md)。`viewport_annotation` 使用 context version 3；既有单对象附件与检查快照继续兼容。

2026-09-07：在现有对象／空间锚点附件上增加 `context_version: 1`，兼容旧消息，不回填或改写历史附件。

`POST /creation-api/sessions/:s/attachments` 固定源稿，`inspection-attachments` 固定经世界服务核对边界的个人检查。两种入口都接受可选 `camera: {position, target, view, projection}`；对象身份、版本和坐标由服务端从已授权的不可变资源解析，客户端不能覆盖。

| 内容 | 字段与含义 |
| --- | --- |
| 作用域 | `project_id / branch_id / session_id / resource_id`，完整 `address / instance_path / definition_node_id` |
| 源稿版本 | `source_revision / resource_version / object_version / definition_revision`，资源名称和类型也在批注创建时固定 |
| 坐标约定 | `coordinate_system`：米、右手 Y-up、局部旋转为 XYZW 四元数、矩阵按列存储；`origin` 指定资源和源版本 |
| 源稿姿态 | `source_pose`：局部 TRS、完整世界矩阵／位置、直接用于局部换算的 `parent_world_matrix` |
| 父链与实例 | `parent_address / parent_version / ancestor_chain / ancestry_hash`；`prefab_instances` 记录每层实例路径、固定定义版本和挂载变换 |
| 所见姿态 | 个人检查使用 `domain: frozen` 和独立 `observed_pose`，保留 `observation` 的世界、epoch、sequence、检查 ID、状态哈希和停止输入回执 |
| 相机 | 可选的客户端位置、目标和投影；标明 `source: client_viewport`，不作为权威世界状态 |

场景的空间名为 `scene_world`；独立预制件编辑器使用 `prefab_definition`，其原点不属于某个已摆放实例。flat 文档的原始 `snapshot.rotation` 仍是 Godot YXZ 欧拉角（度）；新增 `local_transform.rotation` 统一使用四元数，`snapshot_rotation_format` 明确区分。层级父级旋转和非均匀缩放可能产生世界剪切，保留完整矩阵，不强行分解世界 TRS。

对嵌套预制件根节点，`parent_address` 是最近的源节点，`parent_world_matrix` 还包含中间实例挂载变换。计算关系是 `source_pose.world_matrix = source_pose.parent_world_matrix × matrix(source_pose.local_transform)`；不能把此矩阵直接当作 `parent_address` 节点自身的世界矩阵。

兼容字段 `position / world_position / world_matrix` 在源稿附件中表示源稿姿态，在检查附件中表示所见姿态；`source_pose` 始终表示源稿，检查不会把动态姿态写回初始布局。缺少的新字段在旧批注详情显示“未记录”。

工作台会固定匹配当前文档、视口代次、模式和源版本的最近一次相机观察，缺少匹配记录时保存 `null`。批注写入期间发送按钮等待保存，避免消息漏带新附件。草稿、已发送消息和 Agent 的输入都保留同一份快照；Agent 修改前仍必须读取当前源版本和祖先链。

验证入口：`node --test tests/creation/annotation-context.test.mjs`。测试使用临时 SQLite；其中所见世界、执行器与 RPC 是明确的测试替身，只证明坐标、存储、界面展示函数和输入序列化契约，不代表一次真实 Godot 试玩或付费 Agent 执行。
