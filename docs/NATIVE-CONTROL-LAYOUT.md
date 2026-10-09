# 原生 Control 布局编辑

工作台直接编辑完整原生 Godot 源工程中的 `Control`（包括 ColorRect、Button、Label、Container 等子类）。场景、嵌套实例、材质、资源共享和未知属性仍由原 `.tscn` / `PackedScene` 表达。网页对象目录是引擎读取结果，不装配另一份 JSON 场景。

## 布局与原生覆盖

Inspector 提供位置、尺寸、四边锚点、四边偏移、旋转中心、角度、缩放、最小尺寸、增长方向、尺寸标志和扩展比例，以及常用锚点预设。尺寸受 Godot 原生最小尺寸约束。锚点操作保留当前矩形，再由 Godot 计算偏移；完整预设使用引擎 `set_anchors_and_offsets_preset`。编辑器显示参考画布尺寸；实际视口选取后使用该视口的真实测量值。保存拖动结果时提交引擎测得的四边偏移，因此重新打开或改变视口尺寸仍保持原生响应式布局。

`position` 和 `size` 是同一组四边偏移的编辑别名，没有各自独立的覆盖状态。一次布局事务以整个资源版本作并发保护。实例中显式布局赋值使用 Godot 自带的 `_edit_pinned_properties_`，保证一组中恰好等于默认值的边也不会意外跟随而改变整体尺寸。源定义后续修改时，没有覆盖的属性继续原生继承。

单行“恢复默认”恢复该行对应的原生存储字段；位置和尺寸都恢复四边偏移。锚点行只恢复锚点。整体“恢复布局默认值”恢复所有可编辑布局字段。恢复会解除对应原生 pin，重新打包时删除实际覆盖差异。撤销使用中央服务签发、带文件哈希保护的逆事务，恢复原始源文件字节；旧撤销不能覆盖后来的修改。

Godot 4.6 的 `layout_mode` 与 `anchors_preset` 是带副作用的编辑器别名：重新打包会根据当前父级计算它们，下一次加载时其 setter 可能重置继承的偏移或增长方向。源适配器先从原 `SceneState` 记录显式赋值，再使用真实 `PackedScene.pack`，仅去掉本次打包新引入而作者未赋值的这两个 Control 别名。显式源值和本次显式 set/reset 的意图保留，其他节点的同名脚本导出属性不受影响。该过滤检查引擎 bundle 版本 3；遇到未知版本拒绝保存，不猜测布局或文件结构。

固定游戏工程设置 `editor/export/convert_text_resources_to_binary=false`，让导出包直接加载原生 `.tscn` / `.tres`。Godot 4.6 默认导出转换会再次实例化并打包场景，从而重新引入上述别名；不能只修源保存而忽略出包。此设置是固定工程覆盖，提交工作区源修改时按三方比较恢复原作者配置，中央源文件不被发布策略改写。

## Container 与静态预览

直接位于 Container 下的 Control 的位置、尺寸、锚点、偏移、旋转和缩放由父容器管理。Inspector 保留位置与尺寸的只读测量，只开放最小尺寸、横纵尺寸标志和扩展比例；引擎也拒绝对受管理几何的布局操作。此类节点没有拖动或 resize 手柄。Container 自带的布局信号保留，修改支持字段后由实际容器重新排布。

编辑预览加载真实 PackedScene 的静态派生文件。所有作者 Node 脚本在入树之前移除；原生游戏脚本不会在编辑预览 `_ready` / process 中运行。构建时脚本静态初始化、自定义 Resource 构造等边界沿用隔离构建策略。布局索引与修改使用源场景的无脚本临时副本进入 SubViewport，让真实 Godot 父级矩形、Container 和最小尺寸参与计算，再只将原生存储属性写回离树的源场景。临时副本不作为源稿保存。

静态派生场景已经展开继承，打包后去掉所有 Control 的上述两个编辑器别名，保留实际 anchors、offsets、grow 和变换。源适配器保留作者意图，显示派生文件保留引擎计算结果；两者不互相写回。烘焙器代码哈希纳入固定构建身份，旧派生产物不会被当作新工具版本的结果复用。

普通 Control 显示八个边角尺寸手柄；在旋转、缩放父级与视口缩放下，指针经完整二维仿射逆变换换算。边角 resize 保持对边或对角的实际世界位置。W/E/R 对应移动、旋转和缩放。协作者预览携带固定源身份、完整对象地址、版本及原生布局，源提交前仍是临时展示。Play 与检查中的布局来自真实游戏节点的只读观测。

取消恢复拖动开始时该窗口的实际测量值；参考画布尺寸不能覆盖不同逻辑视口的观测。画布发来的选择事件只更新工作台选择和协作展示，不将相同选择与整份场景再发回引擎，从而避免选择回传中断刚开始的鼠标拖动。对象列表发起的选择仍正常发送引擎命令。

