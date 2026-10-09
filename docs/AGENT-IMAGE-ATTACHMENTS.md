# Agent 图片附件

2026-09-11：视口 **批注 → 截图划线** 复用此图片通道。可在当前 Godot 截图上画自由线、箭头和方框，再把合成图、补充说明及本批已有空间批注放入一个新 Agent 待发送草稿。图片仍由用户点击发送后才进入 Agent 视觉输入；不增加图片内容展开或独立的场景权威。用法与范围见 [截图划线](VIEWPORT-ANNOTATIONS.md#截图划线2026-09-11)。

2026-09-10：原工作台 `http://127.0.0.1:48910/creation-workspace.html` 的 Agent 输入区支持「图片」、粘贴截图与拖入图片。每条消息最多 8 张，每张最多 5 MB；格式为 PNG、JPEG、WebP。草稿和历史消息均显示缩略图，点击放大；草稿可移除，允许只发送图片。图片不自动导入游戏源稿，也不触发构建或发布。

图片沿用会话的所有者写权限与私有/共享读权限。上传使用 `POST /creation-api/sessions/:sid/image-attachments?name=...`，请求体为图片原字节，Content-Type 为实际图片类型；下载使用同一路由下的 `/:attachmentId`，需要 Authorization。浏览器通过授权下载生成临时 Blob URL，登录 token 不进入图片地址。切换会话或退出登录回收预览 URL。

中央 `session-images/<sha256>` 保留不可变原字节，消息与草稿只保存摘要、大小、尺寸、名称及会话身份。下载和执行时核对摘要；仅移除未发送附件不会改变历史消息。原有备份工具收集草稿和历史消息引用的图片，校验与恢复均包含原字节。

发送时图片物化到绑定会话的 `context/images/`，执行器使用 `localImage` 视觉输入，文本上下文只包含简短引用。输入类型已对照当前安装 CLI 生成的 `UserInput.ts`，公开协议见 [OpenAI App Server](https://learn.chatgpt.com/docs/app-server)。图片不成为对象编辑目标；模型决定如何使用图片内容，原生源稿写入仍经过既有中央事务。

本轮验证：

- `tests/creation/image-attachments.test.mjs`：真实 HTTP、权限、SQLite 和文件存储，执行器明确使用模拟 RPC；检查格式/大小/数量、私有与共享读取、移除、纯图片发送、消息幂等、图片路径和原字节。
- `tests/creation/image-attachments-browser.mjs`：隔离 48921、临时数据库及无界面的 Chrome，检查原工作台选择/粘贴/拖入、预览、移除、会话切换/刷新与发送历史；模拟执行器，不运行 Godot。
- `.local/image-attachment-verification/vision-report.json`：独立真实 Codex 回合通过视觉输入准确回答「红色正方形、绿色圆形、蓝色三角形」，无游戏源稿修改。
- `.local/image-attachment-verification/formal-service.json`：原服务已受控重启；5 个页面/模块的 HTTP 字节与本机源码一致，正式入口无登录启动无页面脚本错误。已登录交互证据来自上述隔离浏览器。
- `tools/test-codex-agent.mjs`、`chat-presentation`、`reference-components` 与 `agent-text-boundary` 合计 54 项通过；原 `backup-creation` 15 项通过；新增图片 HTTP/Adapter/备份恢复 4 项与浏览器交互 5 项通过。浏览器证据位于 `.local/creation-verification/image-attachments/2026-09-10T06-30-19-778Z/`。

此次也遇到两组既有测试夹具失配：`chat-access-input` 的手工服务缺少 native archive，`session-input` 的 VM 缺少 agentRoster。未把这些失败计入本轮通过数，也未因此修改无关产品代码。
