# 层级 Agent 纯适配器交接

文件 `services/creation/hierarchy-agent.mjs`。依赖 root/A 已有 `hierarchy.mjs`、`hierarchy-view.mjs`、`schema.mjs`；无 DB、网络、运行控制或全局当前分支读取。主集成仍负责授权、事务因果、Agent lease、B goal 生命周期与公共投影广播。

## 接口

所有 scope 必须显式包含 `{project_id,branch_id,resource_id}`，目标与 scope 冲突即拒绝。跨资源 ops 先按资源分组。

### targetFromAttachment(attachment, scope)

返回 `{address,resource_id,object_id,source_revision,object_version,resource_version,definition_revision,node_version?}`。nested 的 object_id 为 null；address 是完整实例路径。仅保留附件已记录的版本；旧字段缺失仍为 null，不查询任何 manifest 补造。旧 flat 对象按明确 scope 转空实例路径，历史附件本身不改写。私有 snapshot、position、任务文本不会出现在此返回值。

### targetsForOperations(manifest, scope, ops, sourceRevision)

输入必须是调用方明确选定的不可变 manifest 及其真实 revision。返回地址去重的固定目标引用。

- 普通节点名字/外观修改：该节点。祖先 transform、put/delete/reparent、世界变换：该节点与展开后代（包括其下挂载的嵌套实例）。
- 实例挂载、创建/删除/升级/恢复：完整实例路径前缀下的所有展开对象。
- 覆盖：外层 instance_id + 完整相对 target；transform 覆盖包含后代，其他字段只包含目标。
- 资源创建/删除/恢复与迁移：给定资源当前固定快照内全部对象。
- flat 继续识别 put/patch/delete_object，保持旧 ID。

新对象仅在提交后存在，删除的实例/资源内部对象仅在提交前存在。主宿主必须保存真正的事务前 manifest/revision，并在 ACK 后另提取真正的结果 manifest/revision，再按完整地址结合两组结果；**不能只拿结果 head 补已删除实例**。有明确 node/object ID 的已删除节点返回 `missing:true` 和 null object_version；不存在实例无法凭裸 instance_id 发明内部节点地址。若同时保留 before/after 引用，应分别保留固定版本；如何更新 run.targets 由主宿主/B 生命周期明确处理，不回写历史附件。

### resolvePublicTarget(manifest, scope, target)

返回 `{runtimeId,address,contentFingerprint}` 或 null。runtimeId 复用 root `hierarchyRuntimeId()`；跨资源/分支比较与缓存始终用完整 address，不能只用 runtimeId。

- flat 指纹严格沿用旧逻辑：对象内容删除 version 后 hash。
- hierarchy 指纹包含有效 node（去 version）、完整 world_matrix、路径上固定 prefab 依赖版本。仅目录新定义变化不改变旧固定实例；显式升级固定依赖会改变指纹。
- 不把移动的源 revision、整个场景 resource version 或无关对象变化放进内容指纹。祖先位置、目标有效外观或适用固定预制件版本改变会改变指纹。
- 不返回原始 node、组件正文、位置或私人内容，仅返回指定字段。

此函数故意按**传入 manifest**解析 address，不按 target.source_revision 自动跳转；这样主宿主可分别比较 current-source / at-delivery / in-world 三份明确版本。target 原始捕获版本仍留在引用中供 B 的陈旧性核验。不存在返回 null，不能把多个 null 判定为已交付/已验收。

### worldApiGuide(manifest)

返回与 manifest.schema 匹配的 WORLD-API 指南字符串（flat 或 hierarchy）。包括完整地址、局部四元数/世界剪切、普通与嵌套写入版本门禁、固定 prefab 与显式升级、迁移、真实验证/应用/验收分层、Godot log-file 与共享浏览器边界。不会写文件；root 的 workspace 生成器组合 origin、实际 API 文件位置和此字符串，不要继续写死 flat 指南。只在实际 world_read/固定 schema 接入后更新，不能悄改执行中的目标。

## 验证

`node --test tests/creation/hierarchy-agent.test.mjs`：8/8 纯测试通过，使用真实 A 解析/纯事务函数和固定内存 manifests，没有替代性运行 ACK。覆盖：固定附件与私文裁剪、同名嵌套门、挂载/祖先变换影响、删除及缺失路径、flat 历史/旧 hash、不自动追目录最新版、scope/schema 拒绝。`node --check` 通过。未启动生产、Agent 或 Godot；真实 manager/B/UI 集成尚由 root 串行完成。
