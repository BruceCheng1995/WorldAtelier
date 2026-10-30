# Agent 环境与工作空间（本机第一阶段）

> 2026-09-08 当前入口修订：编辑 Play、独立 Web、原生导出和 Agent 固定工程共用 [统一游戏工程](UNIFIED-GAME-RUNTIME.md)。模型编辑预览与游戏宿主分离，历史验证记录不能替代本次检查。

2026-09-09。中央源稿仍是唯一共享事实源。Agent 会话目录长期保留，原生创作回合启动前由平台准备完整 Godot 工程，绑定固定源版本和运行时文件哈希。本地文件修改不会自动成为线上内容。

## 布局与生命周期

相对于创作服务的数据目录（默认 `.local/model-preview/creation/`）：

```text
creation.sqlite                         中央项目、源版本、事务、任务与检查点
assets/                                 不可变项目资产
workspaces/<project>/<branch>/<user>/<session>/
  AGENTS.md / WORLD-API.md               创作规则与当前协议
  workspace.json                        会话作用域、工具链、目录和隔离能力
  context/<run>/manifest.json            本次目标、固定源版本、资源列表、批注与坐标约定
  context/<run>/source-manifest.json     源版本、文件哈希与轻量资源目录
  context/current.json                  当前执行的上下文指针
  inputs/                               兼容模式的文本行为 API，不复制资产
  work/<environment>/                   可编辑 Godot 工程，包含文本和原始资产
  .agents/skills/game-assets/            平台投影的资产搜集与制作 skill
  .agents/skills/game-create/            新游戏规划及当前任务需求文档
  .agents/skills/game-change/            需求修改、说明维护与验收交付
  outputs/                              检查回执等本地成果
  .execution/                           Codex 命令的私有 HOME、临时目录和缓存

environments/<environment>/
  manifest.json                         固定 source revision、runtime hash、完整文件清单
  project/                              全场景、全预制件和资产闭包的完整 Godot 工程
  tests/<test>/project/                  每次测试从固定清单复制的独立工程
  tests/<test>/execution/                独立 HOME、user://、缓存、日志与沙箱配置

automatic-checks/<job>/                 仅历史备份兼容，不调度自动验证 Agent
worlds/verification/<job>/              技术验证的固定 runtime 与独立执行环境
worlds/executions/<execution>/          在线世界的固定 runtime 与独立执行环境
builds/<job>/                          固定工程、独立检查、最终导出产物
```

既有会话的 cwd 和 Codex thread 绑定不迁移；下一次创作执行补写环境与上下文清单，保留已有工作文件。工程投影和测试记录绑定 session、run、lease，不能跨分支、跨用户或跨执行调用。会话恢复不代表旧执行租约重新有效。

## 创作到运行

1. `world_read` 读取中央当前版本、资源与行为接口；历史批注保持捕获时的 source/observed pose、坐标空间和完整实例地址。
2. 原生回合提交给模型前，平台准备可编辑 Godot 工程；`workspace.json.godot_project` 提供目录、environment ID、源版本与提交相对路径。Agent 直接在该目录编辑原生脚本、场景、配置与资产。服务器命令可以下载、读取、生成和转换资产，模型上下文只携带路径、哈希、尺寸及按需预览。`workspace_prepare({revision?,resource_id?})` 可显式选择可达版本或独立预制件入口；相同回合、版本和入口复用现有工程。
3. `workspace_test({environment_id,resource_id?})` 使用新的执行目录完成实际 Godot 4.6 导入和独立运行。前后检查固定文件 SHA，并核对实际 `STANDALONE_READY` 的项目、分支、版本和资源；保存退出码、错误和日志回执。
4. 下一回合保留未提交文件（包括新增、替换和删除的二进制资产）；已提交且无后续修改时准备当前源版本，提交后继续编辑的文件以已保存版本作为新基线保留。原目录不覆盖，中央祖先与文件冲突检查继续有效。`workspace_test` 仅检查固定原版，不能证明尚未提交的本地修改。
5. 原生工程通过 `world_apply` 的 `submit_native_workspace` 提交完整文件差异，包括资产新增、替换和删除。服务端安全扫描并读取工作区字节，内部按哈希归档；工具参数不携带 Base64。小型 `put_source_file` 仍只接受 text；`delete_source_file` 可按 `expected_hash` 删除文件。兼容 `asset_publish` 恢复既有 GLB/GDScript 按路径登记，其他格式通过原生工程提交，不必扩展旧资产库。检查由 Agent 自行选择，不自动触发 `game_validate`。Play 和导出使用明确解析的固定源版本，源稿保存不等于公开发布。只有显式共享权威世界任务才继续 `shared_world_validate → world_publish`，其权威兼容结论单独记录。对象版本、祖先关系、幂等 ID、租约取消以及真实 Godot ACK 的原有保护继续保留。

