# 原生框架补齐验证

本报告记录 2026-09-09 的原生共享世界与 Control 布局实现。首轮原生源稿迁移的历史验收见 `NATIVE-FRAMEWORK-UPGRADE.md`；本轮使用新的隔离世界、固定工程、真实 Godot 和浏览器结果。

## 实现范围

- 真实 `.tscn` / `PackedScene` 继续作为源稿权威。原生实例继承默认值，只保存实际覆盖；恢复默认解除覆盖，源稿修改无需逐实例升级。
- 显式共享运行使用同一固定工程的完整 Godot 权威和去作者脚本的原生显示工程。真实场景应用后才授予输入控制权，保存声明的状态并支持重连、换关、个人观察及版本转移。
- 导出默认参数兼容更新保留权威进程与声明状态；脚本或结构变化使用验证后的检查点转移。任意未声明脚本内存不属于可迁移状态。
- Control 布局通过实际 Godot 布局 API 保存：参数、锚点、拖动、八角尺寸调整、覆盖恢复、字节撤销、协作预览和版本冲突保护。Container 的几何由容器管理。
- 旧 Control 索引可直接打开，实际引擎观测只补充当前窗口测量值，首次编辑无需改写或升级旧源版本。
- Agent 的实际原生工作区指南包含共享状态、输入与迁移契约以及 Control 布局命令。独立 Play 与共享发布继续使用独立入口。

