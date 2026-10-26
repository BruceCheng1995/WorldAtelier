# 游戏创建与需求修改技能

2026-10-25。创作者会话使用两份版本化技能承接新项目规划和后续开发，继续复用已有资产技能、源事务与任务对话。

| 技能 | 触发与产出 |
| --- | --- |
| [game-create：新游戏创建](../skills/game-create/SKILL.md) | 新游戏/空项目：拆分场景和预制件及各自用途；确定 2D/3D、主角、多人方式、核心循环和场景跳转；搜集美术、音效、UI 候选与可检索描述；在当前任务中记录详细需求。 |
| [game-change：游戏需求修改](../skills/game-change/SKILL.md) | 已有游戏新增/调整/修复，或规划后的实施：查预制件、场景、知识和代码关联；选择修改/复用/新增；指定相称验证方案；开发；同步描述、实际属性与修改记录；验收交付。 |
| [game-assets：资产搜集与制作](../skills/game-assets/SKILL.md) | 搜索、下载、制作、适配与导入素材，保持引用式上下文和来源记录。 |

技能随平台仓库维护，`agent-skill-catalog.mjs` 是白名单目录。会话准备时将完整技能目录投影至 `.agents/skills/`，包含按需读取的需求/变更模板与界面元数据；`workspace.json.skills`、AGENTS.md、WORLD-API.md、新建/恢复线程以及每轮提示提供入口。已有 cwd、线程、任务记录、其他技能和未提交文件继续保留。

当前没有专门的 `task_write` 动态工具。需求正文记录到当前任务的会话消息；允许写文件时，再保存到会话 `outputs/tasks/<run_id>/requirements.md` 或 `change-record.md`。规划模式遵从只读限制，在对话中交付完整方案。共享知识通过既有 `knowledge_search/read/write` 保存公共设计摘要，不复制私人会话，也不替代任务记录。

技能指导 Agent 选择测试；不新增自动验证调度、独立验证 Agent、保存门禁或发布流程。原生源、实例覆盖与 canonical 启动语义遵循原工作台契约。独立 Play、多人游戏、保存、构建和发行各有单独的证据边界。

集成检查使用临时数据库与显式 fake transport，验证真实文件投影、原生/历史会话入口、创建/恢复/下一轮提醒以及越界保护；这不证明真实创作者模型已按技能完成游戏，也不代表玩法或视觉验收。

本次验证：两份技能 `quick_validate.py` 均通过；`agent-skills.test.mjs`、`agent-prefab-policy.test.mjs`、`agent-environment.test.mjs` 合计 20 项通过，其中环境回归包含真实 headless Godot 检查，技能提示链路使用显式 fake transport。另对“仅规划无主角卡牌游戏”和“单炮塔实例参数修改并新增命中特效”进行了只读行为推演，未将其计为真实游戏执行。

在确认无活动开发/构建及 Godot 运行进程后，原 48910 服务受控重启。健康接口返回 `game-create`、`game-change`、`game-assets`，`automatic_verification` 仍为 false；工作台 HTTP 页面与原源码一致。重启前后 10 个项目、12 个分支、158 个源版本、61 个会话、536 条消息、82 个目标记录的数量及逐记录内容摘要完全一致。只读对照回执位于 `.local/creation-verification/game-workflow-skills-2026-10-25/`；本次没有启动真实创作者模型去制作游戏，也未发布游戏。
