# 预制件能力预览

入口是原工作台的预制件卡片「能力预览」，以及预制件/实例上方的同名按钮。打开后保留全预制件目录，游戏舞台占据主画面。右侧只显示对象自身的「动画、技能、状态」和控制器；选中态、阻塞原因均来自运行时。测试场景在顶部切换，「管理」可创建或独立打开源场景。外部靶子、伤害与生命值预设归入按需打开的「场景工具」；观察、事件及版本身份归入「测试记录」；「提需求」提供文字和口述入口。辅助工具打开不会暂停游戏。

预制件能力入口默认打开「通用动画预览」，即使已经存在作者测试场景也如此；显式选择测试场景时才进入对应测试。动画预览器是固定的轻量 Godot 场景 `tools/release-template/prefab_preview_stage.tscn`，通过 `target_scene: PackedScene` 装载真实目标预制件。所有预制件共用同一舞台、相机、动画发现与时间轴，调用方只提供目标引用，不生成专用动画或脚本适配器。3D 按网格包围盒取景，2D 按 Sprite/AnimatedSprite/Control 包围盒居中缩放并响应视口大小变化。

服务器仍通过统一固定工程构建加载原生资源，在构建的 `atelier_runtime/` 内实例化该通用舞台，自动发现动画并优先播放待机片段，时间轴随即可用。该舞台不登记为作者场景、不提交源版本，也无需编辑权限；已有源读取权限的 viewer 同样可以预览。仍可显式创建持久测试场景以安排交互靶子。默认舞台只用于 `prefab_test` 构建，正式游戏不包含它。这里的轻量化指通用运行场景；首次导入与出包目前仍使用固定工程流程，不声称已经实现按需加载最小资源包。

通用预览的动画页只使用时间轴的播放、暂停、速度与定位控件；隐藏场景运行、单帧和场景速度，避免两套播放控制混淆。标题和运行状态明确显示动画预览/播放状态。切换到技能、状态或显式作者测试场景后，原有场景运行控制仍可用。

## 创建与提需求

「创建测试场景」选择真实预制件和可选靶子，填写名称与想检查的效果。平台通过原中央源事务保存基础 `.tscn` 和测试适配器，使用真实 PackedScene 引用。填写的效果需求可带入新的 Agent 会话，发送后执行；对话继续编辑同一中央源稿。支持浏览器提供的按需听写，不支持时可使用系统听写。

测试现场的「交给 Agent」固定本次源版本、构建、场景代次、状态、当前动画和最近事件到会话草稿。历史观察与修改前必须重读的当前源版本分别保留。最近事件可以导出为 JSON，结果来自实际运行回包。

基础场景自动发现真实 AnimationPlayer、AnimatedSprite2D 和 AnimatedSprite3D，包括嵌套预制件中的播放器；运行中新增、移除或替换的播放器/片段也自动更新。每 0.5 秒比较节点与资源身份，只有目录或动画资源变化时重建轨道信息。它不会猜测对象技能函数。Agent 在测试适配器中连接真实攻击、掉落、受击和状态方法；程序驱动动画通过实际状态或姿态控制接入，不能凭名称杜撰不存在的动画片段。

## 动画与战斗控制

- 真实动画片段逐个列出，点击卡片或切换时间轴下拉即从头播放，同名片段注明所属播放器。播放/暂停状态以运行时反馈为准；当前片段或播放器被移除后退出采样并恢复仍存在的对象姿态。没有原生片段时不占用空时间轴；程序动作作为实际效果演示单独列出，不伪装为可拖动片段。
- 时间轴独立组件 `animation-timeline.js` 显示播放器、片段、长度、循环、倍速与一条播放进度条，不显示关键帧点、轨道列表或额外刻度行。拖动的 `input` 每个显示帧合并发送最新 `seek`，Godot 立即采样实际姿态，无需松手；结束拖动时补发最终位置，旧反馈不会把滑块拉回。选择片段后暂停模拟并播放动画，以 Godot 的姿态采样显示所选时间；跳过方法、音频和嵌套动画播放轨道。桥接命令 `animation` 的 `play:true` 原子选择并播放，省略时保留只定位首帧的兼容行为。
- 动画播放只推进所选动画的采样时间。继续战斗时恢复采样前的对象属性、骨骼和动画播放器状态。拖动时间轴不会倒带血量或重做伤害结算。
- 运行控制提供暂停、真实物理单帧、0.25/0.5/1/2 倍速、重置和停止。每个窗口独立运行，测试存档不写入正式游戏存档域。
- 运行固定源版本。协作者修改源稿时提示有更新，重置后才使用新版；旧包不会被标成新版。

