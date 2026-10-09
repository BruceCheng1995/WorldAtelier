# 编辑窗口模式与独立试玩

2026-09-08 用户纠正后的当前设计。正式入口为 http://127.0.0.1:48910/creation-workspace.html。

共同创作共享中央源文档；编辑 Play 每个窗口各自启动一局。以前 Run 加入持久共享世界，退出再进入会回到同一进度；这一行为不再是编辑 Play 的默认值。

| 动作 | 当前窗口行为 | 其他窗口 |
| --- | --- | --- |
| 独立运行 | 固定源版本与当前场景，新建临时 Godot Web 客户端、本地模拟和角色；从初始状态开始 | 不加入、不改变其他局 |
| 暂停观察 | 清除输入，等本地模拟确认后暂停该局模拟与投影；接管实际游戏相机，游戏 UI 默认关闭 | 各自继续 |
| 显示 / 隐藏游戏 UI | 按节点原可见状态切换；原本隐藏的控件仍隐藏；显示时也不接收游戏点击 | 无影响 |
| 继续运行 | 恢复该局状态、UI 原可见性和交互、原游戏相机；清除旧按键 | 无影响 |
| 重新开始 | 释放整局 iframe，固定当前源版本，从初始状态重开 | 进度不变 |
| 停止并编辑 | 释放整局 iframe 的 UI、脚本、相机与音频，恢复保留的编辑视口与相机 | 源稿协作继续 |
| 新页面游玩 | 使用原 Web 出包服务固定源版本与当前入口场景，完成后打开独立页面 | 独立进度 |

停止在启动/资源加载/模式确认期间也可执行。每次运行有独立 nonce 与 `preview:<UUID>` 会话身份；异步加载代次和 bridge 身份检查拒绝旧客户端迟到事件。预制件定义仍只允许编辑。只读玩家的版本继续由原 `/playable` 权限接口决定。

`GamePlay` 通过统一 `play-build` 接口获得与新页面游玩相同的固定 Web 产物，实际游戏由 `GameRuntime` Autoload 和 `standalone.tscn` 启动。编辑预览不再通过 `world_client.gd/local_start` 初始化玩法；资源来自同一工程的固定依赖，不接收中央世界 checkpoint，不发送 `world_join` / `world_input` / `world_inspection`。`world_state.session_kind=local_preview`、真实本局 object_states/tick 用于界面状态与诊断。这不是服务端应用、发布或在线权威 ACK。断开协作 WebSocket 时已加载的本局继续，真实授权撤销仍终止客户端访问。

暂停通过本局 SceneTree、Simulation、行为 Tween、音频和粒子状态实现；独立调试桥和检查相机继续工作。接管自定义 Camera3D，保存并恢复游戏相机；不只是移动后台非当前相机。暂停时 CanvasLayer/CanvasItem 可见性与 Control 输入状态分别保存，恢复不会强行显示原来隐藏的 UI。该机制不承诺冻结任意 shader TIME 或游戏在自身运行树外创建的引擎服务。

本地观察的对象属性来自该局真实投影。会话附件按钮明确为「固定此版本的源对象」，固定同一源版本的对象定义与观察相机；不把本地模拟位置伪装为中央世界确认的观察。明确加入共享世界的旧协议保留原语义：只冻结个人投影，不暂停共享世界。

独立 Web 页面继续复用 [工程导出与应用打包](EXPORT-BUILDS.md) 的构建、权限及访问接口。服务端核对项目/分支/版本/入口、完整运行源码、生成器、实际工具链、存储域及兼容策略后才复用已有包；已完成包还必须有实际兼容回执。旧包自动触发新构建，历史文件和原哈希保持不变。

完整工程、预制件、存储、Agent 上下文与维护协议见 [统一游戏工程](UNIFIED-GAME-RUNTIME.md)。

## 上一版验证（历史）

以下是 `ModelPreview/local_start` 版本记录，保留追溯；不代表新统一游戏工程已经通过。当前证据见 [统一运行验证](UNIFIED-GAME-VERIFICATION.md)。

真实引擎、双浏览器与编排回归由独立测试角色执行。源码探针与 Web 导出实测分开记录；以本轮 evidence 为准，旧共享 Play 的验证不用于接受新独立 Play。证据目录为 `.local/creation-verification/independent-preview/`。

本轮实际 runtime build 为 `8e9caea4d3541c3df560d986b27e538926cc3f413a9df07eddf590e70a826a46`；正式服务读取的新清单与 38 个源码文件哈希一致。独立测试角色已完成 31 项真实 Godot 检查和 Chrome 双用户实测，详见 [独立验证记录](../tests/creation/independent-preview-plan.md)。另有 26 项源附件/层级/诊断回归与真实动画、Tween、粒子冻结恢复检查通过；这些不代替 Web 图像验证。

主集成在正式 Bruce1 / 植物大战僵尸2d / `scene-harbor` 上实际点击「开始防守」，游戏进入 battle 后暂停：tick/latest_tick 同为 14200，UI 隐藏。重新开始后会话 UUID 与 iframe nonce 均更新，phase 回到 ready、elapsed=0、sun=300、wave=0、zombies 为空；停止后只余原编辑 iframe。前视切换已有实际图像变化，恢复后回到游戏正交相机。正式记录与三张截图位于 `.local/creation-verification/independent-preview/bruce1-live/`。独立 48923 服务和自建页面已关闭；正式 Bruce1 留在编辑模式。此轮不宣称完整游戏通关或重新完成多人源稿编辑验收。
