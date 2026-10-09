# 工程导出与应用打包

> 2026-09-08 当前入口修订：编辑 Play、独立 Web、原生导出和 Agent 固定工程共用 [统一游戏工程](UNIFIED-GAME-RUNTIME.md)。模型编辑预览与游戏宿主分离，历史验证记录不能替代本次检查。

入口：原工作台 `http://127.0.0.1:48910/creation-workspace.html`，进入分支后，项目名称右侧的 **导出 / 打包**。

## 使用

预览窗口的「新页面游玩 ↗」是 Web 调试快捷入口：固定当前场景和源版本，复用匹配的包或直接提交 Web 构建，完成后自动打开。与「打包」共用后台记录、权限和产物。模式与测试说明见 [编辑窗口模式](PREVIEW-MODES.md)。

Web 应用出包与嵌入预览共用 `tools/godot-web-compatibility.mjs` 的局域网 HTTP 单线程适配。它核对官方 Godot 4.6 模板、无共享内存的 WASM、关闭线程/扩展/PWA 的导出配置，然后在计算文件哈希和 ZIP 前生成适配后的 HTML/JS 与 `web-compatibility.json`。兼容回执随构建记录保存；未知模板或配置变更会使此平台构建失败。

「新页面游玩」只复用带当前兼容回执的已完成 Web 包，或声明当前兼容策略的进行中任务。以前没有回执的包保留为历史文件，自动新建兼容包，不改写旧地址下的产物。通过局域网 HTTP 打开历史旧包时，出包记录会提示重新生成，避免再进入 Godot 安全上下文报错页。

局域网 HTTP 下浏览器缺少 AudioWorklet 时，游戏使用 Godot 静音驱动并显示「局域网试玩暂不播放声音」。本机安全上下文和 HTTPS 下的音频配置保持正常；普通公网 HTTP 仍要求 HTTPS。

- 导出：核对项目、分支和源版本，二次确认后由后台生成 Godot 工程 ZIP，完成后下载。
- 打包：选择平台和入口场景，再次确认。后台按平台串行导出；应用提供下载，Web 提供「新页面打开」。
- 项目名称右侧显示进行中任务和进度。关闭弹窗不取消任务，刷新后可以从「出包记录」查看。进度来自资源收集、Godot 导入、逐资源运行检查、平台导出和压缩阶段，不用定时器模拟完成。
- 固定的是确认时显示的源版本；之后其他协作者继续编辑不会改变此任务。任务不推进分支的 source head、在线世界或在线进度。

## 导出内容

工程可以用 Godot 4.6 打开 `project.godot`，按 F5 运行 `standalone.tscn`。它包含实际使用的 Godot 宿主脚本、固定的运行文档、全部创作定义，以及模型和行为脚本的原始字节。`source-manifest.json` 包括未实例化的预制件及其历史定义，依赖闭包同时保留历史定义独占的资产。

发行版本使用原项目的场景解析、物理模拟和行为注册表，独立从场景初始状态单人运行。玩家角色与键盘、鼠标、触屏控制由游戏内容显式定义，通用入口不再自动生成角色、绑定移动/跳跃/交互键或提供跟随相机。它不连接原在线房间，也不继承协作者的实时进度。正常场景菜单只列场景，不将预制件列为关卡。

`bundled/*.glb.bin` 和 `bundled/*.gd.txt` 保存按 SHA-256 校验的原始字节，防止 Godot 导入/导出重写。`release.json` 为实际运行输入，`resources/*.json` 与 `source-manifest.json` 为创作定义快照。此导出提供可运行的 Godot 源工程；尚未提供原生场景节点拖动回写、离线重新组装 hierarchy 包或自动回传工作台的适配器。

源 ZIP 仅包含运行验证前记录的工程文件，验证后再次检查文件类型、真实路径和哈希。验证脚本临时产生的文件不进入下载包；应用也从这份固定文件清单另建干净导出目录。工作台数据库、账号、登录令牌、会话和检查点不属于导出内容。

2026-09-09 资源验证提速：全部资源仍独立运行，使用固定模拟步长完成最多 180 次主循环。应用在第一次导入成功、运行检查之前复制干净导入快照，校验后由导出器复用，省去第二次单独导入；不复用运行后产生的文件。阶段耗时、实测收益及模拟时间边界见 [打包资源验证提速](BUILD-VALIDATION-PERFORMANCE.md)。