## 原生源与打包边界

测试条目仍是完整原生场景，只额外登记用途：

```json
{
  "id": "pea-combat-test",
  "name": "豌豆射手 · 射击与命中",
  "kind": "scene",
  "purpose": "prefab_test",
  "subject_id": "prefab-pea",
  "path": "test_scenes/pea-combat-test/scene.tscn",
  "design": {"description": "单发、连射、僵尸靶与命中反馈"}
}
```

目录保存在 `.atelier/catalog.json`。所有测试专用场景、脚本、资源和检查计划必须位于 `test_scenes/`；目录中的每个场景必须登记用途与主体。默认正式游戏入口不能指向测试场景。

`assembleProject` 的 `authoring` 目的保留完整原生源与测试内容，供 Agent、原生编辑器和源码工程 ZIP 使用；`game` 目的在物化时排除测试目录、目录条目和测试桥；`prefab_test` 目的保留测试场景并启用专用调试桥。它们共用 GameRuntime Autoload + standalone.tscn，测试不会从模型编辑器初始化玩法。

正式内容引用测试目录会报具体路径或资源错误。普通 Play、应用导出、共享世界和公开游戏发布拒绝测试入口。测试构建有独立用途与完整版本/工具链身份，不能被正式游戏构建复用或发布。源保存、测试结果、完成构建和显式发布依旧分别记录。

## 测试适配器

测试场景根可以实现以下约定。动作列表只声明允许调用的 ID，远程端不提供任意节点方法调用。

```gdscript
signal atelier_preview_event(event: Dictionary)

func atelier_preview_capabilities() -> Dictionary:
    return {
        "title":"豌豆射手",
        "animation_note":"程序动作触发真实效果；原生动画片段在时间轴中采样",
        "actions":[
            {"id":"fire", "label":"发射一次", "scope":"subject", "kind":"ability", "requires_scene":true},
            {"id":"manual", "label":"手动触发", "scope":"subject", "kind":"controller", "mode":"select"},
            {"id":"target", "label":"放置靶子", "scope":"scene", "kind":"fixture"}
        ]
    }

func atelier_preview_action(action_id: String, parameters: Dictionary) -> Dictionary:
    if action_id != "fire": return {"ok": false, "error":"未知技能"}
    $Subject.fire() # 实际项目的技能 API
    return {"ok": true}

func atelier_preview_state() -> Dictionary:
    return {"target_hp": $Target.hp} # 实际观察值

func atelier_preview_selection() -> Dictionary:
    return {
        "action_ids":["manual"], # 从实际运行模式读取，不能仅记录最后点击按钮
        "status":"待机",
        "blocked_actions": {"fire":"需要前方僵尸靶子"} if not has_target() else {}
    }
```

`scope:subject` 的主动操作按 `kind:animation / ability / state / controller` 分类；外部伤害、血量预设、反制输入和靶子配置分别使用 `scope:scene` 与 `kind:passive / fixture`。主动技能不应暗中创建靶子；场景工具负责环境，`selection.blocked_actions` 提前说明尚未满足的依赖。`mode:select` 才表示持续模式，其选中值来自每次运行回读；普通动作默认 `mode:trigger`。

程序动画条目可以使用 `kind:animation, animation_kind:procedural`，调用真实程序动画或技能控制器并说明是否产生实际技能效果。动作声明本身不冒充原生动画片段；框架实际采样到的视觉回放以 `kind:ProceduralCapture` 进入 `animations`，无需把作者脚本改写为 AnimationPlayer。说明字段通过 `capabilities:{title,description,animation_note}` 传出，动态选择与阻塞原因通过 `selection` 传出。

### 脚本动画捕获

