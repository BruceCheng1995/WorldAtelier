# 编辑器弹窗与气泡窗优化 · 2026-09-10

已更新原应用：<http://127.0.0.1:48910/creation-workspace.html>。沿用确认的暖白、深绿 PC 风格。本轮在现有 Chrome 登录会话、植物大战僵尸 main 分支检查；没有新建产品服务或另做演示页面。

## 设计与实现

- 浮层统一纸色底、细边线、8 px 圆角、轻阴影、紧凑操作行与分组标题。普通表单、知识阅读、长记录分别控制宽度和滚动范围。
- 视口“更多”改为编辑工具、视角、当前视口、场景资料四组，变换与相机工具横向排布。选择工具后保留菜单；打开其他页面/弹窗的操作收起菜单。实际高度从原约 745 px 降至约 581 px。
- “界面”中的工程导出、打包和出包记录直接可达，移除重复的嵌套构建层和闲置重复记录入口；运行中进度仍使用真实状态。
- 菜单按实际按钮定位，修复顶部排序后界面菜单错位；支持上下避让、窗口边界限制、滚动面板内的预制件菜单。主工具栏的显示入口与运行入口靠在一起。
- 会话设置由 215 px 调整为 300 px，名称与可见性优先；会话 ID、连接和核对运行收进“连接与会话信息”。输入帮助、操作帮助统一浅色快捷键说明。
- 知识列表可滚动，长描述最多两行；短说明使用 660 px 阅读宽度，避免原来的 1000 px 大片空白。通用表单减少头尾与字段间距；出包记录限制高度，保留可见的关闭与操作区。
- 点空白、焦点离开、Esc 与进入视口后的关闭规则一致。Esc 优先关闭当前气泡，关闭弹窗后回到可见入口。普通正文折叠分组不受影响。五种 dialog 共用外部主键点击关闭规则，内部点击或拖出不会误关。
- 知识引用、请求决定、能力场景创建、共享窗口的迟到结果不再关闭/覆盖更新后的窗口；预制件直接放置防止同一按钮重复提交。这些是界面上下文保护，关闭不会撤回已提交的操作。

## 实际按钮点检

1. **文档、显示、更多、AI 菜单**：逐个打开并截图，验证菜单互斥、定位；点击当前“选择”工具后菜单保持打开。没有改变源对象参数。
2. **会话入口、会话列表、设置、输入帮助、批注记录、已有引用详情**：查看实际历史会话；验证设置 → 批注记录 → Esc 返回设置按钮，输入帮助 Esc 不会关闭整个聊天。
3. **操作帮助、预制件卡片更多**：检查浅色样式、左右边缘和遮挡，验证帮助 Esc 后回到入口。
4. **新建场景/预制件、添加子对象、导入模型**：打开表单、检查内容与关闭，不提交创建或上传；新建表单点外部关闭后回到加号按钮。
5. **游戏知识列表和详情**：读取真实 19 条内容，列表滚动区 clientHeight 438 / scrollHeight 1417，长内容可继续浏览；查看一条知识全文，没有加入会话或打开源设计。
6. **顶部界面、分支、协作者、账号**：逐个打开。构建入口分别查看导出确认、打包配置、出包记录；出包记录外部关闭后回到界面按钮。没有执行构建、下载或发布。
7. **分享、共享记录、邀请链接**：查看实际权限与历史记录，外部关闭后回到分享。没有邀请、发送或修改权限。
8. **消息列表和详情**：查看已有已读消息详情，检查加载中与有内容状态；消息中心外部关闭后回到消息按钮。没有对待处理请求作出决定。
9. **能力预览辅助弹窗**：从没有测试场景的“地图 · 晨光花园”进入，依次查看管理、场景工具、测试记录、提需求；没有启动运行或创建场景。提需求窗口点空白关闭后焦点回到“提需求”。

## 截图证据

原始前后截图均保存在 `/Users/chengzhi/Projects/WorldAtelier/.local/editor-overlays-20260909/screens/`，本轮共 51 张。文件中的 before/after/final 表示该检查阶段，不代表不同产品版本或运行验收。

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| 视口更多 | 03-viewport-more-before.png | 42-more-final.png |
| 界面/构建入口 | 17-build-before.png | 24-interface-after.png |
| 操作帮助 | 05-help-before.png | 32-help-after.png |
| 会话设置 | 06-session-settings-before.png | 33-settings-after.png |
| 输入帮助 | 08-composer-help-before.png | 51-composer-help-final.png |
| 知识列表 | 15-knowledge-before.png | 43-knowledge-final.png |
| 新建表单 | 12-create-before.png | 46-create-final.png |
| 出包记录 | 26-history-after.png（紧凑调整前） | 47-history-final.png |
| 消息中心 | 27-inbox-after.png（紧凑调整前） | 50-inbox-final.png |

![视口更多](/Users/chengzhi/Projects/WorldAtelier/.local/editor-overlays-20260909/screens/42-more-final.png)

![会话设置](/Users/chengzhi/Projects/WorldAtelier/.local/editor-overlays-20260909/screens/33-settings-after.png)

![知识阅读](/Users/chengzhi/Projects/WorldAtelier/.local/editor-overlays-20260909/screens/44-knowledge-detail-final.png)

## 验证与范围

独立测试角色最终一次运行 8 个文件，**120 / 120 通过**；4 个修改的 JS 模块语法检查通过。覆盖外部点击/拖动、焦点与 Esc、浮层边界定位、真实引用组件的 Tab/Shift+Tab/IME 语义、异步返回隔离、放置防双击。测试没有向实际用户项目发请求或运行 Godot。

- [独立检查与精确用例清单](/Users/chengzhi/Projects/WorldAtelier/.local/editor-overlays-20260909/independent-review.md)
- [本轮 Node 测试原始结果](/Users/chengzhi/Projects/WorldAtelier/.local/editor-overlays-20260909/final-node.tap)
- [服务返回文件与本地文件校验](/Users/chengzhi/Projects/WorldAtelier/.local/editor-overlays-20260909/served-files.json)

服务仍是端口 48910、PID 35791 的原服务。6 个修改的生产文件 HTTP 200 且内容与工作区一致；原有其他未提交改动保留。

本轮验证的是 PC 浮层与交互。权限不足、真实请求审批、发送、导入、删除、创建分支、运行中能力场景、发布等有实际后果的状态没有通过真实提交制造；其异步边界按上述 Node 用例检查，不能算作引擎、多人运行或发布验收。首次点检显示过“模型加载超时”，最终刷新显示实际“已保存”；本轮没有修复或清除历史运行错误。加载编辑器会沿用应用现有的会话读取、缩略图及自动封面行为。
