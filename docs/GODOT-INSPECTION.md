# Godot Web 个人检查与实时创作：源码依据

> 2026-09-08 用户纠正：编辑器内 Play 改为每个窗口独立的一局；暂停只暂停该局，默认隐藏游戏 UI、保留自由相机，并提供 UI 显隐与重新开始。共享创作仍同步源稿。本文中的中央世界实时加入/检查协议仅适用于明确加入共享世界，不再是编辑器 Play 的默认行为。当前实现与新证据见 [预览模式](PREVIEW-MODES.md)。

2026-09-07，只读分析本工程保留的 Godot 4.6 stable 源码；源码版本见 [version.py](../research/godot/4.6-stable/source/version.py)。结论是现有公开能力支持实现本设计，尚无理由先改引擎；但这不是新功能已运行通过的证据。

## 暂停的实现选择

不暂停主循环、不停止 iframe、不冻结在线权威。客户端按职责拆分：

```text
Transport / LatestStateStore     持续收包、验证、ACK、有界最新状态
AuthoringDocumentStore           共享创作文档、确认事务、版本
PresentationController          live / inspecting / resuming
FrozenPresentation              固定呈现姿态与资源引用
SubViewport / CameraRig         继续渲染、漫游、独立资源编辑
EditorOverlay                   拾取、操作柄、锚点、协作者提示
```

