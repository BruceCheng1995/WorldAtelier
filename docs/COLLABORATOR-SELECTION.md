# 协作者对象选中提示

2026-09-08，集成到原 48910 创作工作台。

同一项目、分支和文档中，另一视口选中对象时，在 Godot 编辑视口绘制账号代表色模型描边和仅显示姓名的小标签，不附加“编辑中”。颜色沿用 `userColor(user)`，与顶部头像、相机标记一致。提示表达当前选中编辑上下文，不构成排他锁；本人仍可正常选择和操作，写入沿用原版本冲突门禁。

当前描边使用屏幕遮罩后处理，不再使用法线膨胀。每个选中对象先渲染真实几何的可见覆盖，再提取连通区域的外边界并填实，门框、环形模型等封闭空洞不再产生内描边；与屏幕外部连通的凹口仍保留。遮罩提取和后续扩展使用屏幕像素，不修改原模型材质、顶点、碰撞或源包围盒。

同一对象被多人选中时，每个账号拥有一层完整的独立颜色遮罩，从物体边缘向外排列；本地观察顺序较新的用户位于内层，同账号多窗口去重，输入数组顺序和相机移动不改变层次。各层宽度均使用“显示”菜单中的描边宽度；所有层先合成，再统一应用不透明度，避免内层混入外层颜色。相同选中几何复用一次遮罩提取，但不再淘汰其他选中用户。独立对象分别保留自己的遮罩。姓名标签与相机提示继续使用账号代表色。

本人选中也统一使用模型描边，保留原变换手柄，不再显示包围框。独立对象编辑同样使用描边；检查模式中的本人选择描边跟随当前显示的只读投影。

2026-09-09：Agent 开发状态也复用同一屏幕轮廓遮罩，移除旧维护圈和黄黑施工标记，保留状态文字与状态颜色。Agent 状态标签与用户姓名标签共用 `remote_selection_overlay.gd` 的屏幕定位、字号、背景、截断和多人避让，不再单独生成 Label3D；多选逐对象使用同一链路，重复状态文案只显示一次。同一对象的多个 Agent 合并为一层开发提示；与用户选择同时存在时保留独立颜色层，用户选择位于内侧。Agent 层采用缓慢流动的明暗虚线，用户层保持静态实线；动画只在最终合成中处理，不逐帧重新提取几何遮罩。开发状态清空或切换文档时回收对应描边，宽度和不透明度沿用当前视口设置。

「显示 → Agent 操作描边」可单独隐藏或恢复 Agent 轮廓，不影响本人选择、他人选择、相机和状态文字。开关默认开启，沿用按账号保存与同浏览器窗口同步；已有设置缺少该字段时默认开启。

层级对象按完整 project/branch/resource/instance_path/definition_node_id 匹配。切文档、取消、断线清除；重新订阅发布当前选择。协作者选中仅在编辑模式显示，独立游戏启动没有引入编辑覆盖层。选中本身不修改源对象，也不发起 Agent。

视口右上角「显示」菜单分别控制他人选中提示和他人相机；关闭前者会同时隐藏协作者描边和姓名标签，不影响本人选择。描边宽度范围 0.5–8 CSS px，不透明度范围 0–100%，本人和他人共用样式，默认 4 px / 85%。设置仅影响自己的显示，按账号 UUID 保存在当前浏览器，并在同浏览器同账号窗口同步；不声称跨设备同步。场景加载完成或重载后重放最新设置，消息受文档与场景代数校验。

## 实现与同步

- `runtimes/model-preview/remote_selection_overlay.gd`：不截获鼠标的姓名标签，由已有 `collaboration_overlay.gd` 接收 presence。
- `remote_selection_outline.gd`：按选中几何分组、按账号去重并保留多层所有权；`remote_selection_mask_layer.gd` 与两个 shader 渲染、填实、分层合成屏幕遮罩。取消选择、切换模式或重建场景时回收对应资源。
- `collaboration-client.js` / `workspace.js`：浏览器本地维护选中观察顺序；100 ms 尾沿合并发送最新选择、模式和客户端选中意图。重复点击同一对象仍形成新的选中意图，相机更新不改变本地顺序。
- `preview-bridge.js`：文档切换清掉旧 pending presence。
- `services/creation/realtime.mjs`：只转发当前选择和客户端生成的 `selection_intent`；不生成时间戳、`selection_order` 或胜出用户。相机节流不能吞掉选择/模式/意图边界；subscribe 重置语义去重状态。

