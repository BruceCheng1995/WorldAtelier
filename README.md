<p align="center">
  <img src="apps/creation-workspace/branding/world-atelier-site-v5-128.png" width="72" height="72" alt="World Atelier 标志" />
</p>

<h1 align="center">世界工坊 · World Atelier</h1>

<p align="center">
  <strong>与 AI 和伙伴一起，把游戏持续打磨下去。</strong>
</p>

<p align="center">
  对话创作 · 可复用预制件 · 可视化调参 · Godot 网页试玩
</p>

<p align="center">
  <a href="#创作体验">创作体验</a> ·
  <a href="#核心设计">核心设计</a> ·
  <a href="#本地运行">本地运行</a> ·
  <a href="#继续了解">技术文档</a>
</p>

![世界工坊游戏库：多个 2D、3D 游戏工程，以及各自的分支、成员与访问权限](docs/images/game-library.png)

<p align="center"><sub>现有工作区的游戏库实拍。每个游戏都有自己的分支、协作者与创作记录。</sub></p>

世界工坊是一个 **AI 协作游戏创作工作台**，把 Agent 对话、场景与预制件编辑、版本管理和真实 Godot 试玩放在同一个浏览器界面里。

你可以从一个想法开始，让 Agent 制作场景、素材与玩法；也可以直接调整对象参数、替换素材、指出试玩中的问题，与伙伴一起继续完善作品。

项目关注游戏的第二次、第二十次修改：**创作者怎样把感受表达清楚，Agent 怎样理解现场，已有成果怎样在持续迭代中保留下来。**

## 创作体验

### 01 · 指出问题，让 Agent 理解你刚才经历了什么

“我按了两次交互，门还是没打开。”这类反馈需要操作经过、发生位置和当时的游戏版本。

工作台默认在当前窗口保留最近 **60 秒**的操作记录与关键画面。发送反馈时，可以附带操作时间线、关键画面和选中的对象；通过“指出这里”进入观察，点选或框选关注区域，再交给 Agent 继续调查。编辑场景时，也可以用空间点、区域或截图批注表达具体意图。

附件固定当时的对象、坐标和版本。Agent 可以读取观察材料、查询当前源稿，再修改实际工程；旧反馈不会随着对象移动或分支切换而悄悄改变。

> **试玩 → 指出问题 → 带上下文反馈 → Agent 修改 → 重新试玩**
>
> 你负责判断体验，工作台负责把这份判断送到正确的开发上下文里。

### 02 · 把一次创作，积累成可复用的内容

角色、建筑、机关和玩法系统可以组织为独立预制件。全部定义都有自己的目录和编辑入口，尚未放入场景的内容也能被找到、打开和复用。

可调属性连接真实的 Godot 属性：数值、开关、枚举、颜色等可以直接编辑。创作者可以调整一个实例，也可以修改预制件定义；未覆盖的属性跟随定义，单独调整过的值保留，并支持恢复默认。

这让日常迭代有了更短的路径：调整难度可以先改参数，修改某个机关可以聚焦该预制件，增加新行为再交给 Agent。模型、贴图、脚本和其他资产随工程一起版本化，已有内容可以继续使用。

### 03 · 与伙伴共同编辑，也给不同想法留出空间

协作者可以在同一分支编辑场景，查看彼此的选中对象和编辑状态。手动操作与 Agent 修改都通过中央源稿事务保存，遵守相同的权限和版本约束。

想尝试另一种地图布局或玩法方向，可以从固定版本分出新分支。主干和分支拥有相同的创作入口；合并时先查看差异、处理冲突，再形成新的源版本。内容合并与试玩进度分别管理。

**编辑器内 Play 是每个窗口独立的一局。** 暂停检查只暂停当前试玩，自由相机仍可观察场景；伙伴可以继续编辑或运行自己的游戏。重新开始时，从选定源版本的初始状态启动。

### 04 · 让下一轮创作接得上上一轮

每位协作者可以在每个分支保留多个长期 Agent 会话，持续积累讨论、附件和实际修改记录。切换创作方向时，可以将选定历史与观察带到新分支，创建独立会话继续开发。

上下文也能精确到游戏内容：`@` 引用场景对象，`@@` 引用预制件，`$$` 查找游戏知识。描述、参数与知识跟随源版本，Agent 按需读取实际定义和实现；资产通过紧凑引用传递，细节在需要时展开。

创作者由此可以围绕“这个敌人”“这段规则”“刚才的操作”继续讨论，逐步把设计意图落实到同一份作品中。

## 核心设计

世界工坊采用 **Node.js + SQLite + 原生 Web 界面 + Godot 4.6**，Agent 执行接入 Codex App Server。中央服务管理工程、成员权限、分支、会话与构建，浏览器承担编辑和游戏体验。

| 设计选择 | 对持续创作的价值 |
| --- | --- |
| **完整 Godot 原生工程作为内容源** | 场景、资源、脚本和资产保留原生文件；预制件继承与实例覆盖交给引擎解释。Web、Agent 和离线工作区的修改汇入同一版本化源稿。 |
| **统一的游戏启动工程** | 编辑器 Play、独立 Web 和 Agent 固定测试工程使用同一套装配与启动逻辑，减少“编辑时看到一套、运行时又是一套”的偏差。 |
| **保存、构建与发布各自明确** | 保存产生源版本，构建固定工程与工具链，显式发布才更新公共试玩版本。创作者可以继续修改，玩家仍能进入确定的已发布构建。 |
| **游戏运行与创作权限分离** | 作者游戏在独立浏览器来源中运行，通过有限消息接口提供观察与交互，保持游戏运行与工作台创作、管理 API 的权限边界。 |