## 已完成的本轮检查

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 主目录共享协议、事务、桥接、发布权限、颜色与日志边界 | 42/42 通过 | `.local/native-completion/shared-final-main-tests.log` |
| 原生观察矩阵和不可变批注回归 | 11/11 通过；统一 canonical canvas_transform 与编辑器 world_transform_2d，保留完整矩阵及版本校验 | `.local/native-completion/inspection-final-tests.log` |
| 共享公开玩家诊断、观察矩阵与客户端代次回归 | 26/26 通过；包含权限撤销、窗口隔离和临时加载代次拒绝 | `.local/native-completion/diagnostics-inspection-bridge-final-tests.log` |
| 主工作台模式、共享批注、布局取消与原生 Agent 协议回归 | 47/47 通过；取消使用当前视口的实际观测，拒绝旧源版本或其他对象观测 | `.local/native-completion/workspace-final-tests.log` |
| 主目录 Control 与旧索引回归 | 5/5 通过；含真实 Godot 保存和 SQLite 字节撤销 | `.local/native-completion/control-final-main-tests.log` |
| Control 原生保存与显示派生布局 | 4/4 通过；真实导入/重复保存无隐式覆盖、默认跟随与 reset，两个实际视口的 bake 布局一致 | `.local/native-completion/control-alias-final-tests.log` |
| 原生导出布局与固定工程策略 | 20/20 通过；真实 Web PCK 在无松散源目录加载，布局和包内源字节一致；工程配置回提与完整构建身份回归 | `.local/native-completion/export-layout-final-tests.log` |
| 选择回传、模式与取消回归 | 29/29 通过；原生鼠标选择不回传 select/场景重载，对象列表选择仍发引擎命令 | `.local/native-completion/selection-drag-final-tests.log` |
| 原工作台 Control 基础编辑与协作 | 前 7 组通过：完整预制件目录/独立打开、实际尺寸事务、实例独立、撤销冲突保护、双端 CAS、Container 与持久化；整份早期报告在下一取消项中止 | 下述独立目录 `evidence/original-control-2026-09-09T03-20-00-906Z/report.json` |
| 原工作台 Control 取消与复杂布局 | 6/6 通过；实际画布取消恢复、旋转父级 resize、pivot/负缩放、预设/reset、独立 Play/观察/停止 | 下述独立目录 `evidence/original-control-2026-09-09T03-25-26-558Z/report.json` |
| 新导入 Control 继承与不同逻辑视口 | CF01–CF04 通过；无覆盖实例随定义更新，显式宽度保留，恢复继承，真实 850×879 视口取消恢复且源 head 不变；报告在 CF05 旧选择回传错误中止 | 下述独立目录 `evidence/control-import-final-2026-09-09T03-35-28-074Z/report.json` |
| 修复后原工作台真实鼠标拖动与权限 | CF05/CF06 2/2 通过；selected→start→preview→commit，实际事务 200，原 UI 撤销恢复源字节；viewer 只读和未知文件哈希保留 | 下述独立目录 `evidence/control-tail-final-2026-09-09T03-48-10-333Z/report.json` |
| 最终真实 Web Play 布局 | CP01 通过；全新固定导出，CardA/B 初次 loaded 与暂停检查的 size、anchors、offsets 均与编辑器一致；停止后源 head 不变 | 下述独立目录 `evidence/control-final-play-2026-09-09T03-54-22-919Z/report.json` |
| 固定共享工程、动态实例与未就绪输入拒绝 | 5/5 通过，真实权威 | 下述独立目录 `evidence/backend-smoke-2026-09-09T02-11-54-547Z/report.json` |
| 原工作台双端共享、真实输入、动态实例、公开加入、个人检查、换关与权限负例 | 12/12 通过，实际 Godot 应用后才获得控制权 | 下述独立目录 `evidence/original-shared-2026-09-09T02-35-53-058Z/report.json` |
| 原工作台版本更新与真实进程转移 | 5/5 通过；未发布源稿不影响房间，兼容更新保持 PID/epoch，不兼容状态拒绝后旧房间继续，完整更新 PID 76391→79071、epoch 3→4 | 下述独立目录 `evidence/shared-lifecycle-2026-09-09T02-50-42-789Z/report.json` |
| 原工作台公开访问、B 场景检查批注与撤权 | 4/4 通过；实际公开加载诊断 200，检查记录成功，原会话收到 B 场景完整地址及 camera 的不可变附件 201，撤权后访问与诊断均 403 | 下述独立目录 `evidence/shared-inspection-2026-09-09T03-13-27-133Z/report.json` |
| 完整备份、恢复与真实权威冷启动 | 3/3 通过 | 下述独立目录 `evidence/backup-cold-2026-09-09T02-17-03-960Z/report.json` |
| 最终完整备份与恢复后原 UI 冷启动 | 3/3 通过；当前备份 CLI 保留完整固定输入，恢复后真实 B 场景、Autoload、动态实例和输入序列继续，新 epoch；恢复服务及子进程已关闭 | 下述独立目录 `evidence/backup-cold-2026-09-09T03-32-10-291Z/report.json` |
| 备份与自动备份回归 | 32/32 通过 | `.local/native-completion/backup-tests.log` |
| 真实共享权威生命周期 | 2/2 通过；含 A→B→A、恢复、新默认值先于 `_ready` | `.local/native-framework/workers/native-shared/evidence/` |
| 真实无作者脚本客户端 | 28/28 通过；真实输入、应用确认、暂停与恢复 | 同目录 `client-probe-report.json` |
| 旧 Control 原生往返与实际 Chrome Inspector | 通过；保存前旧 head、revision JSON、源字节不变 | `.local/native-framework/workers/control-compat/actual-report.json` 与 `browser-report.json` |

独立测试目录：`.local/creation-verification/native-framework-independent/native-shared-control/case-nzgc43q8/`，最终独立复核汇总为该目录 `final-independent-review.json`。协议和桥接单测的测试替身不算真实 Godot 确认；真实原工作台结果单独记录。早期失败日志保留，包含已修复的 Container 内部连接、超过日志尾部上限的加载标记，以及显示工程临时加载代次抢先覆盖实际权威代次的问题。后者修复后重新完成了整轮生命周期验证。基础双端轮的观察记录和公开诊断旁路错误单独修复并纳入最终补测，不以原有通过项掩盖旁路失败。03:25 的 Play 检查只覆盖尺寸与模式切换，不作为位置一致性的证据；位置、尺寸和锚点的完整比较来自最终 CP01。