## 首轮包围框验证（历史）

当时运行的历史命令（其中 Godot 描边场景及入口已于 2026-09-09 按用户要求删除，不再执行）：

```sh
node --test tests/creation/remote-selection.test.mjs tests/creation/remote-selection-godot.test.mjs tests/creation/collaboration-regressions.test.mjs tests/creation/preview-camera.test.mjs
```

21/21 测试通过，其中实际 headless Godot 执行 19 项投影、Canvas 绘制、标签布局和模式/地址边界检查。Node 状态测试使用真实 SQLite/域模型与明确的 FakeSocket；不将模拟传输计为浏览器证据。报告位于 `.local/creation-verification/remote-selection/2026-09-08T05-42-57.488Z/`。

正式编辑 Web 构建 `860fbdc28aa7b41630a50807e44f58098d03970ab44a1011d37df53f108feeb3` 已由标准 `npm run build:preview` 导出归档。原 48910 用两个已有独立账号实际观察：B 选信标时 A 看见 B 的青色框；A 选星门时 B 看见 A 的绿色框；A 点击空白取消、或打开独立星门预制件时，B 原场景标记消失。固定源版本 `src-82fedb85e1a…`，本轮没有提交对象变更。实际截图位于 `.local/creation-verification/remote-selection/live/peer-selection.png` 和 `document-switch-cleared.png`。

服务端修复已在核对无进行中 Agent/构建/在线玩家后，通过原守护启动入口更新到 48910，健康检查通过。已有浏览器需刷新才能加载新的前端和编辑 Godot 构建。本轮验证的是编辑协作提示，不代表完整游戏玩法或全平台导出验收。

## 描边修订验证（2026-09-08）

本轮编辑 Web 构建 `c028b1ffc22b7557a650cc5abb2c1e18fdaece204e8a6838c33e8c41e0da163e` 已导出归档。本次无需重启服务。

同一独立命令 21/21 通过，Godot 内部 32/32 检查通过，新增源 mesh/材质/对象 bounds 不受影响、独立辅助节点、多人同对象及父子重叠颜色合并、取消/Play/对象重建清理检查。证据 `.local/creation-verification/remote-selection/2026-09-08T06-16-10.575Z/` 同时保存实现/测试/Shader 哈希。

原 48910 双账号实际验证了协作者选中星门后的模型轮廓及小姓名显示，没有协作者矩形框；观察账号取消本人的选择后仍可看见协作者轮廓。截图 `.local/creation-verification/remote-selection/live/peer-outline.png`。测试标签已关闭，未编辑共享源稿、进入游戏或发起 Agent。骨骼与形变绑定有实现路径，本轮实际画面覆盖静态 GLB，未声称验证任意自定义顶点 Shader 动画。

## 全部选中与个人显示设置验证（2026-09-08）

当时编辑 Web 构建 `3431ae02c224e744ada77708a45c93d706e9ee2da642ea7d96b8a408cd2ea6cc` 由标准构建导出，正式 48910 浏览器已实际加载。

独立验证命令在上述四个测试文件基础上加入 `tests/creation/display-settings.test.mjs`，25/25 测试通过，实际 Godot 内部 54/54 检查通过。覆盖本人和独立编辑选择、只读投影、相机和选中开关独立、实际 shader 宽度/不透明度、越界及非法值处理、账号存储隔离、同账号窗口同步、初载和重载重放、旧场景消息拒绝。结果与实现/测试哈希保存在 `.local/creation-verification/remote-selection/2026-09-08T06-24-34.003Z/`。