## 事务格式

```json
{
  "type": "native_scene_operation",
  "resource_id": "main",
  "expected_version": "当前资源版本",
  "operation": {
    "op": "control_layout",
    "target": {"node_id": "panel", "instance_ids": ["instance-a"]},
    "viewport_size": [1280, 720],
    "value": {"size": [320, 180], "pivot_offset": [160, 90], "rotation_degrees": 15}
  }
}
```

`value` 支持：`anchors` / `offsets` 四数组，`position` / `size` / `pivot_offset` / `scale` / `custom_minimum_size` 二数组，`rotation_degrees` 数值，`grow_horizontal` / `grow_vertical`（0–2），`size_flags_horizontal` / `size_flags_vertical`（原生位标志），`size_flags_stretch_ratio` 正数。尺寸不可负，缩放不可零。一次不能同时传 `offsets` 和 `position` / `size`。`viewport_size` 可省略，采用固定工程配置的画布尺寸。

恢复使用独立 `operation.reset:["offsets"]`，不与 `value` 或 `preset` 混用。预设使用 `operation.preset:"full_rect"`，另有 `top_left`、`center`、`top_right`、`bottom_left`、`bottom_right` 和横纵拉伸预设。引擎返回 `control_layout.values`、逐字段 `editable/stored_locally/overridden/resettable/storage_properties`、`container_managed`、`parent_type/path/size`、`minimum_size` 和 `viewport_size`。

布局冲突以原子资源组处理：同一旧资源版本的两个布局提交，即使修改不同字段，后一个也需要重读后重新提交，不静默合并。非布局的原生字段编辑仍沿用原有属性版本机制。

## 验证证据与范围

实现隔离目录为 `.local/native-framework/workers/control-layout/`。真实 Godot 4.6 引擎覆盖定义跟随、两个实例独立布局、原生 reset 去差异、预设与 TRS、Container 拒绝和实际重排、未知颜色资源保留；真实 SQLite / 源文件事务覆盖 CAS、精确字节撤销、刷新重读、过期逆操作拒绝和只读权限。

`runtime-report.json` 记录真实静态 Godot 宿主中的旋转父级拾取、拖动、八角 resize、对角保持、取消、实际节点预览、Container 重排、只读手柄和游戏观测 facade。`frontend-report.json` 记录无端口 Chrome 中实际 Inspector 的输入、单次提交、reset、预设与只读能力。该 UI fixture 的提交回调仅验证所生成的命令，不冒充服务器回执；完整原工作台多窗口与 Play 接入验收由独立测试角色运行。

可回归运行 `tests/creation/native-control-engine.test.mjs`、`native-control-layout.test.mjs` 和 `control-layout-inspector.test.mjs`。上述组件测试没有重启正式 48910 服务或修改正式游戏数据；原工作台集成与正式入口复验见 [原生框架补齐验证](NATIVE-COMPLETION-VERIFICATION.md)。

补充回归：`native-control-import.test.mjs` 检查真实导入、两次稳定保存、继承/覆盖/reset；`native-control-bake.test.mjs` 在两种实际 SubViewport 尺寸比较源与烘焙场景；`native-control-export.test.mjs` 生成真实 Web PCK，在没有松散源文件的新目录加载，比较原生布局和包内源字节。`native-selection-drag-workspace.test.mjs` 检查工作台选择回传边界；实际原 UI 鼠标拖动、字节撤销、布局取消与 Web Play 的证据单独列在补齐报告中。

## 旧固定索引的首次打开

旧版本索引可能没有 `control_layout`。读取层按 Godot 4.6 实际 `ClassDB` 导出的 Control 原生类表识别节点，仅转述旧索引已有的属性值、存储标志、覆盖标志和默认值是否可用，不重新解释继承。旧适配器离树读取到的位置和尺寸不当作有效矩形；布局面板先等待真实预览测量。

静态 PackedScene 的 loaded/selected 观测经源身份、版本、完整地址和祖先版本核对后，只补充当前窗口展示对象缺失的尺寸、局部变换与参考画布。原 source revision、resource/node/property version 和分支 head 均不修改。观测到实际布局后，第一次布局编辑直接走原有 `control_layout` 事务，无需先修改源文件或执行升级操作；只读模式仍保持只读。正式五个现有分支的只读审计确认，其 28 个登记资源没有源 Control 节点，因此此次不对这些分支重建索引或写源。

兼容证据位于 `.local/native-framework/workers/control-compat/`：真实旧适配器生成索引、真实静态 Godot 观测和首次编辑保存见 `actual-report.json`，等待测量后启用 Inspector 的实际 Chrome 验证见 `browser-report.json`。`formal-readonly-report.json` 只记录正式节点类型与源哈希核对结果。兼容行为可回归运行 `tests/creation/native-control-compat.test.mjs`。