## 原工作台与正式服务

正式 48910 已受控重启为原 `services/preview/server.mjs`，最终监听进程 98982。健康接口确认 `native_shared_worlds`、`native_control_layout` 开启，`automatic_verification` 保持关闭；7 个 HTTP 前端文件与主工作区字节哈希一致。再次 `npm start` 复用同一服务。启动初期的一次 5 秒健康检查超时已保留在执行记录中，服务就绪后完整检查通过。证据为 `.local/native-completion/formal-service-verification.json`。

原 Chrome 登录窗口（Bruce1）完成 6 项实际 UI 检查：原游戏和原生编辑器加载、共享世界真实状态面板、原游戏当前视口独立运行、暂停观察默认隐藏游戏界面并开放相机、恢复运行、重新开始并返回原编辑器。重新开始复用固定 `build-37c3f5a3-6d9e-441c-8d1f-6c7fd74b692d`，生成新的运行 iframe，停止后恢复原编辑 iframe。实际截图和 DOM 记录在本任务 CUA 轨迹中，核对摘要为 `.local/native-completion/formal-ui-verification.json`，实际构建回执为 `formal-play-build.json`。此处验证框架入口与模式生命周期，不等于全部五个游戏的完整玩法验收。

最终导出修复后，同一正式窗口另完成 4 项实际检查：修复后原生编辑器、全新固定 Web 游戏、暂停观察、停止返回原编辑器。最终 Play 为 `build-20ace4a0-c074-4a2f-ade7-ad9bc3335ed2`，实际渲染“晨光花园”，配置确认直接保留文本场景资源，策略哈希与主目录完全一致。编辑预览使用 `build-29361773-f95e-4530-8b2a-d24325130f3f` 和最终 baker。证据为上述 UI 记录的 `final_recheck` 与 `.local/native-completion/formal-final-play-build.json`。最终界面停留在原编辑模式，源稿、会话及权限保持原状。

首轮切换与实际运行前后，435 个源稿、版本、会话、消息、用户、权限和存储保护记录保持一致，见 `.local/native-completion/first-switch-formal-retention-before.json` 和 `first-switch-formal-retention-after.json`。随后正常账号登录更新了一条用户的 last_login_at，未回滚该活动；最终服务重启基线在这次登录后重新记录。当前 `.local/native-completion/formal-retention-before.json`、`formal-retention-after.json` 再次确认 435 个保护记录、5 个分支 head、19 个会话及 200 个源对象 SHA-256 一致。比较只排除项目/分支自动封面 presentation，正常生成的新构建与通知单独保留。

早期失败证据另保留 Control 未编辑实例打包引入布局别名、显示派生场景增长方向变化、鼠标选择回传取消拖动，以及 Godot 4.6 导出文本资源时再次打包重置位置。实际无 Autoload 加载与 Web PCK 二分探针定位最后一项；修复后导出包直接保留原生场景。两个对照包的实际输出见 `.local/native-completion/control-export-probe/binary-pack-runtime.log` 与 `text-pack-runtime.log`。最终原 UI 补测已经覆盖这些失败点，不修改历史失败报告。

独立 CP01 与正式最终 Play 的 runtime_source_hash 均为 `071286688d70abd3d11a8fbb16ce783f1fd99a9b9066426d94036ce2abe68188`。完整 build_policy_hash 分别为 `1d00349f…` 和 `8a9a3d20…`；逐文件比较发现唯一差异是主目录 `native-agent-workspace.mjs` 追加的 Control / shared 作者指南文本，不涉及运行或构建执行逻辑。该差异和两份完整策略清单位于独立目录 `final-policy-difference.json`；不将它们写作相同构建身份。最终独立服务正常退出、子进程列表为空，48921 已释放；正式 48910 保持运行。
