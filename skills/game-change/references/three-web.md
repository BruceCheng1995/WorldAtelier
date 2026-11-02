# Three.js Web 与 Godot 游戏迁移

在当前会话的 editable_project_directory 内工作。中心版本固定整份工程。场景、预制件、实例覆盖、稳定对象地址、资源与公开属性保持原有身份。在两个实现里按同一套对象和参数取值。编辑保存、构建、公开发行各有自己的记录。

## 用户内容对照

从当前固定版本读取目录、入口及其依赖。按资源 ID 记录场景跳转、实例与覆盖、公开属性及有效值、使用的素材、脚本创建的 UI、动作/输入、计时、碰撞、音效、存档域和胜负条件。两个目标可以使用不同渲染和代码实现。可调整的数据放在现有原生绑定或两个目标都读取的同一源文件。对无法等价迁移的行为逐项说明。

## Web 入口

在同一工程写入 `web/main.js`。导出 `createGame({THREE, renderer, canvas, ui, entrySceneId, source, storage, loadScene, getPrefab, signal, timers})`。返回带 `scene` 和 `camera` 的对象，可实现 `update(deltaSeconds)`、`resize(width,height)`、`control(packet)` 与 `dispose()`。使用框架持有的 renderer 和帧循环，输入监听器在 dispose 时移除。编辑器中的静态场景不执行这里的代码。

`resize(width,height)` 收到的是按本版本 `project.godot` 拉伸策略适配后的游戏区域，单位是 CSS 像素。HUD 挂在传入的 `ui` 上，屏幕坐标以 `canvas.getBoundingClientRect()` 为准；计算指针位置时扣除该矩形的左、上偏移。

`source` 固定当前入口及其对象地址。可投影的场景可从 `source.three_projection.nodes` 逐个调用 `createProjectedNode(THREE,row)`（从 `@world-atelier/scene` 导入）生成对象，使用其世界矩阵、几何、材质和光照。如果场景包含导入网格、蒙皮、图片、复杂材质或 Control，在同一版本加入 `web/native-visuals.json`（内容 `{"format":"wa-native-surfaces-1"}`）。先用 `await loadProjectedResources(THREE, source.three_projection)` 取得本场景的资源 Map，再传入 `createProjectedNode(THREE,row,resources)`。两者均从 `@world-atelier/scene` 导入。首次派生走隔离的无窗口 Godot，输出随固定源与工具身份缓存。游戏只从自己的隔离构建取图像与网格。原始 GDScript 行为需要显式迁移。

`source.behavior_parameters` 提供原生兼容行为的稳定路径和有效参数，包括实例覆盖。`await getPrefab(id)` 从同一构建读取预制件定义及有效参数，用于游戏中新增实例。`await loadScene(id)` 切换到同一版本的其他场景。工程里的相对模块和素材与脚本同版本。可以相对导入一个 GLB 获得构建资源 URL，再通过锁定的 GLTFLoader 加载。官方扩展入口覆盖 OrbitControls、EffectComposer、RenderPass、ShaderPass、OutputPass 与 OutlinePass。使用后处理时在游戏返回值里提供 render(deltaSeconds) 绘制当前场景。遇到不可投影的 UI、材质和动态节点时，按该版本的实际代码和资源移植，使用真实用户内容。普通浏览器游戏逻辑可使用 Three.js 自定义场景。写 Godot 目标时，从同一目录更新原生场景、脚本、资源和 project.godot，保留未知文件及原有覆盖。

原生 Control 同时有 WebGL 绘制和 HTML 点击区域时，从 `@world-atelier/scene` 导入 `bindProjectedControls`。传入当前场景的原生投影和绑定数组，例如 `[{path:subject.native_path, object:board, element:buttons, designSize:[1120,800], fitViewport:true}]`。返回的函数在每次 `resize(width,height)` 中调用，返回 Godot 逻辑视口大小；用这个大小设置正交相机。画布几何从左上角开始，向右和向下为正，HTML 容器直接位于游戏 UI 层的原点。普通 Control 默认按其布局矩形缩放。只有原生脚本也按视口居中绘制固定设计画布时才设置 `fitViewport:true`。换一个有实例覆盖的源版本，确认源位置、实际绘制与点击目标一起移动。

通过现有 world_apply submit_native_workspace 提交固定基础版本上的全部相关变更。先完成迁移并保留对应内容，再提交选择 Web 引擎的入口文件。

异步加载用当前场景的 `signal` 取消过期请求，并用 `timers.setTimeout`、`timers.setInterval` 或 `timers.requestAnimationFrame` 注册属于这一关的延迟工作。检查时的游戏专有输入状态可在 `pause(frozen)` 中清理，销毁时释放资源和订阅。

给 HTML 控件绑定源对象时，仅在它确实代表该 Control 时写入唯一的 `data-wa-native-path`。普通动态按钮也可以按屏幕位置讨论，观察结果会区分运行时对象和有固定源地址的控件。输入框和私有嵌入区域不进入画面。最高分转移需要在 `web/save-schema.json` 显式声明。例如 `{"format":"wa-config-high-score-1","file":"neon_stack.cfg","section":"records","key":"best"}` 对应 Godot ConfigFile 和 Web 的 `storage.getItem("neon_stack.cfg/records/best")`。用户在同一项目、分支和存档域内选择是否带入较高的整数成绩。

## 结果核对

在两个目标中从同一入口、相同公开参数和初始状态执行操作。比较对象身份、初始布局、关键帧、操作反馈、胜负/重开与存档结果。按实际执行情况报告源 revision、Web build、Godot 工程或包和未核对项。原生 game_validate 只覆盖 Godot。Web 目标需使用实际 Web Play。只有收到明确发布请求才推进公开发行指针。