原生文件往返保留 Web 不认识的节点、资源和属性；原生离线工作区支持基于固定版本修改、同步与冲突处理。架构和实现细节见[原生框架](docs/NATIVE-FRAMEWORK-UPGRADE.md)、[统一游戏工程](docs/UNIFIED-GAME-RUNTIME.md)和[离线往返](docs/NATIVE-MERGE-OFFLINE-INTEGRATION.md)。

## 项目状态

当前是持续开发中的本机 / 局域网工作台，已有真实 Agent、Godot Web、原生源稿编辑和协作流程接入。

[2026-10-23 独立验证记录](docs/CREATION-NEXT-WAVE-VALIDATION-2026-10-23.md)包含实际试玩反馈到 Agent 修复、明确重开后的行为检查、跨分支续聊、合并与离线往返等链路，并分别记录服务、引擎、浏览器和 Agent 的验证范围。

其中，“两次交互仍无法开门”的用例记录了真实输入、Agent 读取试玩上下文并提交修复，以及重开后第一次交互保持关闭、第二次交互打开的实际行为。保存修复时，原先正在试玩的一局仍保留原版本。

接下来优先缩短编辑到 Play 的等待，完善更长周期的创作体验；长期托管与跨平台发行仍待进一步探索。当前没有公网托管服务，本机验证范围不代表跨平台或大规模部署已经完成。

## 本地运行

以下按当前 **macOS 开发环境**说明。首次运行需要：

| 依赖 | 要求 |
| --- | --- |
| Node.js | **24 或以上**，版本要求见 [package.json](package.json)。 |
| Godot | 官方 **4.6 stable**，安装匹配的 Web 导出模板。 |
| Codex CLI | Agent 创作需要可用的登录与兼容的 App Server；接入约定见 [Codex 集成](docs/CODEX-INTEGRATION.md)。 |

```bash
git clone https://github.com/BruceCheng1995/WorldAtelier.git
cd WorldAtelier
npm install
npm run build:preview
npm start
```

打开 **[世界工坊工作台](http://127.0.0.1:48910/creation-workspace.html)**。

`build:preview` 准备编辑视口；具体游戏在 Play 时构建。`npm start`、`npm run dev` 和 `npm run start:preview` 使用同一个启动器，复用已经运行的本项目服务。界面、创作 API、Agent 会话与 Godot Web 共用 `48910` 入口。

<details>
<summary><strong>工具路径、账号与局域网配置</strong></summary>

- 默认 Godot 路径为 `/Applications/Godot.app/Contents/MacOS/Godot`，Codex 路径为 `/opt/homebrew/bin/codex`。路径不同时，在构建和启动前分别设置 `GODOT_BIN`、`CODEX_BIN`。
- 本地 HTTP 兼容适配固定校验 Godot 版本 `4.6.stable.official.89cea1439` 与官方导出模板；升级工具链需重新核对适配。
- 在服务运行账户下用 `codex login status` 检查登录。App Server 接口兼容性需随 CLI 升级核对，详见接入文档。
- 空数据库的首个注册账号可创建第一个游戏。其他新账号默认可浏览、试玩，获得编辑授权后可创作并启动 Agent。
- 默认开放局域网连接与注册，启动器会打印可访问地址。仅本机使用时，在启动前设置 `WORLD_ATELIER_LAN=0`。
- 正式数据保存在 `.local/model-preview/`，不随 Git 分发；截图中的游戏属于已有工作区。安装后可创建自己的游戏。

完整配置、后台运行和权限说明见[本机开发指南](docs/LOCAL-DEVELOPMENT.md)。

</details>

## 开发与验证

| 命令 | 范围 |
| --- | --- |
| `npm test` | 当前创作协议、工程装配、上下文、合并等单元与集成检查。 |
| `npm run test:creation:engine` | 需要真实 Godot 的试玩上下文与原生离线往返检查。 |
| `npm run test:legacy` | 保留的历史协议兼容检查。 |

测试通过范围以具体用例为准，浏览器交互和游戏体验需按改动另行验证。独立测试使用隔离的数据、世界和端口，约定见 [AGENTS.md](AGENTS.md)。

<details>
<summary><strong>仓库结构</strong></summary>

```text
apps/creation-workspace/  浏览器工作台：场景、预制件、协作、会话与试玩
services/creation/        源稿事务、权限、Agent、分支与构建管理
services/preview/         工作台与运行产物的统一服务入口
runtimes/model-preview/   Godot 编辑视口与观察工具
tools/release-template/   统一游戏运行入口与调试桥
packages/contracts/      协议与数据约束
skills/                  创作 Agent 的版本化工作指南
tests/creation/          当前创作能力的测试与验证驱动
docs/                    产品设计、实现约定与分层验证记录
```

其余历史兼容模块的职责见 [PROJECT.md](PROJECT.md)。

</details>

## 继续了解

| 你关心的内容 | 阅读入口 |
| --- | --- |
| 产品交互与创作流程 | [创作工作台](docs/CREATION-WORKSPACE.md) · [用户体验案例](docs/USER-EXPERIENCE-CASES.md) |
| 试玩反馈与 Agent 上下文 | [上下文设计](docs/CREATION-NEXT-WAVE-2026-10-23.md) · [视口批注](docs/VIEWPORT-ANNOTATIONS.md) |
| 原生源稿、预制件与游戏启动 | [原生框架](docs/NATIVE-FRAMEWORK-UPGRADE.md) · [统一游戏工程](docs/UNIFIED-GAME-RUNTIME.md) |
| Agent 执行与资产工作流 | [执行环境](docs/AGENT-ENVIRONMENTS.md) · [资产工作流](docs/AGENT-ASSET-WORKFLOW.md) |
| 实现范围与验证依据 | [独立验证记录](docs/CREATION-NEXT-WAVE-VALIDATION-2026-10-23.md) · [工程导航](PROJECT.md) |
