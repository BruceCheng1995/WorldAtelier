# 世界工坊 · 已确认风格的 PC 实装检查

日期：2026-09-09  
Final result: **passed**  
范围：现有创建工作台的 PC 视觉与相关界面交互。手机适配按用户最新要求暂缓。本结果不代表游戏发布、原生共享多人玩法或完整产品流程验收。

## 对照基准与实际入口

- 用户确认稿：[approved-warm.png](/Users/chengzhi/Projects/WorldAtelier/output/visual-review-20260909/concepts/approved-warm.png)，原始像素 **1487 × 1058**。
- 最终实装：[editor-final.png](/Users/chengzhi/Projects/WorldAtelier/.local/design-implementation-20260909/editor-final.png)，Chrome CSS 视口 **1487 × 1058**，DPR **1**，文档宽度 **1487**，检查器滚动位置 **0**。
- 当前页面：[创建工作台](http://127.0.0.1:48910/creation-workspace.html)。真实 Bruce1 账号、植物大战僵尸2d、main、游戏 · 晨光花园、选中植物 · 豌豆射手；源状态回读为 `场景已更新 · 源稿 src-87fe503a05d`。这是源状态，不是发布状态。
- 入口已追踪至原有 Node 服务 PID **66179**、端口 **48910**、`services/preview/server.mjs`、`apps/creation-workspace/index.html`。结束前原进程仍在监听。
- HTTP 返回的 index、workspace.js、semantic-inspector.js、release-builds.js、semantic-authoring.css 与磁盘文件的 SHA-256 全部一致。没有另建应用、产品端口或重启现有服务。
- 原 2026-09-07 QA 文档已保留：[previous-design-qa.md](/Users/chengzhi/Projects/WorldAtelier/.local/design-implementation-20260909/previous-design-qa.md)。

## 视觉比较

确认稿和最终实装在同一次图像比较输入中按原始分辨率并列检查，没有只凭 DOM 或只看实装截图推断一致性。另检查顶部工具栏和检查器的局部截图：

| 区域 | 确认稿 | 实装 |
| --- | --- | --- |
| 顶部两层，x=1、y=1、1485×121 | [顶部局部](/Users/chengzhi/Projects/WorldAtelier/.local/design-implementation-20260909/approved-header-detail.png) | [顶部局部](/Users/chengzhi/Projects/WorldAtelier/.local/design-implementation-20260909/implemented-header-detail.png) |
| 检查器上部，x=1111、y=122、376×430 | [检查器局部](/Users/chengzhi/Projects/WorldAtelier/.local/design-implementation-20260909/approved-inspector-detail.png) | [检查器局部](/Users/chengzhi/Projects/WorldAtelier/.local/design-implementation-20260909/implemented-inspector-detail.png) |

已实现：暖白表面、深绿主操作、浅分割线、浅蓝选中态；保留对象/协作检查器；单行文档与视口操作；结构树命名；底部 2 列预制件缩略图与完整目录入口；实例 AI 图标菜单；轻量覆盖点与重置入口；“修改模型”按钮；移除重复预制件页签、左下角选中对象文案及未发布标记。顶栏源保存状态、协作者、消息数均取真实状态。

PC 布局在 1488×1056 的中间测量中，左栏约 285.7、视口约 823.9、右栏约 376.5 CSS px，接近确认稿的三栏比例。最终按确认稿的精确 1487×1058 尺寸重新采图。1280×800 也无文档横向溢出，顶栏为 64 px，视口工具栏为 58 px，结构树和检查器各自滚动。

### 有意保留的差异与限制

- 确认稿是生成图片；实装使用现有 Godot 场景、当前相机、资源缩略图和账号颜色。因此资产细节、场景画面大小、头像数量和棚架资源顺序与稿子不同。未把生成图当作可操作画布或伪造资源数据。
- 原生静态编辑器改为暖灰背景；不添加可能遮住实际场景几何的地面网格。 authored 场景和正式玩法环境不随此背景改色。实际浏览器已成功加载新静态编辑器并显示灰色背景。
- 实际豌豆射手有 7 项玩法参数和 2 项技术属性，而稿子只有 4 项参数。技术属性收在“其他属性”中，其余保留。长检查器需要滚动到模型操作；[滚动后模型区域](/Users/chengzhi/Projects/WorldAtelier/.local/design-implementation-20260909/inspector-scrolled.png)显示真实预览及“修改模型”。不为匹配图稿而删除可编辑数据。
- 实装保留更紧凑的桌面字体与控件密度，没有宣称逐像素复制；检查器不额外复制第二张标题头像。条件性的“能力预览”和原有导入/子对象操作继续保留。
- 已有预览帮助、撤销和重做继续提供。消息中心仍显示真实历史待处理错误；本次没有清除或伪装其状态。

## 迭代与修复

| 轮次 | 发现 | 处理与复查 |
| --- | --- | --- |
| 初次实装 | P1：旧顶栏局部深色变量覆盖新主题；旧静态视口仍为深色 | 重设顶栏局部变量；将静态原生编辑器背景改为暖灰；浏览器重新加载后确认 |
| 交互复查 | P2：构建子菜单打开后父菜单关闭；对话框返回焦点落到隐藏菜单 | 保留嵌套菜单父层；关闭后返回可见顶栏省略号；实际浏览器和独立执行检查确认 |
| 状态复查 | P2：纯 CSS 状态文案无法区分编辑、发布固定版本和显式共享状态 | 状态改取现有运行模式/真实详情；保留源保存与发布的边界 |
| 检查器复查 | P2：同步缓存渲染删除新 AI 菜单；旧名称区顺序不合理 | 重绘前暂时分离并保留原 AI DOM，随后重新挂载；实例菜单可见；标题、实例标记、删除、AI 排序调整 |
| 细节复查 | P2：预制件选中态仍被旧高优先级紫色规则覆盖；显示菜单横向滚动 | 匹配旧选择器优先级并使用浅蓝；处理显示菜单横向溢出；最终 computed style 为 rgb(228,240,251) |
| 最终 PC 复查 | 顶栏消息角标、对话框配色与树/预制件切换 | 修正角标被通用 span 规则隐藏的问题；分享/新建/消息统一主题；精确尺寸重新采图 |

当前检查范围内没有遗留 P0/P1/P2。上节记录的实际内容、密度与生成稿差异不作为逐像素一致性结论。

## 实际浏览器检查

| 页面或状态 | 结果与证据 |
| --- | --- |
| 主编辑器、实例选中 | 新背景成功呈现；默认选择工具显示外轮廓；名称、AI、覆盖点、源状态可见。[最终图](/Users/chengzhi/Projects/WorldAtelier/.local/design-implementation-20260909/editor-final.png) |
| PC 较小窗口 | 1280×800，文档无横向溢出；面板内部滚动；主要操作可见。[截图](/Users/chengzhi/Projects/WorldAtelier/.local/design-implementation-20260909/editor-1280.png) |
| 完整预制件目录 | 查看全部显示真实 11 项；打开豌豆射手独立编辑器，再返回场景。沿用真实缩略图加载和缓存。[目录](/Users/chengzhi/Projects/WorldAtelier/.local/design-implementation-20260909/prefab-library.png)、[独立编辑器](/Users/chengzhi/Projects/WorldAtelier/.local/design-implementation-20260909/prefab-editor.png) |
| AI 和显示菜单 | AI 展开显示修改功能/控制属性需求；显示菜单打开真实选项。未提交 Agent 指令或显示设置写入 |
| 构建记录 | 现有记录弹窗正常开关；返回焦点为可见 interfaceMenuButton。未手动提交构建或发布。[截图](/Users/chengzhi/Projects/WorldAtelier/.local/design-implementation-20260909/build-history.png) |
| 游戏库与搜索空状态 | 真实六个游戏；无结果搜索显示 0/6 与清空入口，清除后恢复。[游戏库](/Users/chengzhi/Projects/WorldAtelier/.local/design-implementation-20260909/catalog-final.png)、[空状态](/Users/chengzhi/Projects/WorldAtelier/.local/design-implementation-20260909/catalog-empty.png) |
| 创建游戏 | 弹窗正常打开并取消，没有创建提交。[截图](/Users/chengzhi/Projects/WorldAtelier/.local/design-implementation-20260909/create-game.png) |
| 分享权限 | 真实成员/权限可见，深绿主操作，正常关闭；未邀请成员或修改权限。[截图](/Users/chengzhi/Projects/WorldAtelier/.local/design-implementation-20260909/share-final.png) |
| Agent 会话 | 打开真实已结束会话，未发送新消息。[截图](/Users/chengzhi/Projects/WorldAtelier/.local/design-implementation-20260909/session-final.png) |
| 消息中心 | 真实待处理 8 项、未读 99+；列表与未选中详情状态正常；未点击处置或标记已读。[截图](/Users/chengzhi/Projects/WorldAtelier/.local/design-implementation-20260909/inbox-final.png) |

前期 900 px 和手机尺寸探索截图不作为这次 PC 验收基准。部分菜单/目录图保留了中间轮次的选中色，最新主题以最终主编辑器图为准。

## 独立检查与边界

独立测试角色运行 8 个纯 Node 测试文件，最终 **103 passed / 0 failed / 0 skipped**：预制件缩略图、语义前端、语义宿主、顶栏、结构树、原生选择拖动、预览模式生命周期和 Web 构建协调。3 个修改的 JS 文件语法检查通过。

完整证据：[independent-node-review.md](/Users/chengzhi/Projects/WorldAtelier/.local/design-audit-20260909/independent-node-review.md)。3 个测试宿主补充了新 UI 节点或既有外部回调；原断言没有削弱。没有实装前的源文件备份，因此不能把初次失败声称为原有失败。单独的真实渲染函数执行检查还验证了实例 AI 的完整对象地址、只读禁用和覆盖重置权限，以及构建弹窗焦点恢复。

浏览器日志含扩展脚本的键盘处理异常，以及 authored Godot shader 的 invalid UID/path fallback 警告；不能声称整个控制台无错误。灰色静态编辑器成功渲染并不替代 canonical GameRuntime 的玩法验收。

本次没有主动启动独立 Play、提交源码参数、发送 Agent 请求、邀请/更改权限、公开发布，或启动接管桌面输入的 Godot 测试。打开真实应用会沿用既有的预览准备、缩略图、封面和会话初始化行为，因此不声称后台元数据绝对零变化。没有构建新测试场景或恢复自动验证面板。

## 追加：工程、分支与弹窗产品化

本次扩展的最新截图、外部点击关闭规则、浏览器验证与独立测试记录见[面板设计检查](/Users/chengzhi/Projects/WorldAtelier/output/visual-review-20260909/panels/review.md)。上文为上一轮编辑器检查的历史快照，服务 PID、源版本与实时计数以追加报告为准。