| 引擎源码 | 实际依据与设计含义 |
| --- | --- |
| [scene_tree.cpp](../research/godot/4.6-stable/source/scene/main/scene_tree.cpp#L1100), 1100–1117 | set_pause 同时控制整个客户端 PhysicsServer 活跃状态，不是 SubViewport 独立暂停 |
| [node.cpp](../research/godot/4.6-stable/source/scene/main/node.cpp#L901), 901–932 | process_mode 控制节点的处理资格；ALWAYS 可继续处理，但不提供不可变对象隔离 |
| [viewport.cpp](../research/godot/4.6-stable/source/scene/main/viewport.cpp#L4670), 4670–4772 | own_world_3d 隔离 World3D/scenario，不复制节点状态，也不创建独立 SceneTree 时钟 |
| [world_3d.cpp](../research/godot/4.6-stable/source/scene/resources/3d/world_3d.cpp#L49), 49–60 | 独立物理 space 和渲染 scenario 可支持独立预制件/检查环境 |
| [viewport.cpp](../research/godot/4.6-stable/source/scene/main/viewport.cpp#L5475), 5475–5478 | UPDATE_DISABLED 停渲染，无法一边保持该模式一边用自由相机得到新视角 |
| [emws_peer.cpp](../research/godot/4.6-stable/source/modules/websocket/emws_peer.cpp#L44), 44–47、137–153、202–204 | WebSocket 由浏览器回调入包；Web poll 本身为空，停 _process 会阻止应用消费而非阻止入包 |

检查投影只由受控呈现组件创建，避免复制整棵带玩法脚本的树又触发 _ready 和游戏副作用。停止向它应用实时姿态、动画和插值；相机始终活跃。process_mode=DISABLED 也不能阻止其他代码调用 setter，例如 [Node3D::set_transform](../research/godot/4.6-stable/source/scene/3d/node_3d.cpp#L392)。

完整冻结还要覆盖动画/骨骼、粒子和材质时间。GLES3 的 [begin_frame](../research/godot/4.6-stable/source/drivers/gles3/rasterizer_gles3.cpp#L97) 持续累积渲染时间，所以使用 TIME 的 GPU 特效不会因节点停 _process 自动固定。组件契约要提供呈现时间/姿态冻结或明确不支持，不能泛称任意节点都已冻结。

## 同时保存三个版本身份

- FrozenView：world、runtime、release、scene_revision、epoch、snapshot_sequence、source_tick、presentation_time、实际呈现姿态、不可变资产引用。
- LatestWorld：后台最新的 runtime、release、epoch、sequence 和状态缓存。
- AuthoringDocument：project、branch、scene、revision、各实体版本与当前创作变换。

插值后的画面可能不等于最新权威 tick，必须记录实际呈现姿态和对应水位。网络消费 ACK 不表示 GPU 已显示。现有 [snapshot ACK/backpressure](../services/control-plane/server.mjs#L1126) 可复用，但需拆分连接/控制授权/呈现模式。

冻结资源不能使用相同路径原位覆盖或盲用 CACHE_MODE_REPLACE。文本加载器 [资源重用路径](../research/godot/4.6-stable/source/scene/resources/resource_format_text.cpp#L575)（575–580、734–737）可能重置已有资源对象，使旧快照悄悄变样。固定哈希路径、只读资源共享和可变实例状态隔离才是正确边界。

恢复时完成/取消当前操作柄事务，清输入；固定一个目标版本；准备匹配资源和最新基线；核对 runtime/release/epoch/control_generation；在帧边界切换并清旧插值。失败保留检查场景。旧 runtime 收不到不同 runtime 的快照时，需要外层工作台准备新实例并交接，不能继续按旧协议解析。

## 坐标、拾取与共享布局

Godot [世界到局部变换](../research/godot/4.6-stable/source/scene/3d/node_3d.cpp#L413) 使用父级全局变换的 affine_inverse。文档操作必须检查完整祖先链的层级/变换指纹与解析后的父级世界变换；只看直接父级局部版本，会漏掉祖父移动。任何祖先被移动、重挂或删除时，用旧矩阵提交都可能把对象放错位置。

[Camera3D 射线](../research/godot/4.6-stable/source/scene/3d/camera_3d.cpp#L393)可从视口像素产生真正 3D 拾取射线；输入转换参考 [Viewport](../research/godot/4.6-stable/source/scene/main/viewport.cpp#L3464)。页面缩放、DPI、iframe/SubViewport 尺寸都需纳入换算。旧应用投到 Y=0 的拾取方法不能继续作为通用编辑器。

预览拖动与持久提交分开：begin_transform 获短租约；preview 限频广播；commit 带对象/父版本且一次提交完整 TRS；cancel/断连使预览过期。同节点冲突必须可见；Agent、原生插件与手动操作共享同一服务。Godot 变换 API 本身没有多人冲突语义。

动态物体的冻结位置属于观察证据；正常 gizmo 编辑的是创作文档变换。只在明确“应用所见姿态为初始布局”时做带基线的转换事务，不能恢复播放时把物理状态写回场景。

## Web 桥接、模型导入与脚本边界

| 源码 | 可以支持什么 | 不能由此推定什么 |
| --- | --- | --- |
| [JavaScriptBridge](../research/godot/4.6-stable/source/platform/web/javascript_bridge_singleton.cpp#L253), 253–302、381–391 | JS回调、二进制buffer转换；可连接外层UI和Godot | 回调不等于事务确认；需校验origin、source、nonce、schema并入队，检查构建桥接能力 |
| [GLTF runtime注册](../research/godot/4.6-stable/source/modules/gltf/register_types.cpp#L106), 106–139 | GLTFDocument/State 可用于运行时 | 不是只有原生编辑器能读GLB |
| [GLTF解析/构造](../research/godot/4.6-stable/source/modules/gltf/gltf_document.cpp#L7131), 7131–7152、7038–7085 | append_from_buffer、generate_scene 构造真实网格/动画 | 同步路径包Promise仍会卡帧；需控制大小、准备阶段、内存峰值并实际测量 |
| [Blender importer构建](../research/godot/4.6-stable/source/modules/gltf/SCsub#L16) | 编辑器侧Blender集成 | 网页不能因此直接运行用户本机Blender，生成需外部worker |
| [GDScript.reload](../research/godot/4.6-stable/source/modules/gdscript/gdscript.cpp#L739), 739–903 | 运行时存在解析、分析和编译路径 | 已有实例且不保留状态可能ERR_ALREADY_IN_USE；不能说Web绝对不能动态编译，也不能承诺任意状态安全重载 |
| [GDScriptCompiler](../research/godot/4.6-stable/source/modules/gdscript/gdscript_compiler.cpp#L3046), 3046–3092 | DEBUG_ENABLED 路径包含实例成员迁移 | 不能把编辑器调试重载等同于所有导出包都支持；批量/静态状态路径还受DEBUG/TOOLS宏限制 |
| [PCK挂载](../research/godot/4.6-stable/source/core/config/project_settings.cpp#L576), 576–618 | 加入资源文件/更新目录 | 挂载包不自动迁移已有场景实例 |
| [Web启动](../research/godot/4.6-stable/source/platform/web/js/engine/engine.js#L196), 196–209 | 匹配引擎实例和main PCK | 更换不兼容引擎需要匹配新实例，不能冒充旧Wasm原地更新 |

布局与组件属性走文档事务和契约内运行时应用；模型/预制件使用不可变候选交换；行为代码使用明确定义的生命周期和状态迁移。新脚本候选单独编译和验证，成功才替换。任意GDScript/GDExtension/引擎更新不承诺Vite式普适安全重载。

最大成本是复杂呈现冻结（骨骼/粒子/GPU时间）、旧资源与候选同时驻留、Web模型构造卡顿、源版本与在线版本分离，以及真实Agent产出验证。所有这些应在 [创作验收](CREATION-ACCEPTANCE.md) 的真实旅程中测量，不以源码可调用性当作体验已经达标。
