# 新页面 Web 游玩：LAN HTTP 独立回归

2026-09-08，唯一独立测试角色执行。此次根因由用户截图和主集成定位：独立 Web 包使用 Godot 官方安全上下文检测，局域网 HTTP 被拒绝；localhost 的成功不能证明 LAN 可用。主集成给 Web 导出接入已审查的单线程本地 HTTP adapter，测试者没有修改产品代码或旧发行文件。

## 实际证据

隔离端口 48923，临时数据库；`WORLD_ATELIER_LAN=1`、`WORLD_ATELIER_PUBLIC_PLAY=0`、Agent/中央 world 启动关闭。测试用户、内容、构建均为新建的独立夹具，不触及正式 Bruce1 或 48910。

浏览器是本机真实 Chrome，通过本机网卡 en0 的 LAN IP 访问该服务，以触发真实非安全上下文；不是第二台设备测试，也不声称验证了远端设备的防火墙/网络可达性。

- 真实 Web 任务：`build-af975e62-b1e1-4df2-bb40-62a1dc37d168`，状态 completed。
- 项目：`game-4126f3d2-c973-425a-84d3-1540eab9bc66`；`scene-harbor`；源版本前缀 `src-398c447f0f2`。
- 浏览器实际地址：`http://10.222.132.235:48923/creation-releases/build-af975e62-b1e1-4df2-bb40-62a1dc37d168/web/index.html`。
- 从同一 LAN 地址的工作台登录并点击“新页面游玩”，创建新标签页并成功显示真实 Godot 3D 地标、玩家和脚本 UI；画面 tick 为 704，真实键盘 E 后交互计数 0→1、tick 1206。
- DOM `#wa-http-audio-note.hidden=false`，显示“局域网试玩暂不播放声音”。该节点只有实际非安全 HTTP 分支才显示；没有假冒 `isSecureContext` 或忽略浏览器安全警告。Chrome warn/error 记录为空。
- 截图通过 CUA 实际图像输出留存在独立测试会话；没有声称生成本地 PNG。

截图操作记录：① `webLanGame.getScreenshot()` 在新页面完成加载后得到地标、角色、品红UI、`LOCAL INTERACTIONS: 0` 和 `Authority tick: 704`；同一次只读 `dev.logs({levels:['error','warn'],limit:20})` 返回 `[]`。② 对真实 canvas 执行 `press('e')` 后再截图，计数变为1、tick1206，底部持续显示局域网静音提示。两次截图均来自地址栏对应的独立发行页，不是编辑器iframe截图或离线渲染。

产物证据目录：`.local/creation-verification/web-preview-regression/2026-09-08T04-06-52.929Z/`。

| 产物 | SHA-256 |
| --- | --- |
| Web ZIP | `29988bfb20650a4ab79349bf9583846a0d96184ddfbea92bb858aa309b2840e1` |
| 适配 HTML | `f6682fb43df6ffe03c479494d98a5e32131c0f3cc356307118d593745793c0e9` |
| 适配 JavaScript | `fbcf1b7b3154b33f1558a35e5c6670ba66dd83cd78a62169aa7d917e66956856` |
| web-compatibility.json | `e850528dd182a60e2505829a166c91a256f0ced1f04c34d4480a92f3bc6528d5` |

真实产物检验通过：ZIP 的 HTML/JS/metadata 与出包目录逐字节一致；元数据中的 adapted hash 与实际字节一致；LAN 经授权返回相同文件哈希，未授权仍拒绝403；新包复用后只有一个构建任务。预设显式 `thread_support=false`、`extensions_support=false`、`progressive_web_app/enabled=false`。适配器确认官方引擎 `4.6.stable.official.89cea1439`，单一非共享 WASM memory。

## 定向测试

`preview-web-builds.test.mjs` 原有8项先通过；新增旧完成包、旧排队包、缺少服务策略三项在修改前按预期失败，证实测试能识别旧行为。最终17项全部通过，包括：

- 同源旧完成包/旧排队包不复用；新包可复用。
- 已声明兼容策略的排队任务完成时仍必须有实际适配回执。
- 缺少兼容策略的后台不再生成另一个错误包。
- 非安全 HTTP 的 history 旧包入口先显示明确提示；普通 player 被指向新版包或编辑者，不被要求操作禁用的新包按钮。
- 新包 history 正常授权打开；安全上下文仍可打开原有不可变旧包。
- 原有版本固定、防重复提交、弹窗拦截、切换上下文、提交不确定性等用例继续通过。

执行方式（真实产物检查须在自有夹具服务运行期间执行）：

```sh
node --test tests/creation/preview-web-builds.test.mjs
node tests/creation/web-preview-regression-fixture.mjs
WORLD_ATELIER_WEB_REGRESSION_DIR=.local/creation-verification/web-preview-regression/2026-09-08T04-06-52.929Z node --test tests/creation/web-preview-regression-artifact.test.mjs
```

没有原样运行包含外部 Playwright UI 控制的全套 `export-builds.test.mjs`；本轮真实 UI 操作全部使用 CUA。没有以局域网静音运行宣称 HTTPS 音频、所有浏览器或正式部署已验收。

清理：自建Chrome标签页1686186039/1686186045已关闭；自有launcher49541/服务49543正常退出，exec26242 exit0，`lsof -nP -iTCP:48923 -sTCP:LISTEN` 无监听。正式48910未重启、未修改。私有测试登录资料只存于 `.local` 的权限0600文件，不在本记录或Git中。