## 平台与工具链

| 平台 | 产物 | 本机准备条件 |
| --- | --- | --- |
| Web | Godot HTML / JS / WASM / PCK，另页运行 | Godot 4.6 Web 无线程模板 |
| Windows | x86_64 EXE，ZIP 下载 | Windows release 模板 |
| macOS | Universal 应用，ZIP 下载 | macOS 模板；本地签名，未公证 |
| Linux | x86_64 ELF，ZIP 下载 | Linux release 模板 |
| Android | 签名 APK，ZIP 下载 | Android release 模板、Godot Editor Settings 中 Android SDK 与 JDK、发布密钥 |
| iOS | 签名 IPA，ZIP 下载 | iOS 模板、macOS/Xcode、Apple Distribution 签名和 Ad-Hoc 描述文件 |

缺少条件的平台会在界面禁用并列明原因；「全部可用平台」只选择已配置的平台。API 请求不完整的平台集合仍保留每个平台的成功/失败结果，有可用产物时状态为 `partial`。

Godot 二进制可由 `GODOT_BIN` 配置，模板目录可由 `WORLD_ATELIER_EXPORT_TEMPLATES` 配置。默认使用 Godot 4.6 stable。可按需安装官方模板：

```sh
python3 tools/install-release-templates.py web windows macos linux
```

此工具从 Godot 官方发布的 TPZ 中获取所选模板，验证归档 CRC 并输出 SHA-256，不下载 SDK、不生成证书。

Android 服务环境配置 `GODOT_ANDROID_KEYSTORE_RELEASE_PATH`、`GODOT_ANDROID_KEYSTORE_RELEASE_USER`、`GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD`。SDK/JDK 路径配置于该服务用户的 Godot Editor Settings。iOS 服务环境配置 `WORLD_ATELIER_IOS_TEAM_ID` 和 `WORLD_ATELIER_IOS_PROFILE`，对应钥匙串需已有可用的 Apple Distribution 证书及 Ad-Hoc 描述文件。这些凭据不写入源 ZIP。

