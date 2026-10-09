# 3D 视口与操作柄

2026-09-10 导航与批注更新见 [视口导航与批注](VIEWPORT-ANNOTATIONS.md)。以下旧证据继续保留各自的验证版本。

更新：2026-09-07。当前工作台支持中央文档中的父子层级、固定预制件实例与覆盖，以及多人协作下带版本条件的撤销/重做。本记录说明现有交互、实现边界和已留存的专项证据；完整用户 Case 的进展仍见 [集成验证](INTEGRATION-VALIDATION.md) 与 [用户体验 Case](USER-EXPERIENCE-CASES.md)。

本批独立浏览器验收使用 Godot runtime `1dde489c662e22971a8cf586aa7c278f92451d13c21944ed8d91f6666bbd0b25`。最新相机等待修复对应 `apps/creation-workspace/workspace.js` SHA-256 `594ea6fbeded6a65e7c1194c2720a06020469d34afa01b271293c69a35a0a673`，完整前端清单见 [代码索引](../.local/creation-verification/integration-ui/frontend-code.json)。各次编辑的源版本分别记录在原始证据中；此前多轴、重挂等操作不因此被重新标为最新前端的重复验收。

## 对照与取舍

| 官方参考 | 采用的交互 | 本工作台的选择 |
| --- | --- | --- |
| [Unity 6：Position GameObjects](https://docs.unity3d.com/6000.0/Documentation/Manual/PositioningGameObjects.html) | W/E/R 工具、三轴平面移动、旋转环、中心统一缩放、数字变换字段 | 将工具放在视口内，保持画面高度；数值与真实 Godot 对象使用完整 TRS |
| [Blender：Precision](https://docs.blender.org/manual/en/5.0/scene_layout/object/editing/transform/control/precision.html) | Ctrl 临时吸附，Shift 精细拖动 | Shift 为 1/10 精细调整；默认步长选择 0.25 m、15°、0.1，并提供常驻吸附开关 |
| [Godot 4.6：Introduction to 3D](https://docs.godotengine.org/en/4.6/tutorials/3d/introduction_to_3d.html) | 三轴空间编辑、自由观察与聚焦 | 主场景的左键用于选择/编辑，右键或 Alt+左键用于观察；独立对象预览保留直接左键旋转 |

以上保留早期交互参考。当前实现支持父子层级、嵌套实例及协作中的条件撤销；多选、顶点吸附、表面贴合和镜像缩放仍不支持，也未实现完整专业编辑器的全部工具。

## 操作约定

- Q 选择；W 移动；E 旋转；R 缩放。红 X、绿 Y、蓝 Z，悬停/拖动手柄高亮。
- 移动箭头限制单轴，方片限制 XY/XZ/YZ 平面；旋转使用轴环；缩放使用单轴端点或中心统一缩放。移动/旋转按世界轴，缩放按对象局部轴。
- 左键点选真实模型表面。中键、Shift+中键或空格+左键沿相机画面平移，旋转不变；Alt+左键围绕主选对象中心环绕（无选中时沿用观察焦点）；右键固定眼点转向，按住时 WASD/QE 漫游、滚轮调速度，Shift 加速、Alt 慢速。普通滚轮以鼠标下的聚焦平面位置为锚点缩放；“导航”菜单可设置持久速度。2D 支持中键/右键/空格+左键平移、鼠标锚定缩放及触控板手势。
- 无修饰键点击编辑视口时，首次选中命中位置所属的最外层对象；继续点击，只进入当前对象下、鼠标命中的下一层，直到叶子后保持选中。点击另一外层对象从外层重新开始，空白处清空选中。层级与对象树一致，跳过引擎内部包装和整个场景的根；独立对象预览以当前预览对象为起点，左键拖动仍可旋转。快速连点也每击仅推进一层，不自动聚焦；F 仍用于聚焦。Ctrl/⌘ 切换多选、Shift 追加多选保持直接命中对象的行为。2D/UI 拖动保持已选父对象，只有无移动释放才深入；普通点击不提交变换。
- F 聚焦选中对象，Shift+F 查看全场。也可用视口右上按钮、顶/前/右视角入口。页面快捷键需要视口获得焦点；最新专项实际使用的是页面 `#viewport`。
- Ctrl 临时切换吸附，Shift 降低拖动灵敏度；Esc 取消并还原拖动前的完整位置/旋转/缩放。
- 属性里的位置、角度、缩放按 XYZ 输入；层级对象显示相对父级的位置、度数角度与缩放。Enter 提交有效数值；Tab/失焦也提交。Esc 取消尚未提交的数值编辑，恢复当前正式字段，并阻止同时关闭聊天。缩放各轴范围为 0.1–5。提交及字段版本读取未结束时，数值框暂不可编辑。
- Ctrl/⌘ Z 撤销，Ctrl/⌘ Shift Z 或 Ctrl/⌘ Y 重做。一次拖动或一次数值字段编辑形成一笔事务，切换场景/预制件/分支后分别维护历史；新编辑清空该文档的重做栈。中央服务核对逆事务的版本条件，遇到他人后改时拒绝覆盖并保留冲突信息。
- 文本输入、聊天和视角下拉的键盘操作不能移动对象。个人检查中变换工具、数值和历史只读，相机仍可使用。
- 默认保持场景树、视口、属性三栏。小于 640 px 的窄窗口优先显示视口，顶部“树”“属性”按需打开覆盖面板；“展开/恢复”控制视口最大化。聊天继续使用抽屉，不重建两处 Godot iframe。

## 实现边界

**中央提交与本地预览分开。** 页面与 iframe 校验 origin/source/nonce/seq，运行包和资产使用固定版本及哈希。拖动 start 捕获完整对象地址、源版本、对象/实例/祖先版本和原始变换；层级变换提交保留完整世界矩阵，普通节点与实例覆盖使用各自的操作。preview 改变临时呈现并向协作者发送带版本的预览，commit 经中央事务确认后更新正式源稿；cancel 清除临时姿态，不新增事务或撤销记录。

**层级及协作撤销已接入。** 父级移动带动子物体，重挂可要求保留世界姿态；不能表达为局部 TRS 的结果明确拒绝。多人修改不同对象可分别提交，同对象及祖先变换过期时使用版本条件拒绝。撤销/重做提交服务端返回的受条件保护的逆操作；当前页面按文档保存撤销栈，不承诺刷新后恢复整套历史栈或提供全工程统一撤销。固定附件保留完整实例路径、添加时的版本和坐标，不随最新选择漂移。

**等待中的输入有边界。** 数值提交未结束时，后续字段不能捕获旧版本；切到其他文档后，原请求结束会解除当前字段的等待状态，但不会把旧输入写入新文档。正在拖动时，缓冲远端预览和自身回声；已经发起的源场景读取在返回后也再次检查拖动状态，避免重置正在操作的 gizmo。

主视口聚焦/复位/视角按钮及页面 F 快捷键先等待本次数值提交，再等待固定源版本的场景加载。相机意图只保留最后一次，发送前核对文档、选中对象、源版本和已加载 seq；切对象、切文档、切模式、加载失败或开始新拖动时，旧请求不能迟到聚焦。bridge 对已经开始加载的 scene 另保留同一代次的末次相机操作，换代次、错误、超时、关闭时清除。`local_trs_unrepresentable` 的交互拒绝保留已加载场景，不显示成模型加载失败。

个人检查仍只读呈现冻结观察，相机可用；本文件没有关闭“检查中编辑”的后续需求。盒碰撞的世界剪切、球碰撞的非均匀缩放等当前运行时不支持的结果会拒绝验证/应用，已经保存的合法源稿不会因此丢失。

## 验证与证据

**纯/FAKE 自动检查：59 通过、0 失败。** [前端合集日志](../.local/creation-verification/integration-ui/frontend-final-tests.log) 覆盖层级操作、数值输入、相机提交/读取/ACK 顺序、bridge 和目标面板边界。异步测试明确使用 FAKE DOM、HTTP 或 iframe ACK，没有运行浏览器/Godot；该数字不计为用户 Case 通过数。

**真实浏览器操作：按以下具体范围记录。** 本次文档维护已读取原始 JSON，并打开核对最新聚焦 JPG。其他画面和操作由主集成执行，证据保留各自时间及源版本。

| 操作 | 实际记录与边界 |
| --- | --- |
| 非零高度、多轴旋转、非均匀缩放 | [双端字段](../.local/creation-verification/integration-ui/browser/dual-multiaxis-fields.json)：两用户同文档/构建，Y=2.5、角度 15/30/10、缩放 1.2/1.5/0.8；另留存 [撤销](../.local/creation-verification/integration-ui/browser/dual-undo.json) 与 [重做](../.local/creation-verification/integration-ui/browser/dual-redo.json) 对照 |
| 真实 gizmo 提交及协作者看到结果 | [start/preview/commit 事件](../.local/creation-verification/integration-ui/browser/gizmo-commit.json) 保留完整地址及矩阵；[另一端观察](../.local/creation-verification/integration-ui/browser/gizmo-peer-observed.json) 的 X=0.780909，其余变换保留。此前回声取消拖动的 [失败画面](../.local/creation-verification/integration-ui/browser/a-drag-stuck.png) 继续保留 |
| 保世界姿态重挂、父级移动与撤销 | [重挂记录](../.local/creation-verification/integration-ui/browser/reparent-keep-world.json) 中局部 X=-2、世界 X=0；[父移动的另一端记录](../.local/creation-verification/integration-ui/browser/parent-move-peer.json) 中局部 X 仍为 -2、世界 X=1；[撤销后另一端字段](../.local/creation-verification/integration-ui/browser/reparent-undo-peer.json) 与 [嵌套父移动](../.local/creation-verification/integration-ui/browser/nested-parent-move.json) 单独留存 |
| 数值 Enter / Escape | [Enter](../.local/creation-verification/integration-ui/browser/numeric-enter.json) 留存已保存源版本；[Escape 前后](../.local/creation-verification/integration-ui/browser/numeric-escape.json) 的源版本、loaded seq 和正式位置不变。角度显示存在约 10⁻¹⁴ 度的换算差异，没有据此认定发生源稿修改 |
| Enter 后立即聚焦新姿态 | 最新前端下将 Y 输入为 12，Enter 后在页面 `#viewport` 触发 F。[原始记录](../.local/creation-verification/integration-ui/browser/enter-immediate-focus.json) 显示 loaded seq=7、camera seq=7、源 `src-d35e35cb232…`，相机 target Y=13.3807249069214；[实际 JPG](../.local/creation-verification/integration-ui/browser/enter-immediate-focus.jpg) 可见模型、包围盒及操作柄。聚焦取模型包围中心，因此 target Y 不要求等于对象原点 Y=12 |

最新聚焦证据限定上述实际触发路径。此前点击位置被窄屏属性面板覆盖、向 `#mainPreview` 发送 F 未触发相机的尝试记为“未触发”，不能作为聚焦成功的证据。

最初视口改进的历史输出仍保留在 `.local/model-preview/verification/interaction/`。本批专项与浏览器记录分别说明已执行的操作，不将它们扩成 Case 02/05 或完整协作创作流程全部通过；未覆盖变体继续按 [集成验证范围](INTEGRATION-VALIDATION.md) 留待核验。