`procedural_animation_capture.gd` 是预览框架的临时姿态采样器。无原生动画片段时，运行初始化后自动观察 3 秒；已有原生动画、延迟触发或想重新取样时，可以点击「捕获脚本动画」。采样在帧回调后进行，频率最多 30 Hz、最多 512 个轨道及 4096 个扫描节点。实际变化才生成「程序动画 · 捕获」片段，静止对象显示未观察到变化，不生成虚假动画；录制窗口不等于天然动画周期，因此默认不循环。

通用舞台观察 `Subject` 子树，作者测试场景可用 `atelier_preview_subject() -> Node` 指定实际主体；没有指定时观察当前场景可见节点，排除相机、灯光和 UI。支持节点 2D/3D 变换、可见性、2D 色调、精灵帧、骨骼姿态和 blend shape 的变化；不解析脚本表达式，不回放业务变量、声音或 GPU 粒子内部状态。依赖外部控制器的动作需在包含该控制器的作者预览场景运行，不能从一个静态模型凭空恢复外部逻辑。

片段只保存在当前 Godot 预览内存中，与原生片段共用列表、播放、暂停及实时 input 定位。回放冻结当前独立运行，只写视觉姿态；继续时恢复回放前的实时姿态和运行，业务计数与 Tween 回调不倒退、不重复。轨道同时保留节点实例引用和路径，节点释放、重挂或同路径替换会使捕获失效，不能将旧姿态写入替身。临时播放器清理时只恢复真实对象姿态，不再 seek 已脱树播放器。普通游戏包排除此捕获器，源文件、版本和公开发行不因捕获而改变。

旧版未分类的 flat actions 保持可运行，标记 `legacy:true` 并收在场景工具；前端不会按标签猜测其属于主动行为。只有显式声明的主体操作进入主动面板。

服务接口 `GET/POST .../prefab-tests` 列出/创建测试场景；创建输入 `request_id, base_revision, subject_id, name, description?, target_id?`。`POST .../prefab-test-build` 固定 `request_id, source_revision, entry_scene_id`，通过既有构建队列产生 Godot Web。owner/editor 可创建，具有源读取权限的 viewer 可运行；公共 player 不因此获得源稿或测试权限。

测试桥每条命令都核对 iframe 来源、nonce、源版本、文档、场景代次和命令序列；动作请求 ID 防止重放。状态与事件有界，关闭或切换场景清理旧运行及未完成的客户端请求。

## 显式自动测试

同一固定 authoring 工程可以运行 `test_scenes/` 内的 JSON 计划。测试不会在保存、订阅或 Agent 完成时自动启动，也不会成为源保存门禁。

```json
{"steps":[
  {"command":{"action":"action","action_id":"fire","parameters":{}}},
  {"wait_frames":60},
  {"expect":{"path":"observations.target_hp","equals":75}}
]}
```

从已登记的固定工程启动，日志与报告指向会话自己的输出路径：

```sh
Godot --headless --path <canonical-project> --log-file <session-output>/engine.log -- \
  --release-scene=pea-combat-test \
  --prefab-test-plan=res://test_scenes/pea-combat-test/checks.json \
  --prefab-test-report=<session-output>/report.json
```

报告包含固定源/运行身份、每一步真实结果和最终观察。失败断言、非法动作、脚本异常和超限均失败退出。计划有步数、物理帧数与时间上限；开发者或 Agent 明确运行后才产生测试结果。

实施验证入口：`tests/creation/prefab-lab.test.mjs`（真实 Godot、HTTP、Web 与打包边界）、`tests/creation/prefab-lab-components.test.mjs`（组件与异步生命周期）。实际执行记录以本次报告为准。

### 动画自动发现与直接播放复验（2026-09-11）

- `node --test tests/creation/prefab-lab-components.test.mjs`：6 项通过，包含同名不同播放器切换、旧反馈、运行中新增/移除动画及选择失效。
- `node --test tests/creation/prefab-animation-discovery.test.mjs`：固定原生工程的 44 步真实 Godot 检查通过；覆盖 AnimationPlayer、AnimatedSprite2D/3D 自动发现、直接切换播放、资源替换、精灵动画改名/帧率变化、播放器释放后的姿态恢复、方法轨道不执行及源版本不变。证据：`.local/creation-verification/prefab-animation-discovery/case-onjSZw/report.json`。
- `node --test tests/creation/prefab-lab.test.mjs`：14 组检查通过；独立 48921 上的原工作台实际点击动画卡片和下拉均直接播放，时间轴、暂停、重置、返回编辑及正式游戏包排除测试内容通过。页面无脚本错误或失败请求，截图已检查。证据：`.local/creation-verification/prefab-lab-independent/case-WeGkSb/report.json` 与 `workspace-prefab-ability-timeline.png`。运行中精灵元数据变化由上一项原生检查覆盖。
- 上述首轮验证仅覆盖已有作者测试场景；没有测试场景的市场角色仍不会启动预览。此缺口由下述真实市场角色复验补齐。

