# 预制件缩略图与局域网访问

2026-09-08。原入口仍为 `http://127.0.0.1:48910/creation-workspace.html`，局域网用户使用服务所在电脑的 IP 与相同端口。此次只修改原工作台静态文件，刷新加载，无需重启中央服务或世界。

## 局域网修复

`prefab-preview.html` 是缩略图专用 Godot 页面。它原先单独构造 Engine，遗漏普通视口已有的静音启动配置；局域网 HTTP 下缺少 AudioWorklet，Godot 初始化时报 `Cannot read properties of undefined (reading 'addModule')`。

截图引擎现在明确使用 `--audio-driver Dummy`，并核对单线程清单与引擎功能检测。只为生成静态图运行，保留原 Godot 渲染、版本清单、资源哈希及同源消息校验。

## 缓存行为

- 当前页面继续使用有界内存缓存、可见区域按需生成、串行截图和空闲释放渲染器。
- 浏览器通过 localStorage 保存成功 JPEG，刷新、重新进入目录后可复用。缓存按同源账号、项目、分支、预制件版本、固定源版本及 Godot 构建 ID 隔离。
- 从持久缓存取图前仍通过原 `runtime-scene` API 读取并核对资源身份及当前访问权限；缓存不会跳过授权。
- 同一浏览器 origin 总计最多 64 张、约 3 MiB 字符存储，按最近使用淘汰，30 天未用失效。源版本采用保守失效：同分支其他编辑也可能要求重新截图。
- 不保存失败状态。隐私设置、存储损坏或配额不足时退回正常截图与内存缓存；切换、退出和授权失效会围住旧异步结果。

此缓存位于各用户浏览器，不是服务器共享图片库；不同电脑第一次访问仍需生成。截图是预览用途，不是内容验证或运行时应用证据。

## 自动回归

`node --test tests/creation/prefab-thumbnails.test.mjs tests/creation/lan-platform.test.mjs` 覆盖队列与版本隔离、过期异步回包、存储命中前授权、账号/构建/源版本失效、LRU/容量和存储错误降级。测试中的模拟 DOM、渲染 ACK 与图片不计为真实 Godot 出图证明；浏览器检查另行保存证据。

本轮 21 项回归通过。独立执行 `node tests/creation/prefab-thumbnail-lan-browser.mjs`，Chrome 经本机真实网卡 IP 的非安全 HTTP 地址测试：6/6 预制件实际出图并缓存，刷新后专用截图引擎请求为 0 且继续鉴权读源；真实修改事务改变版本和 JPEG 像素。无页面错误，测试期间三个实现文件哈希稳定，临时服务和数据已清理。报告与截图位于 `.local/creation-verification/prefab-thumbnail-lan/2026-09-08T04-30-38-962Z/`。

正式 48910 的只读启动检查也收到真实 Godot `ready`，见 `.local/creation-verification/prefab-thumbnail-live/report.json`。这些检查由同一台电脑上的浏览器访问真实局域网 IP 完成，未声明另一台物理电脑实测。

## 原生缓存补齐（2026-09-09）

原生框架迁移后，`PrefabThumbnails.drain` 将 `creation-native-1` 排除在持久缓存之外。原生 JPEG 只留在页面内存；刷新页面以及退出游戏目录后重进（调用 `clear()`）都会再次执行截图。同一页面、同一源版本的列表重绘原本已有去重。这是重复渲染问题，并非已有缩略图 JPEG 的传输失败。

原生卡片现在通过已授权的 `runtime-scene?...&thumbnail=1` 获取轻量 `thumbnail_renderer_identity`。身份覆盖完整预览 runtime 文件清单、baker、装配策略、Godot/Web 工具链和截图客户端代码；计算只读文件，不创建构建任务或固定工程。图片缓存包含账号、项目/分支/资源、固定源版本、完整 `source_identity`、原生场景路径及该渲染身份。命中后直接读取浏览器 JPEG，不创建缩略图视口，也不因该卡片请求构建或构建访问。旧后端缺少身份时仍可截图，但不持久化身份不完整的原生图片。

卡片先显示“正在读取预览…”，确实未命中且开始截图时才显示“正在生成预览…”。缓存容量、30 天过期、权限校验、账号切换与取消请求隔离沿用原机制。

本次保留完整源版本的保守失效策略：任何原生工程文件变化仍可能让全部卡片重新截图；不同浏览器或不同访问地址也各有独立缓存。要跨无关源修改复用，需另行建立可靠的原生依赖闭包身份，不能直接删除 branch revision 或仅依赖资源根文件。

回归：`node --test tests/creation/prefab-thumbnails.test.mjs tests/creation/native-thumbnail-identity.test.mjs tests/creation/native-preview-content-bridge.test.mjs`。27 项通过，包括原生刷新/重入复用、无渲染器创建、源/引擎/客户端/账号失效、授权失败和晚回包隔离。模拟 DOM/图片回归只证明缓存控制逻辑；真实浏览器出图证据另行记录。

真实浏览器复验：`node --test tests/creation/native-thumbnail-browser.test.mjs`，39.2 秒通过。独立 48921 服务、实际原生 Box 导入与 Godot 构建、静音 headless Chrome。冷启动 1 个缩略图视口、1 次构建请求、1 次访问请求；生成 384×288、5778 字节 JPEG。整页刷新后 JPEG 字节完全相同，0 新视口、0 构建/访问请求，仅 1 次授权读取。构建仍为同一条，源 head/identity/revision 列表未变。独立检查者查看图像确认红色立方体；浏览器和临时服务已关闭。证据：`.local/creation-verification/native-thumbnail-cache/browser-jtGd0X/report.json`。这是原始组件与实际 HTTP/引擎的隔离浏览器检查，不冒充正式账号完整工作台交互。

正式服务已在确认无活动 Agent、构建或 Godot 进程后受控重启：PID 66179 → 35791，仍为原 48910。服务健康、前端三个模块 HTTP 与本地字节一致、全部分支与 121 个源版本保持一致，`npm start` 再次执行复用原监听。记录：同证据目录 `service-before.json` / `service-after.json`。