正式 48910 两个独立账号实测：关闭他人选中后，自己的浮台描边与变换手柄保留，远端相机仍可见；关闭相机后仅保留本人描边；重新开启他人选中可看到星门描边及姓名。设置 4 px / 50% 后实际轮廓改变，刷新页面仍保留该设置和关闭相机状态。实测后恢复两个开关开启、1.75 px / 85% 默认值，关闭自有测试标签页。

实际截图位于 `.local/creation-verification/remote-selection/live/`：`display-selections-hidden.png`、`display-peers-hidden.png`、`display-width-opacity.png`、`display-settings-persisted.png`、`display-settings.png`。本轮未提交共享对象变更。

## 默认宽度调整（2026-09-08）

按用户后续要求，默认宽度改为 4 px，范围扩大为 0.5–8 px，步长仍为 0.25 px。界面、浏览器数据归一化、Godot 渲染器和 Shader 默认值及范围保持一致。已有个人自定义宽度继续保留。

编辑 Web 构建更新为 `74466c9150918e61e3f95fdddf903f7caba565aac9eb2bce7fb65545339bc892`；已从正式 48910 HTTP 入口核对新界面范围、JS 默认值及清单 44 份源码哈希一致。构建成功，无需重启服务。

独立复验 `display-settings.test.mjs` 与 `remote-selection-godot.test.mjs`，5/5 测试、Godot 内部 54/54 检查通过，覆盖实际 Shader 默认 4、8 px 可用、超界限制为 8 和已有自定义宽度保留。证据 `.local/creation-verification/remote-selection/2026-09-08T06-41-04.134Z/`。

## 多人轮廓跳色修复（2026-09-08）

用户报告类似 Z-fighting 的现象。实际 GPU 对照确认两个原因：