创作准备、独立验证和导出复用 `project-snapshot.mjs`，包含所有场景、未摆放预制件及历史预制件版本引用的资产。在线权威和技术验证使用客户端 build manifest 的源码清单生成独立 runtime，避免直接运行持续变化的平台工程目录。

## 当前隔离能力与边界

服务器测试默认使用 `--headless`。创作环境将 `workspace.json engine.executable` 指向会话 `.execution/godot` 启动器，并将该目录加入 Agent PATH。启动器所有模式都强制 `--audio-driver Dummy`，拒绝改用有声驱动或普通桌面显示驱动。`workspace_test`、`game_validate` 及平台导入/导出原本已采用 headless。导入、脚本、物理、AI 和玩法规则检查使用有限帧数或超时，结束后退出进程。

真实画面检查按需单独运行：使用 `--wa-render`，macOS 编辑器二进制会收到 `--embedded --audio-driver Dummy`，通过无普通桌面窗口的 display driver 渲染。启动器限制每会话一个渲染进程、最高 30 FPS、最多 1,800 帧、最长 120 秒；headless 默认 180 秒，可通过 `--wa-timeout` 调整至不超过 300 秒。退出、超时、SIGINT/SIGTERM 时回收进程组，回执保存在 `outputs/godot-tests/`。渲染模式不可启动编辑器或项目管理器，不支持的宿主直接报错；不回退普通桌面窗口。不因纯逻辑修改反复带渲染跑完整游戏。

测试操作使用 Godot 进程内 `Input.action_press/action_release`、`Input.parse_input_event` 或测试接口；查看已保存图片。Agent 不得启动/激活 Godot App、抢焦点、移动用户鼠标、注入桌面键鼠、使用 CUA/AppleScript 操作桌面或播放音乐/音效/TTS。限制作用于服务器测试，不将静音和窗口设置写入作者源稿或玩家游戏。

Godot 4.6 的 `embedded` 依赖调试器初始化，且 GL 渲染表面需要显式尺寸消息。启动器为该进程创建短生命周期的 `127.0.0.1` 调试连接，仅发送 `embed:window_size`，默认 1280×720，可用 `--resolution` 指定每边 64..1920；不连接桌面编辑器、不发送键鼠或焦点消息，结束时关闭连接。它是测试内部通道，不是另一个产品服务。作者传入的 `--remote-debug` 仍被拒绝。

Headless 不能作为视觉通过的证据；截图脚本跳过该模式的 GPU 读取及 `frame_post_draw` 等待。后台截图应核对 `DisplayServer.get_name() == "embedded"` 和 `AudioServer.get_driver_name() == "Dummy"`，限制截图等待时间。仅设置 `no_focus` 或把窗口移出屏幕不足以避免 macOS 的启动激活。

启动器落实参数、时限和本会话并发限制，Agent 上下文同时禁止绕过。它不是 OS/VM 安全边界：任意 shell 仍能绕过启动器，Godot 内部显示驱动初始化失败也有回退路径；启动器观察到回退日志即终止，但不能宣称覆盖所有异常条件。平台未建立全局 GPU 配额。新建、恢复及新回合会收到规则，代码需由服务加载；正在执行的回合不会被打断。此功能不新增自动测试或验收门禁。

- Codex 使用 `project_root_markers=[]`，把会话 cwd 作为创作根，避免继承父目录的平台工程 AGENTS.md 与项目配置。命令使用显式环境变量和私有 HOME/tmp/cache；App Server 的登录仍由受信宿主负责。已经用真实 Codex 单回合和同目录 resume 验证。
- 本机 macOS Godot 使用 Seatbelt：仅读取系统及显式项目路径；仅写私有运行目录；只放行指定本机服务端口。Godot 默认禁止 fork，防止用户脚本创建脱离进程组的子进程。导入仅放行 `.godot` 缓存与指定 `.import` 元数据安全保存旁车，之后重新校验源码。
- 准备、验证和在线世界有独立进程生命周期；超时、取消、关闭时回收所属进程并等待结束。工程准备／测试也在关闭屏障内，中央 DB 不先于这些任务关闭。
- macOS 缺少 sandbox-exec 时明确拒绝执行。2026-10-30 新增 [Linux 案例容器](CONTAINER-DEPLOYMENT.md)：用实际 Landlock ABI 3+ 与 seccomp 隔离 Godot，允许线程，禁止子进程、网络通信与跨进程操作；不支持的内核明确拒绝启动。Windows 通过 Docker Desktop/WSL2 运行同一 Linux 配置。该容器提供默认工程浏览和 Play，关闭创作 Agent 与共享世界 worker；完整创作执行器仍限 macOS。尚未提供每任务 CPU/内存硬配额或不互信租户隔离。
- 创作 Codex 的 full-access 仍是本机可信用户显式选择；引用式上下文由文本投影、工具回执和 Agent 指令落实，不是资产文件的读取/制作禁令或操作系统沙箱。资产存在于 Godot 工程供服务器工具处理及引擎加载。平台打包／签名阶段仍是受信任务，需要下一阶段隔离工具链与凭据。
- 按需投影现阶段使用物理复制。每个 run 最多准备 12 个已完成环境，单工程上限 512 MiB；独立 workspace_test 最多同时运行 2 个，每条 Godot 命令最多 60 秒。尚未建立整个磁盘的硬配额、自动回收或 CAS 去重，不应长期无限累积。