### 无测试场景的市场角色复验（2026-09-11）

- `node --test tests/creation/prefab-automatic-preview.test.mjs`：独立 48921 导入真实官方滑板青年，在没有作者测试场景、只有 viewer 权限时打开原能力预览组件。实际 Web 自动发现 `idle / jump / run` 并播放 idle，切换 jump、暂停、定位到 0.217 秒及骨骼姿态截图通过；player 被拒绝，源 head、完整 manifest、文件哈希及资源数不变，普通游戏投影不含临时舞台。证据：`.local/creation-verification/prefab-automatic-preview/case-4iUkyF/report.json` 及同目录两张 `automatic-skater-*.png`。隔离服务已关闭。
- 动态发现的 44 步原生检查重新通过：`.local/creation-verification/prefab-animation-discovery/case-gYCgi6/report.json`；组件检查 6 项通过。
- 正式 48910 经原受保护启动器更新服务后，在用户原 Chrome 页「小巷漫步 / main」打开「3D 滑板青年 · 男」能力预览。实际构建 `build-c6a92198-3913-4d83-ba73-8ab214c77545` 自动启动；右侧三个动画和底部可用时间轴直接出现。页面操作实证：点击 run 后播放，暂停后进度条定位 0.35 秒并改变角色姿态，再恢复播放。源仍为 `src-249e1f8ad10f15dc7aaf9290bf4201e483a08daebaa8d70d393df25009297529`，没有新增作者测试场景，也没有发布游戏。

### 通用 Godot 场景模板复验（2026-09-11）

- 扩展 `prefab-automatic-preview.test.mjs` 后最终实测通过（78.7 秒）：真实市场 3D 滑板青年发现 3 动画，2D 探险家发现 8 动画；两份实际构建的 `prefab_preview_stage.tscn` 与 `.gd` 哈希一致，调用场景只绑定不同的 `target_scene`。已有作者测试场景时仍默认通用预览，显式选择作者测试场景也实际运行成功。三份 Web 构建均完成，预览期间源与测试场景清单不变。
- 2D 角色在 1050×720 页面缩放后，实际 786×461 视口内仍居中、完整可见，动画切换、暂停和时间轴定位可用；画面包含检查相机的 resize 修复。证据：`.local/creation-verification/prefab-automatic-preview/case-Zh5WvU/report.json`、`automatic-adventurer-resized.png` 及同目录初始/切换截图。隔离 48921 已关闭。组件检查 6 项通过。
- 正式 48910 原入口的最终构建 `build-16186710-0416-420b-8b99-1db90b2721f3` 已在 Chrome 实际加载，显示「通用动画预览」、自动播放 idle、右侧 3 动画和可用时间轴；通用动画页已隐藏三项场景运行控制，仅保留重置/停止与动画时间轴。源版本仍为上述 `src-249e1f8ad10…`。

### 简化进度条与实时拖动复验（2026-09-11）

- 组件检查 7 项通过：不渲染关键帧点、轨道与额外刻度；input 松手前发送定位，连续事件合并为最新位置，旧观察不拉回拖动位置，change 补发最终定位，关闭取消待发命令。
- 真实 Web 检查通过（78.8 秒）：尚未触发任何 change 时，两次 input 分别收到 Godot 的 0.081 与 0.352 秒反馈，对应角色区域截图有 581 个像素变化；松手后准确定位 0.217 秒。2D/3D 均无关键帧/轨道显示，原切换、暂停、resize、显式测试场景、权限与源不变检查通过。证据：`.local/creation-verification/prefab-automatic-preview/case-iQaCGk/report.json` 与 `live-drag-pose-1.png`、`live-drag-pose-2.png`。隔离服务已关闭。
- 正式 48910 无需重启或重新出包；刷新用户原页面后已显示单条进度条，并实际将 run 定位到 0.35 秒，截图确认无下方轨道和关键帧点。

