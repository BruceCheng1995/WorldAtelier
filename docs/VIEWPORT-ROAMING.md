# 3D 漫游与帧率

2026-09-10。交付到原工作台 <http://127.0.0.1:48910/creation-workspace.html>。改动在编辑器相机、描边采样及工作台导航反馈；游戏的原生源稿、玩家控制、音频和发布版本不变。

## 参考与取舍

- [Unity Scene view camera](https://docs.unity3d.com/6000.0/Documentation/Manual/SceneViewCamera.html) 将速度、加速与 easing 分开配置，飞行期间可滚轮调速。本实现提供速度、转向灵敏度与移动响应，避免隐藏的长时间持续加速。
- [Unreal Engine viewport controls](https://dev.epicgames.com/documentation/en-us/unreal-engine/viewport-controls-in-unreal-engine) 使用 RMB + WASD、QE、滚轮调速；[viewport toolbar](https://dev.epicgames.com/documentation/en-us/unreal-engine/viewport-toolbar) 显示相机速度。本实现沿用这些按键，同时在操作位置附近显示数值、对数刻度与临时倍率。
- [Three.js PointerLockControls](https://threejs.org/docs/pages/PointerLockControls.html) 使用相对鼠标转向；[FlyControls](https://threejs.org/docs/pages/FlyControls.html) 由帧时长驱动移动。这里捕获鼠标，直接应用 yaw/pitch，不给转向添加延迟。速度响应按解析积分计算，消除不同帧步长带来的位移差异。
- [Godot InputEventMouseMotion](https://docs.godotengine.org/en/4.6/classes/class_inputeventmousemotion.html) 建议捕获转向使用 `screen_relative`。Godot Web 输入已乘以绘制画布与 CSS 尺寸比，因此再按实际像素比归一化，让相同 CSS 位移在 DPR 1 / 2 下保持一致。

## 操作与状态

默认速度 6 m/s，范围 0.1–1000；Shift 为 3 倍，Alt 为 0.2 倍，QE 沿世界竖直方向。斜向向量归一化。默认速度响应时间常数 45 ms，松开移动键后以 20 ms 刹停；菜单可选“直接响应”。松开右键立即清零速度；鼠标转向始终即时生效。

中键直接沿当前相机的屏幕右轴 / 上轴平移，眼点与焦点等量移动，相机旋转、焦距和视角预设保持不变；Shift + 中键、空格 + 左键仍可平移。Alt + 左键围绕当前主选对象的真实世界包围中心旋转，无选中时沿用观察焦点。每次按下鼠标重新确定中心；按下时不重新居中画面，环绕时保持眼点到对象中心的距离；透视视图中也保持对象中心在画面中的位置。正交预设仍按既有操作在开始旋转时转为透视。释放或取消手势后清除该中心。

右键进入漫游时显示底部 HUD。滚轮改变速度，不移动眼点或焦点；HUD 和菜单读取同一引擎返回值。持久设置只在变化时写浏览器存储，避免每个相机包都同步写入。FPS 来自 Godot `_process` 的真实帧时长，每半秒更新；它不是浏览器外层动画的帧率。

捕获范围仅限 Web 编辑视口，不让无人值守原生测试捕获桌面指针。RMB 释放、Escape、应用失焦、`pointerlockchange` 与 `pointerlockerror` 都清理导航状态，处理浏览器吞掉 Escape 及 mouse-up 后迟到的捕获授权。

## 帧率优化

原描边每个选中几何组维护四个视口；移动相机触发整张 GPU 蒙版回读、外轮廓提取和颜色层重建。Retina 会把每个蒙版的像素量放大四倍，多个独立选中组再叠加这项成本。

当前仅给描边蒙版设置采样预算：移动时 196608 像素，静止后恢复到 786432 像素，并限制到 CSS 像素密度。原场景和共享文字标签保留完整分辨率；外部轮廓、无内部孔洞描边、多个用户的独立颜色层仍由原算法生成。描边宽度按采样比例换算，保持屏幕大小；快速导航时精细边缘采样比静止时粗，这是明确的质量取舍。

同时对原生节点树遍历去重，仅在值变化时同步蒙版材质和 Mesh 状态；Agent 开发状态投影只复制涉及对象的开发条目。编辑 Web 相机不继承游戏设定的帧率上限，原生无人值守测试的帧率限制和游戏 Play 设置保留。

## 验证边界

- 引擎导航和批注测试使用隔离项目、headless / Dummy 音频，验证输入、坐标、区域成员与源稿不变。
- 原工作台浏览器验证包含真实 Godot Web 导出、鼠标捕获、滚轮速度与刻度、WASD、Shift 反馈、RMB / Escape 退出，以及原有批注草稿与复制粘贴闭环。没有发送 Agent。
- 性能探针使用同一个固定原生 `world.tscn`（根节点、Tower、Ground；两个 Mesh），真实无界面 Chrome / ANGLE Metal，可信鼠标事件且要求真实相机回执。比较相同 CSS 1280×800、DPR 2；没有使用 SwiftShader。这里的测量用于隔离编辑器开销，不代表复杂游戏内容都能达到同样 FPS。

Apple M5 Pro / Chrome 153 上的实际对照如下；每组记录 119 个帧间隔，旧版卡顿组因耗时较长采样时间更长。输入轨迹参数相同，为保持可比，新版探针显式设置旧版灵敏度 0.004；正式默认值为 0.0025。表格是测量结果，不作为跨硬件的自动测试阈值。

| 操作 | 旧版 P50 / P95 | 新版 P50 / P95 |
| --- | --- | --- |
| 无选中，右键转向 | 16.7 / 16.7 ms | 16.7 / 16.8 ms |
| 单选 Tower，右键转向 | 33.3 / 33.4 ms | 16.7 / 16.7 ms |
| 同时选中 Tower、Ground，右键转向 | 66.7 / 83.4 ms | 16.7 / 16.7 ms |
| 同时选中两对象，但隐藏描边 | 16.7 / 16.7 ms | 16.7 / 16.7 ms |

旧版再次隔离测量双选描边时为 83.3 / 100.1 ms，隐藏描边恢复 16.7 ms；新版双选 119 帧无超过 25 ms 的样本，Godot 自身输出同时为 60 FPS。旧版两个对照记录为 `web-1789014060552`、`web-1789014153389`，新版为 `web-1789014736223`，均在性能证据目录内。

独立 Godot 导航验证包含 136 项断言，覆盖 30/60/144 FPS 下位移一致、6 m/s 默认响应移动一秒为 5.73 m、松键刹停残移不超过 0.12 m、直接响应、斜向限速及长帧钳制。还有 57 项相机意图、桥接、多选与协作存在状态回归全部通过。

额外核对当前导出的 DPR 1 / 2：浏览器各收到实际累计 120 / 30 CSS 像素的相对输入，最后相机回执都转动 yaw −0.48 rad、pitch +0.12 rad，眼点保持一致；右键释放后导航为空、捕获退出。`web-1789014881069` 同时保留双选运动中和停止后的实际画布截图，两条外轮廓均可见，停止后恢复更细采样；性能改善没有隐藏选中描边。

本次证据保存在 `.local/creation-verification/viewport-performance/`，浏览器操作证据在 `.local/creation-verification/viewport-annotation/browser-WwvEZE/`。正式入口返回模块与本地源码哈希一致，记录见性能目录的 `canonical-delivery.json`。
