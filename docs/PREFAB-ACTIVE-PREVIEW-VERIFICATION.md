# 能力预览视觉与主动行为改版 · 2026-09-09

## 当前交付边界

原工作台前端已修改：保留预制件目录，扩大游戏画面；右侧提供动画、技能、状态和控制器。测试场景切换与管理置于顶部，靶子和外部影响移入「场景工具」，观察数据与事件移入「测试记录」。操作结果、选中状态及不可用原因均来自真实运行反馈。

PvZ 测试舞台改用原游戏花园与博士场地。默认独立展示主体；主动技能不暗中添加攻击者。豌豆的固定靶保留真实血量、弹丸碰撞及伤害。博士释放技能时调整取景范围。程序动画通过真实动作演示；原生动画片段才显示时间轴。

**中央源稿尚未更新。** 当前生产 PvZ main 仍是 `src-87fe503a05deea8a9c06cbd4e2e8b9ecc6c9943208983abd9ef5d6c446509d2b`。新版三份测试文件已完成隔离验证，等待通过已登录的正常创作入口保存，或在其他创作任务全部结束后执行带备份、当前源与文件哈希守卫的本地维护事务。部分服务模块需安全重启后加载。构建与验证没有公开发布游戏。

## 当前版本证据

- [独立真实 Godot Web 工作台报告](../.local/prefab-active-v2-testing/case-1788957877746/active-ui-1788959304610/report.json)：真实原生动画列表、时间轴采样与倍速；主动技能、状态与控制器；外部工具分离；依赖条件禁用与靶子恢复；弹丸命中、掉落、受伤；重置与退出。全部通过。
- 组件检查 5/5 通过，包含旧动画反馈协调、关闭取消、只读权限、按需听写，以及 1000px/610px 下管理和场景工具入口可达。
- [生成器检查](../.local/prefab-active-v2/starter-check/case-4yNCuz/report.json)：当前生成器的真实 2D/3D starter 在 Godot 导入并运行，18 项检查通过，包括说明、selection 转发和靶子操作。
- [PvZ 原生能力报告](../.local/prefab-active-v2/runtime-delivery-report.json)：五类主体实际技能和状态通过；新增程序动画动作通过；无靶发射正确拒绝。该报告保留中间版本哈希，最终文件以冻结清单为准。
- [固定靶检查](../.local/prefab-active-v2/fixed-target-report.json)：等待 1200 个真实物理帧后，主体仍为 180/180，靶固定在 x=2.8；单次发射造成 28 点真实伤害。
- [最终冻结文件清单](../.local/prefab-active-v2/changed-files.json)：仅 `test_scenes/pvz_capability_preview.gd`、`check-pea.json`、`check-zombie.json`；适配器 SHA-256 为 `046663f2bfde0942274f8bd8beb8d32b1a62f0a2f27ce594d379c4e1a1477eb0`。
- [最终豌豆实际画面](../.local/prefab-active-v2/screenshots/05-final-pea.png)、[技能与固定靶画面](../.local/prefab-active-v2/screenshots/06-final-pea-skill.png)：在原工作台隔离测试实例人工检查。配置固定靶后超过 2500 物理帧，再点击发射，页面运行观察确认主体 180/180、僵尸 77/105、弹丸伤害 28。实际构建 `build-ed8b0079-abfd-4498-87ef-ad1e48d402e0`，源 `src-fd237cf505800b70e88aed50fac2124852c1afdc5db84bfe7967b18348d0a6e6`；独立只读核对确认它与此前 `src-68b16b606758fec9b06bcf3446576e14e7bf3387789d2f11fe5a5483f51a185d` 完整内容一致，共同 source identity 为 `94c270d713ab5fd95fce09ef604f240635c172871193b55d91e57cb4f705c817`，三份冻结文件也与实际归档逐字节匹配。
- [博士技能实际画面](../.local/prefab-active-v2/screenshots/04-doctor-abilities.png)、[向日葵产出实际画面](../.local/prefab-active-v2/screenshots/03-sunflower-action.png)：改版中的真实 PvZ 场景画面；早于最终说明文字调整。

本次验证前端的 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `prefab-lab.js` | `81a52b133d8d6103a1b11c363b2d3ff1dcbab9f2f1ad82fb0ca08d7d23a2772c` |
| `prefab-lab.css` | `46453bbd1c86ad3bf505902fb012073b9be3ac3328185fa0b386a850575b4a33` |
| `animation-timeline.js` | `80cd69b78730d236224821bc900a01de77009b3379c6f82c2648a51a3af4b153` |

正式游戏与测试工程的隔离规则未改动。此前打包检查见 [首版验证](PREFAB-CAPABILITY-VERIFICATION.md)，属于先前证据，不能替代本次中央源保存或构建完成的回执。没有添加自动验收调度或源保存门禁。