### 豌豆射手原生 idle 复验（2026-09-11）

- 实际 `prefab-pea` 的模型没有动画片段；原摆动在花园游戏的外部表现脚本中。此次将同一摆动保存为预制件 `__Model/PeaAnimations` 的循环 `idle`，花园按原速度和实例相位手动采样同一片段。播放器位于实际复制的模型子树内，避免生成植物时丢失动画；其他植物保持原逻辑。浮点旋转轨道首键必须是 `0.0`，整数 `0` 会使 Godot 缓存错误的值类型，出现时间变化但姿态不变。
- 独立 `node --test tests/creation/prefab-pea-native-preview.test.mjs` 通过（87.2 秒）：真实源事务、原生 prefab/clone 正负峰、canonical `scene-harbor` 通过真实种植入口生成的植物均验证通过。4 种速度 × 3 个时钟点的最大摆动误差为 0.00003552 弧度，外容器无叠加摆动，向日葵原逻辑保持。Web 自动发现并播放 idle；仅发送 input、尚无 change 时，在 0.628 和 1.885 秒已更新引擎时间与可见姿态，时间轴没有下方点或轨道。证据：`.local/creation-verification/prefab-pea-native/case-G0V3VF/report.json`、`native.log`、`pea-input-1.png`、`pea-input-2.png`；隔离服务已关闭。组件检查 7 项通过。
- 正式 main 已保存到 `src-bfbc7b93c03837bc862c2a92fa82d4f9854f13fc2e6d009364d29cded7f9a63e`；预览构建 `build-7f2bb952-cf98-4a2d-9313-093206e22da2` 完成并在用户原 Chrome 页实际加载。右侧自动显示 idle，0.628/1.885 秒姿态不同，已恢复循环播放。源事务与回读位于 `output/pea-native-animation/`。此次保存原生源并验证预览，未发布游戏，也未修改 Boss 的独立规则。

### 通用脚本动画捕获复验（2026-09-11）

- `node --test tests/creation/prefab-procedural-preview.test.mjs` 最终通过（88.9 秒）：没有 AnimationPlayer 的原生预制件由 `_process` 与真实 Tween 驱动，自动捕获两个轨道；input 尚未释放时姿态更新，业务 clock/ticks 与 Tween 回调计数保持，继续后恢复正常运行。节点释放和同路径替换不污染替身；相机、2D 灯光、UI 自身持续移动也不会给静止主体生成动画。
- 实际 UI 点击「捕获脚本动画」会显示禁用的录制按钮和变化的秒数，结束后静态对象显示未观察到变化。动作区域的缓存键包含捕获状态和进度，避免引擎已经采样而界面没有刷新。
- 使用豌豆修改前的真实原生源清单（source identity `426abc00399622bb690ca919aa58fd57f5abdf9bd6c885fa4bfd5f6d50d258f7`），不添加动画节点、不改变原摆动脚本，在现有 `test-pvz-pea` 场景自动捕获 GardenPresentation 的两个实际 transform 轨道；0.4/0.65 秒 input 定位时头部和茎姿态不同，未达到捕获上限。两类工程源 head 均不变，普通游戏投影不包含采样器。三个实际 Web 构建的桥接与采样脚本均与本次最终代码一致，无页面/引擎错误，独立 48921 已关闭。
- 证据：`.local/creation-verification/prefab-procedural-preview/case-vAWNOZ/report.json`，以及同目录 `procedural-input-*.png` 和 `original-pea-input-*.png`。现有原生动画自动发现的 44 步检查通过（`prefab-animation-discovery/case-trxXqV/report.json`），前端组件 7 项通过。
- 正式 48910 原 Chrome 页使用最终构建 `build-633c7c04-6c9e-4c21-9931-a05a50f448fa`；实际点击捕获按钮后，原生 idle 与「程序动画 · 捕获」共同出现在右侧，时间轴可定位 0.4/0.65 秒，截图确认豌豆姿态实时改变。采样脚本和桥接文件与最终源码哈希一致；源 head 仍为上述 `src-bfbc7b93…`，此次没有修改游戏源或发布游戏。记录：`output/procedural-animation-preview/production.json`。
