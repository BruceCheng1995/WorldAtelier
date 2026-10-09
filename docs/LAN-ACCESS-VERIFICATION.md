# 局域网开放试玩验证 · 2026-09-08

正式入口已切换到默认局域网监听：`http://10.222.132.235:48910/creation-workspace.html`。这是本次 en0 地址，换网后以 `npm run dev` 打印的地址为准。本机 `127.0.0.1:48910` 仍可用。服务由受控启动器管理，重复启动确认复用同一 PID；配置见 [LOCAL-DEVELOPMENT.md](LOCAL-DEVELOPMENT.md)。

正式运行时为 `48b522a1941f5df260d037d4349ec52b7f077c1688f66e16af1ab9ba39409e05`。已核对正式 HTTP 返回的全部 9 个构建文件 SHA，正式登录页在 Chrome 非 secure context 下加载正常，无页面错误或请求失败。受控重启前没有正在执行的开发/自动检查任务；旧的 uncertain 记录未伪装成完成。原运行世界通过正常关闭保存检查点。

独立测试使用 48921、临时 SQLite 和唯一星港测试世界，关闭付费 Agent 执行。真实浏览器完成：未受邀注册、查看既有游戏、退出再登录、首次 Play 冷启动、真实按钮输入和权威坐标变化。测试不把模型查看器当作玩法运行。新账号不能创建项目/会话、修改源稿、显式验证或发布，也不能读取私人及成员共享会话。伪造 Host 的 HTTP/WS 与异源写入/WS 均被拒绝。

浏览器冷启动后，测试拥有者推进源稿而不发布；公开试玩账号解析并加入同一个已应用版本，直接请求未发布的新源版本收到 409。源稿与世界版本保持分离。独立测试完成通过，源码 hash 漂移为空，测试服务停止、临时数据库删除。另有 13 项实际双用户 Godot 世界回归通过，包括输入、发布连续性、错误候选隔离及重启恢复。

本次从这台机器的真实局域网 IP 发起 HTTP/Chrome 验证，没有声称已在同事的另一台物理设备或跨网环境测试。LAN HTTP 当前使用 Godot 官方 Dummy 音频驱动，画面中显示“局域网试玩暂不播放声音”；HTTPS 原音频配置不变。电脑和服务需保持运行。

本地证据（忽略目录，不进入 Git）：

- `.local/creation-verification/lan-access/2026-09-08T02-31-16-933Z-7c6bf4c9/report.json` 与 `lan-public-play.png`：独立 HTTP、WS、真实产品流程、移动及版本权限。
- `.local/creation-verification/lan-runtime/browser-final/report.json` 与 `lan-http-godot.png`：真实非安全上下文能力、Godot ready、GLB loaded 和静音提示。
- `.local/creation-verification/lan-deployment/`：正式重启、浏览器登录页、在线构建哈希与独立测试收据。
- `.local/creation-verification/world/2026-09-08T02-20-57-670Z-fa3170b5/report.json`：13 项真实 Godot 权威世界回归。
