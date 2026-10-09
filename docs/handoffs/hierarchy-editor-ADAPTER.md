# 层级编辑薄适配器

隔离实现；不接生产服务、Godot 或新 runtime pack。依赖 A 当前 resolved row、manifest 和 `packages/scene/transform.mjs`。交付只包含两个前端文件、本说明和专属测试；隔离目录中的 A 服务/数学副本仅是测试依赖，不覆盖主工程。

## 纯函数

`apps/creation-workspace/hierarchy-editor.js` 导出：

- `fullAddressKey(address)`：严格使用 project/branch/resource/完整 instance_path/definition_node_id；与 A scopedAddressKey 的 JSON 编码一致。
- `lookupResolvedRow(rows,address)`：完整地址查找。不存在返回 null；重复地址报错，不按名字、末级 ID 或 renderer ID 补位。
- `captureTransformTarget({scope,branch,row,readOnly=false})`：在拖动开始时固定并深冻结 branch head、地址、node/object/outer-instance/resource/definition 版本、ancestry hash、精确世界/父世界矩阵和局部 TRS。只允许 source hierarchy。A 内部 chain 不属于返回 row，不依赖此字段。
- `buildWorldTransformCommit(target,worldMatrix,{readOnly=false,transactionId})`：返回 `{transaction_id,base_revision,ops:[op]}`。默认新 UUID；网络未确认时调用方保留已生成 payload 原样重试。必须传完整列主序 4×4；不接受将潜在剪切压成欧拉 TRS 的 fallback。
- `withWorldPosition(matrix,[x,y,z])`：仅替换第 12–14 位，保留全部旋转/缩放/剪切基底值。不会修改输入。
- `localTransformFromEuler({position,rotation_degrees,scale})`：使用 A 的 Godot YXZ 欧拉角→规范四元数，验证 A 的局部 TRS 范围。

普通节点提交 `set_node_world_transform`：`expected_version=node.version + expected_ancestry_hash + world_matrix`。

嵌套节点提交 `set_override_world_transform`：外层 `instance_id/expected_version`、`expected_object_version`、`expected_ancestry_hash`、完整相对 `target.instance_path` 和 `world_matrix`。移动实例内部 root 仍是明确的内部节点覆盖，不自动改成实例挂载操作。捕获时外层实例版本来自同一固定 branch；A effective object_version 覆盖嵌套依赖版本，防止误配旧 row 后冒用新实例版本。

```js
// start: 保存整份固定上下文，后续不能取最新 row 替换它。
const drag = captureTransformTarget({scope,branch,row,readOnly:!editable()});
// commit: 完整矩阵来自实际 gizmo；移动工具可用 withWorldPosition。
const payload = buildWorldTransformCommit(drag, observedWorldMatrix, {readOnly:!editable()});
// 主宿主重查当前 scope / 模式 / 权限，然后按 captured scope 发送；ACK 才替换 canonical。
await transact(drag.address, payload);
```

客户端只读检查不是授权边界。主宿主在模式/分支切换时丢弃 drag，服务器继续验证权限及 expected versions。收到 409 保留错误/草稿，不能用最新版本自动重发原移动。

文件使用相对 import `../../packages/scene/transform.mjs`。若主服务将前端模块平铺至 `/hierarchy-editor.js`，还需授权静态入口 `/packages/scene/transform.mjs`；本次未改服务白名单。

## A 面板可选区域

```js
const panel = new HierarchyPrefabPanel(host, existingHooks, {
  regions: ['inspector'], // tree / inspector / catalog / impact；省略则保持原完整面板
  readOnly: true,
});
await panel.setContext(scope);
panel.setSelection(fullAddress); // 默认 notify:false，外部同步不会回调循环
panel.setReadOnly(false);
panel.setImpact(pinnedImpact); // source_revision 必须等于当前 branch.head
```

- 三个独立宿主可各建一实例，分别传 `['inspector'] / ['catalog'] / ['impact']`，复用现有 read/resolve/transact/preview hooks。
- `select(address)` 保留用户选择通知；`setSelection(address,{notify:true})` 仅在选择变化时通知。作用域不同直接拒绝；删除后的地址不映射到别的节点。
- readonly 禁止 run 回调和直接 submit；所有编辑控件禁用。层级选择、打开独立预制件属于导航仍可用。readonly 在 await 中发生变化时，后续 submit 仍拒绝；finally 不会重新放开只读控件。
- impact 独立宿主由外部 `setImpact()` 注入同版本真实预览结果。默认面板仍自行调用原 preview hook。

## 本次验证

`node --test tests/creation/hierarchy-editor.test.mjs`：8/8 通过。六项纯地址/矩阵/事务测试实际调用 A `applyHierarchyOps`，覆盖世界剪切平移、同名嵌套目标隔离、祖先/依赖版本拒绝、只读/域拒绝及 YXZ 多轴旋转。两项面板测试用明确 FAKE DOM 检查区域/选择回调/只读门禁，**不代表真实浏览器布局或 Godot gizmo 体验已验收**。两个前端文件语法检查通过。