## 验证与下一阶段

本轮使用真实独立 Godot、真实 SQLite 和真实 Codex 环境探针。注释上下文、并发租约及恢复边界使用明确标注的 fake RPC 做协议回归；这些结果不冒充玩法验证。实际 Godot 检查覆盖全工程、嵌套预制件、原行为 tick、独立 user://、越界访问、指定端口、错误日志及关闭流程。正式入口仍为 `http://127.0.0.1:48910/creation-workspace.html`；48921 测试服务不作交付入口。

后续优先补充：Linux/远端的完整创作执行器、硬配额与回收策略、平台导出／签名凭据隔离；再考虑按内容哈希复用只读资产、导入缓存和预热环境。不要把长期会话、固定候选、测试进程与在线世界合并为一个生命周期，也不要为每个 Agent 建立独立的第二份源稿权威。

## 引用与资源的 Agent 边界（2026-09-09）

对话引用是 `[@名称](attachment:稳定ID)`，默认上下文只携带短索引。按需快照文件也经过文本投影：保留对象地址、版本、姿态与配置；资源只保留路径、类型和 UID，删除 Base64、字节字段和 Packed 数组载荷。原始捕获及完整引擎索引仍在中央存储，不改写历史。

`world_read(source_path)` 对资产返回 `res://` 引用和哈希，对 UTF-8 文本只返回一次文本。所有工具回执及溢出 JSON 文件统一过滤，再应用 256 KiB 传输上限。上下文与 Agent 工程内重复的 `atelier_runtime/source-manifest.json` 都使用轻量目录；正式构建与共享世界使用的完整索引保持不变。

验证记录：`.local/agent-text-project/`。边界回归覆盖附件、原生/语义读取、资源和 Packed 值、二进制伪装、提交与回放；真实 Godot 工程测试覆盖准备、跨回合保留、连续提交和资产哈希。真实 Codex 在隔离项目直接编辑平台准备的脚本，通过中央 `world_apply` 保存并读回，工具回复 6,828 / 3,047 / 6,883 字节，无 Base64。该证据验证创作链路，不冒充正式游戏玩法验收。

正式服务加载记录：2026-09-09 18:20，在确认无活动 Agent、构建或 Godot 子进程后关闭原 PID 22589，通过 `npm start` 启动 PID 30475，继续唯一 48910 入口；health 与工作台页面均成功。最终 108 项边界/恢复回归、1 项包含真实 Godot 启动的连续创作测试通过。证据为 `.local/agent-text-project/final-regression.log`、`project-test.log` 和 `formal-deployment.json`。

## 资产权限纠正与游戏资产 skill（2026-09-10）

此前将避免资源对象撑满上下文误解为资产禁止读写，导致会话 `session-07b9bb62-30c0-42af-b8c9-fe6ba96379b1` 在 full-access 环境仍拒绝导入。限制现仅针对模型上下文和工具内联字节，不限制已授权的服务器文件操作。`world_read(source_path)` 对资产返回 `context_only: true`、`editable_via: submit_native_workspace`，不再错误标记为只读。对象附件、Packed 数组过滤和 256 KiB 工具传输上限保持。

[game-assets](../skills/game-assets/SKILL.md) 随平台版本维护，准备会话时复制到会话根 `.agents/skills/game-assets/`，`workspace.json.skills`、AGENTS.md、新建/恢复线程指令和新回合短提醒都提供入口。仅加载主 skill 与当前任务需要的 references，不把整套素材目录塞进提示词。现有长期会话仍使用原 cwd、thread、源版本和未提交文件；下一次绑定/回合刷新规则，不重写历史消息。

skill 支持公开模型、图片、PBR 贴图、Godot 插件/模板；也支持 Godot 内建几何、Pillow 绘图和后台 Blender。提供有界下载/ZIP 解压助手、来源许可与生成记录、导入/动画/材质/Web 适配指引。依赖按实际执行环境探测；Pillow 可安装在本会话 venv，不能因系统 Python 缺包断言资产制作不被允许。源保存、检查、构建和发布仍分开。

2026-10-25 新增 [游戏创建与需求修改技能](AGENT-GAME-WORKFLOWS.md)，沿用同一会话投影和按需发现机制；需求与变更记录归当前任务，公共设计摘要才进入共享知识。已有会话在下一次绑定/回合刷新技能，不迁移线程，也不新增自动验收门禁。
