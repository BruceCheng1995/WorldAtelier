# 世界工坊 · World Atelier

> 2026-09-08 产品统一：48900 中央门户已退役。唯一产品入口为 48910 创作工作台，`npm start` / `npm run dev` 启动同一服务。旧协议、客户端与测试仅作历史兼容；不再提供旧门户界面。

多人在同一世界里，通过对话、场景操作和预制件编辑共同创作游戏；在当前网页视口运行 Godot 试玩。中央服务器负责协作、分支、版本与世界状态。

- 新工程：`/Users/chengzhi/Projects/WorldAtelier`
- 本会话：`01a07603-21c3-7263-8699-0ca14e597427`
- 建立日期：2026-09-06
- 2026-09-09 已将五个现有分支迁移为完整原生 Godot 源稿：默认值继承与实例覆盖交给真实 PackedScene，中央服务保留协作、版本和显式试玩发行。原有 73 个源版本、19 个会话保留，目录包含 6 个场景与 22 个预制件。当前证据与最后复验状态见 [原生框架升级](docs/NATIVE-FRAMEWORK-UPGRADE.md)。
- 当前实现使用 `creation-native-1`；创作、独立同视口 Play 和显式加入的原生共享世界分别处理。2026-10-23 新增作者运行来源隔离、默认 60 秒试玩上下文、细粒度多分支合并、原生离线往返、本机客户端接续与跨分支私有会话延续。实际通过范围见本轮独立报告；早期六项 0.1.3 示例及旧框架报告只保留为历史技术证据。
- 当前产品基线：[协作创作工作台](docs/CREATION-WORKSPACE.md)。Play 在当前 Web 视口；暂停只冻结本人检查视图。

| 入口 | 内容 |
| --- | --- |
| [2026-10-23 本轮决策与讨论](docs/CREATION-NEXT-WAVE-2026-10-23.md) | Agent 试玩/交互/聚焦上下文、运行隔离、合并与离线往返；快速 Play 后置，托管以后讨论，多平台搁置 |
| [2026-10-23 独立验证](docs/CREATION-NEXT-WAVE-VALIDATION-2026-10-23.md) | 本轮实际 Node、HTTP、Godot、浏览器与真实 Agent 证据，以及明确未完成项 |
| [作者游戏运行隔离](docs/RUNTIME-ORIGIN-ISOLATION.md) | 同一服务上的独立运行来源、有限消息桥与旧存档迁移 |
| [本机客户端接续](docs/NATIVE-CLIENT-CONTINUITY.md) | 固定客户端增量准备、真实控制确认、失败恢复与提交后断连 |
| [原生合并与离线往返](docs/NATIVE-MERGE-OFFLINE-INTEGRATION.md) | 多来源局部冲突、补偿提交、用户工作区与断网 canonical 装配 |
| [产品目标与进度](docs/PRODUCT-EXPERIENCE.md) / [用户体验 Case](docs/USER-EXPERIENCE-CASES.md) | 产品需求、证据分层进度与从易到难的体验目标；按各例实际执行范围更新，历史快照不等于当前状态 |
| [多任务并行与验证](docs/PARALLEL-EXECUTION.md) | 主集成、两个隔离开发任务和单一独立测试角色；文件归属、阶段依赖与交付规则 |
| [README](README.md) | 工程结构与当前可用内容 |
| [总体架构](docs/ARCHITECTURE.md) | 中央服务器、各端体验、分支与世界设计 |
| [协议与数据模型](docs/PROTOCOL.md) | 版本解析、下载、状态同步、离线合并与会话交接 |
| [开发上下文](docs/DEVELOPMENT-CONTEXT.md) | 最新用户决定与实现顺序 |
| [Godot 研究资料](research/godot/4.6-stable/README.md) | 匹配本机版本的官方完整源码与技术边界 |
| [重建记录](docs/BOOTSTRAP-RECORD.md) | 旧工程清理与新工程建立的实际结果 |
| [当前验收入口](docs/ACCEPTANCE.md) | 新的创作旅程与历史技术验证区分 |
| [协作创作协议](docs/CREATION-PROTOCOL.md) | 场景/预制件、事务、个人检查、长期会话和 Agent 目标 |
| [验收报告](docs/VALIDATION-REPORT.md) | 精确版本、运行记录、截图、失败修复及风险 |

旧工程的功能、测试和服务不计入新工程的完成度。后续实现、文档和验收都在本目录内进行。