平台实现依据 Godot 4.6 [命令行导出](https://docs.godotengine.org/en/4.6/tutorials/export/exporting_projects.html)、[Android 导出器源码](https://github.com/godotengine/godot/blob/4.6-stable/platform/android/export/export_plugin.cpp)及 [iOS 导出说明](https://docs.godotengine.org/en/4.6/tutorials/export/exporting_for_ios.html)。当前本机未配置移动端 SDK/签名；没有声称 Android/iOS 已实际出包或上架。

## 服务与接口

后台模块 `services/creation/export-builds.mjs` 接入原 CreationService；元数据在原 creation SQLite，文件在 `<creation-data>/builds/<job-id>/`，全部为本机忽略目录。

2026-09-09：相同固定输入的应用打包支持复用已有 Play/普通应用产物，返回同一任务及 `reused:true`，无需再次等待全流程；正在执行且目标齐全的任务也可合并请求。复用前检查每个请求平台的工具链、下载 ZIP 与 Web 文件完整性。请求 ID 单独记录到 `creator_export_request`，重试仍解析原任务，改变参数拒绝；旧任务上的请求 ID 继续兼容。源码 ZIP 不作内容复用。详细测量与边界见 [打包性能研究](BUILD-PERFORMANCE-RESEARCH.md)。

| 接口 | 行为 |
| --- | --- |
| `GET /creation-api/projects/:p/branches/:b/builds` | 分支最近 50 条任务、各平台可用性 |
| `POST` 同一路径 | `{kind,targets,source_revision,entry_scene_id,request_id,confirmed:true}`，返回 202 和任务 |
| `GET /creation-api/builds/:id` | 状态、实际阶段进度、平台结果和产物哈希 |
| `GET /creation-api/builds/:id/artifacts/:artifact` | 认证下载，复核成员权限与文件哈希 |
| `POST /creation-api/builds/:id/access` | 发放此发行目录专用、1 小时有效的 HttpOnly / SameSite cookie，返回 Web URL |
| `GET /creation-releases/:id/web/:file` | 固定清单文件，逐次复核访问权限和 SHA-256 |

拥有者/编辑者可以构建，项目读者可以读取既有产物；无项目权限者不能访问。相同操作者、分支和 request_id 重放同一任务，改变参数则拒绝。最多 12 条待运行任务，单 worker 串行处理，Godot/压缩命令有超时和关闭清理。服务重启将尚未完成的任务明确标为 `interrupted`，不会将半成品标成成功。

运行源码/预制件验证不是任意代码安全沙箱，也不是产品玩法验收。当前数据目录应整体保留；原 `backup-creation` 的运行时备份流程尚不负责归档新出包产物。

## 本轮验证

2026-09-08 局域网 HTTP 修复：独立 Chrome 通过实际 LAN IP 从工作台按钮打开新包，真实场景/UI 加载，E 交互计数变化，无 console warn/error；17 项前端回归及真实 ZIP/授权文件哈希检查通过。详情见 [Web 局域网独立回归](../tests/creation/web-preview-regression-results.md)。这是本机通过 LAN IP 触发非安全上下文的验证，未声称第二台设备测试。

正式 48910 已受控更新。Bruce1 从原「新页面游玩」按钮为植物大战僵尸的 `scene-harbor` / `src-978f5d4ed239488fcd76a9d4544582ea367aad856a32df6704f0ccc737bb83c1` 生成新包 `build-3b41a644-ae28-465b-8ee1-60acf5f99336`，实际回执策略为 `world-atelier-single-thread-local-http-v1`。正式产物的 8 个文件、ZIP、适配回执哈希均一致，旧 `build-2a1fc85b-1baa-4dd6-95c0-ae491ad620a8` 的 HTML/JS/WASM/PCK 哈希保持不变。正式证据保存在 `.local/creation-verification/web-preview-live/`。

正式 localhost Chrome 新页面已从初始 `0/5` 波、击退 0、阳光 300 实际进入战斗，观察到 `1/5` 波、击退 6、阳光 910；点击游戏「重新开始」后回到 `0/5` 波、击退 0 并继续运行。无 console warn/error。此项证明正式新包的按钮/玩法/重启；LAN 非安全上下文由上述独立测试证明，未混称为正式第二设备验收。

独立测试入口：`node --test tests/creation/export-builds.test.mjs`，默认隔离端口 48921；如被其他测试占用，可显式设置 `WORLD_ATELIER_EXPORT_TEST_PORT=48923`。测试拒绝 48900 / 48910 并使用独立临时数据库；测试进程结束后释放自有监听者。

覆盖二次确认、角色权限、固定版本与幂等、真实 Godot 工程下载启动、重启中断、原始模型/脚本与历史预制件依赖、运行中额外文件排除、各平台产物、Web 正常输入、短期访问与撤权、损坏 PCK 拒绝、桌面/移动布局、进度与刷新恢复。Windows/Linux 验证实际二进制类型，不当作已在目标操作系统启动的证据。

2026-09-08 完成本轮独立验收：8 组通过，最终报告 `.local/creation-verification/export-builds/2026-09-07T16-10-48-907Z-7fc91220/report.json`（UTC 文件时间）。Web/macOS 实际运行，Windows/Linux 实际产生 PE/ELF，Android/iOS 明确未配置。另 33 项原工作台顶部/颜色/启动保护回归通过。原 48910 服务在确认没有运行中 Agent 后受控更新，仍保留原数据与功能开关。

原用户项目「贪吃蛇」的首次 Web 出包发现动态 CanvasLayer 的中文默认字体缺失；发行宿主现同时设置 `ThemeDB.fallback_font` 与默认主题字体为随包 `CreatorUI.tres`。独立字体测试覆盖默认 Label/Button/OptionButton 及空 Theme 的 6 种情况，字体都含中文字形，证据 `.local/standalone-template-probe/font-probe.log`。工作台模型预览运行时不因这个发行字体设置而改变。

原入口最终实测：`build-436f5ac5-9aa1-45f4-810e-f0b4d3f523d8` Web 包已经通过原按钮在 Chrome 新页面打开，中文界面目视正常；`build-b6039091-ca15-456d-8459-09527efe3fee` Godot 工程已经生成，并通过原按钮触发浏览器下载。两者固定同一 `src-dbd68240f09a460170eaf3002a901d4cfc4ac353e3b4337e8d6b6653e68ef28a`。最终回执 `.local/export-builds-live/final-receipt.json`；下载包字节/哈希的独立验证见上述隔离测试报告。
