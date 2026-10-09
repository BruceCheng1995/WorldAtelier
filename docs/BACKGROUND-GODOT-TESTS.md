# Godot 服务器测试：后台渲染与静音

2026-09-09。用户要求 Agent 测试不抢桌面焦点或键鼠、不播放音乐，普通逻辑测试优先 headless。

## 实现

- 会话 `.execution/godot` 由平台安装，`workspace.json engine.executable` 及 Agent PATH 指向它。默认 headless，全部测试强制 `--audio-driver Dummy`，拒绝有声驱动及普通桌面显示驱动覆盖。
- `--wa-render` 使用 macOS Godot 4.6 编辑器二进制的 `--embedded`。禁止启动 GUI 编辑器/项目管理器；最多 30 FPS、1,800 帧、120 秒和每会话一个渲染进程。通过进程内脚本操作游戏、查看保存图片。
- Godot 4.6 的 embedded 构造器需要非空 EngineDebugger；GL 初始化也需要尺寸消息。启动器提供仅限本机、随测试关闭的调试连接，只发 `embed:window_size` 到 `Thread::MAIN_ID`。默认 1280×720，可用 `--resolution` 调整；不连接用户编辑器、不发送焦点或键鼠事件。
- 正常退出、超时及 SIGINT/SIGTERM 均回收所属进程组和调试连接；驱动回退日志触发终止，不尝试普通窗口。原游戏源稿、玩家音频、用户系统音量和既有桌面窗口未修改。
- `AGENTS.md`、创作上下文、新建/恢复及新回合指引明确禁止绕过启动器、打开或激活 Godot App、使用桌面/CUA 键鼠操作、音乐/音效/TTS 播放。

## 当前实证

验证对象为坦克大战原生已登记可编辑工程的隔离副本，源版 `src-4f8407fac157a3c69bd40f8238153a1a80e1dc1cbe2f1a5306540ef89e1b7dd1`。保留 `GameRuntime` Autoload 与 `atelier_runtime/standalone.tscn`，使用原有 capture 流程，仅在隔离副本追加实际驱动检查。私有 HOME、缓存、数据及输出均位于测试目录。

- Headless 原生导入退出 0。
- 后台真实运行报告 `display=embedded audio=Dummy`；`STANDALONE_READY` 确认真实项目、源版、场景和 275 个对象；`CAPTURE_OK playing enemies=3`。
- 菜单和战场截图均为 1280×720，已实际查看战场图片，内容可见。
- 只读桌面观察器每约 50ms 记录前台 PID 和 Godot 窗口拥有者 PID。整个成功渲染流程共 98 个样本：测试 PID 成为前台 0 次，拥有原生窗口 0 次。此为有限采样证据，配合 embedded 启动源码，不宣称覆盖所有机器和异常路径。
- 成功退出后无该隔离测试的 Godot/启动器残留进程。

原始证据：`.local/creation-verification/background-godot/report-sized.json`、`sized.log`、`sized-observations.json`、`outputs/tank-background-menu.png`、`outputs/tank-background-battle.png`。此前裸 embedded 崩溃、64×36 尺寸和消息格式错误日志保留，均未作为成功证据。

本次也修复了默认 `--quit-after` 覆盖 import 自然退出的问题；导入、导出及其他完成型命令保留自身结束条件，由墙钟超时兜底。

独立回归 `node --test tests/creation/godot-test-runner.test.mjs tests/creation/agent-recovery-regression.test.mjs`：31/31 通过、零跳过。19 项启动器测试覆盖参数、真实 Variant 编码、实际假客户端收包和端口关闭、超时/SIGTERM/子孙进程清理、渲染锁、导入自然退出及原工程文件保持；12 项覆盖既有会话恢复。回归使用假 Node 进程，不冒充上述真实 Godot 渲染证据。

## 边界与上线状态

启动器是约束正常测试执行路径的措施，仍非 OS/VM 安全边界：任意 shell 能绕过它；引擎内部初始化失败可能回退显示驱动，日志触发终止不能证明所有异常下绝无短暂窗口；强制 SIGKILL 掉启动器也无法执行其清理逻辑。没有建立全局 CPU/GPU 配额。测试仍由 Agent 按需选择，不增加自动验收门禁。

正式服务监听 48910 的 PID 66179 仍有活动创作任务，尚未重启加载本次实现。此状态只表明源码和隔离测试完成，不表示运行中的 Agent 已切换。后续安全加载服务后，新建/恢复/新回合生成的会话会使用新启动器。

参数及边界的官方依据：[Godot 4.6 RenderingServer](https://docs.godotengine.org/en/4.6/classes/class_renderingserver.html)、[ProjectSettings 音频驱动](https://docs.godotengine.org/en/4.6/classes/class_projectsettings.html#class-projectsettings-property-audio-driver-driver)。本地官方源码检查集中于 `platform/macos/godot_main_macos.mm`、`display_server_embedded.mm`、`embedded_gl_manager.mm` 和 `core/debugger/remote_debugger.cpp`。