- 同一 mesh 的多人描边本来只画一个辅助副本，静止连续帧没有变化；旧 Shader 的 12 px 屏幕固定硬条纹使对象相对画面平移时发生换色。对齐对象后，移动 1 / 6 / 12 px 的轮廓换色比例分别为 8.24% / 49.89% / 100%。
- 不同选中对象的半透明外壳近共面重叠时，相机横向位置从 -0.01 到 +0.01 可使透明绘制顺序翻转，85.17% 公共轮廓像素换色。这里是透明排序而非两个描边互写深度；Godot 官方文档也说明写入 `ALPHA` 会进入可能发生排序问题的透明管线：[Spatial shaders](https://docs.godotengine.org/en/stable/tutorials/shaders/shader_reference/spatial_shader.html)。

现将屏幕细条纹改为围绕对象世界包围盒中心投影的大段颜色，颜色交界按像素导数平滑；同一对象所有部件使用同一锚点，父子范围重叠时确定性选用较大范围锚点。颜色排序固定，不依赖 presence 顺序。不同颜色和锚点组合分配稳定的材质绘制优先级，避免相机移动时半透明外壳交换层叠顺序。原模型深度遮挡、默认 4 px、0.5–8 px 范围及不透明度设置均保留。

修复前实际 GPU 证据：`.local/creation-verification/outline-render-audit/`（静止、平移、近共面重叠帧和像素比较 JSON）。编辑 Web 构建为 `3566e89bd6e3ad51aab64a3429baaff00b8f93d21552057682d7913251f4a49e`，正式 48910 清单 44 份源码哈希一致；同一正式入口双账号共同选中星门，已确认大段青/绿轮廓并保存 `remote-selection/live/stable-shared-outline.png`，随后关闭自有测试标签页。本轮未编辑共享对象数据。

独立实际 GPU 修复回归 7/7 通过，证据 `.local/creation-verification/outline-render/2026-09-08T06-50-45.438Z/` 保存 12 张帧、像素比较、渲染日志和实现哈希。相机平移 1 / 6 / 12 px 后对齐物体的轮廓换色均为 0；近共面不同颜色对象的相机左右变化也没有交换轮廓颜色；反转用户输入顺序不改变画面。该量化覆盖隔离合成对象的 OpenGL Compatibility 实际 GPU 帧，不替代任意用户模型和任意镜头的验证。

后续显示设置与实际 headless Godot 回归 5/5 测试、54/54 内部检查通过，证据 `.local/creation-verification/remote-selection/2026-09-08T06-51-08.266Z/`。当时 GPU 回归入口为 `tests/creation/outline-render.test.mjs`（现已删除），自有 GPU 测试进程和临时 runtime 已清理。

## 同一轮廓只显示一个用户（2026-09-08）

用户认为分段颜色仍随视角变化，要求同一轮廓只保留一位用户。Figma 官方资料确认其多人体验同时展示活跃参与者的光标和选中状态，并依靠参与者身份颜色提供上下文，但未说明多人同时选中同一节点时的轮廓冲突规则：[Multiplayer Editing in Figma](https://www.figma.com/blog/multiplayer-editing-in-figma/)。这一轮先采用本人优先、稳定用户 UUID 兜底的单色规则；后续“后选者优先”的本地规则见下节。姓名和相机仍可表达其他同时编辑者。

Shader 已移除多色数组、屏幕条纹和视角色段，仅接收一个 `outline_color`。父子对象共享同一 mesh 时也按同一优先级收敛为一个颜色；不同对象的近共面透明轮廓继续使用稳定绘制优先级，避免相机移动时排序翻转。编辑 Web 构建更新为 `86c325760e259991346263541de65dfc7bf8430cf283480a2aff006ac4f99b4a`。

正式 48910 入口用主创和协作者 B 同时选中北侧星门：两个视口各自只显示本人的青色描边，同时保留对方代表色的“编辑中”姓名标签，没有分段线。截图 `remote-selection/live/single-color-same-object-owner.png` 与 `single-color-same-object-collaborator.png`；自有测试标签页已关闭，未修改共享对象数据。

独立验证 6/6 测试通过，实际 GPU 10/10、headless Godot 55/55 检查通过。多人同对象帧与稳定胜出用户的单人参考帧为 0 像素差；反转 presence 顺序、本地优先、本地取消后恢复远端均为 0 像素差；1 / 6 / 12 px 相机平移和近共面不同对象仍无颜色交换。父子共享 mesh 的实际 Shader uniform 只有胜出用户颜色，而两位协作者姓名标签仍同时存在。证据 `.local/creation-verification/outline-render/2026-09-08T07-03-13.037Z/` 与 `remote-selection/2026-09-08T07-03-13.037Z/`，自有 Godot 进程和临时 runtime 已清理。

## 后选者优先，由浏览器本地裁决（2026-09-08）

用户进一步要求“谁后选中，显示谁”，并明确选中与描边应由本地处理，不由服务器管理。当前实现把每个协作者的 `[对象、地址、模式、selection_intent]` 作为浏览器观察指纹；指纹变化时，本地递增顺序。每段几何只使用本地顺序最高者的账号代表色。重复点击已经选中的同一对象会递增客户端意图，因此也能重新成为胜出者；相机位置变化沿用原意图，不会抢占描边。胜出者取消、切换模式或离线时，本地回退到仍在选中该对象的下一位用户。

服务器没有选中时钟、全局序号和胜出者逻辑，也不接收客户端伪造的 `selection_order`。它只校验并转发当前选中状态及非负整数 `selection_intent`，用于让各浏览器识别一次新的选中动作。新加入浏览器从当前 presence 快照建立自己的初始次序，不把它冒充为加入前的历史先后；之后的实时变化都在该浏览器本地排序。

主创与协作者 B 用编辑 Web 构建 `7293e8e2eed84853d0c171f78ec90806cee625a2fc316bfd79aa41d4a6ff4c08` 在正式 48910 的同一北侧星门上实测：B 先选、A 后选时，两个视口都显示 A 的绿色描边；B 再次点击同一已选对象后，两个视口都切换为 B 的青色描边。截图为 `.local/creation-verification/remote-selection/live/latest-selector-owner-view.png` 和 `latest-selector-collaborator-view.png`，测试页随后关闭。

完成注释清理后，标准构建重新导出为 `d7353bed644cf78cea7440b1491871b325dacbd5a3cd8178cba76b8cbc101732`；正式 48910 的 `/preview-runtime/manifest.json` 已返回该版本及 44 份当前运行源码哈希。

独立验证 17/17 测试通过，实际 GPU 11/11、headless Godot 58/58 检查通过。覆盖服务器不生成或转发顺序、100 ms 合并内的重复选中意图、后选者胜出、相机更新不抢占、取消后恢复、同账号多窗口去重，以及 1 / 6 / 12 px 相机平移与近共面轮廓稳定性。最终复验证据保存在 `.local/creation-verification/outline-render/2026-09-08T07-30-54.140Z/` 和 `.local/creation-verification/remote-selection/2026-09-08T07-30-54.141Z/`。


## 屏幕填实遮罩与多人分层（2026-09-08，当前）

以上当前行为取代历史章节的反向外壳和“仅保留后选者”规则。`BitMap.opaque_to_polygons` 的外边界在二维遮罩中填实，再以 `Geometry2D.offset_polygon` 的圆角偏移产生每个用户独立的外层。原始覆盖仅用于提取边界；最终合成减去的是填实后的遮罩，所以不会描到内部封闭孔洞。

静止画面复用已经生成的遮罩；相机、可见几何变换、骨骼或形变改变时重新提取。相同几何上的多用户共用一次 GPU 读回，用户颜色、层次或宽度变化仅重建二维层。覆盖图在帧末读取，下帧合成；此路径涉及 GPU 读回，不声称纯 GPU 或零延迟。透明裁剪与自定义顶点 Shader 仍不属于统一遮罩材质的适配范围。

本次独立 GPU 检查 14/14 通过，覆盖封闭孔内无描边、开放凹口保留、32 个方向的双色完整分层、账号去重、静态缓存、相机移动、完全遮挡与取消清理。证据：`.local/creation-verification/outline-render/2026-09-08T14-59-01.293Z/`。最终编辑 Web 构建 `64c662c99a9da1788ed41bab34da6bcaa05074e80d6c24c2a45be61897cbe259` 已从原 48910 清单核对四个实现文件哈希。未做多对象高分屏压力验收，实际用户场景由用户继续验证。


2026-09-09 多选：对象列表用 Ctrl/Cmd 单击增减选择、Shift 单击连续选择；场景视口用 Ctrl/Cmd 单击增减选择、Shift 单击追加选择，普通单击替换整组，普通单击空白清空。每组最多 128 个对象，整组分别描边，属性和变换手柄仍对应主选对象。选择变更通过独立消息传给现有视口，不重新加载场景或取消视口正在进行的原生拖拽。协作 presence 使用 `selected_objects: [{id,address?}]` 同步整组，保留 `selected_id/selected_address` 主选中兼容字段；每个完整地址独立核验，换文档清空整组。相机消息不改变整组选择的层次顺序。Agent 仍可同时标记多个开发对象，独立开关作用于所有 Agent 描边。


## 2026-09-09 标签统一与测试场景移除

Agent 与用户选择由同一显示行集合驱动，3D 外轮廓继续共用遮罩与多层排序，Agent 可保留动态虚线。2D 选择同样共用矩形层、宽度和不透明度；Agent 与协作者标签共用屏幕标签组件，统一多选避让及清理。Agent 描边开关仍只影响轮廓，不隐藏状态标签。

已删除 outline-render、remote-selection-probe、multi-selection-probe 三组专用合成描边场景及对应 Godot/GPU 测试入口；历史报告仅保留作记录。后续普通修改不恢复或重复运行描边专项场景，按实际改动做必要的轻量检查。

本轮检查：Godot 导入、短启动及标准 Web 导出通过；`display-settings.test.mjs` 与 `preview-camera.test.mjs` 共 24 项通过。正式 48910 `/preview-runtime/manifest.json` 返回构建 `d8041c782e873adf4af5a02c39f4913cc93849b596fa1359a223d4a93c8ab2b0`，五个修改实现文件的 HTTP 清单哈希与工作区一致。本轮未运行专用描边场景，也未启动真实 Agent 制造测试状态；不将编译和消息检查算作真实多人标签视觉验收。
