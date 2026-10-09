# 独立编辑器运行与暂停观察：独立验证计划

本轮执行角色为唯一独立测试者；主集成者修改实现。用户最新语义覆盖旧共享 Play 设计。测试端口为 48923，使用独立源版本、账号、数据、世界，不占 48921，不修改正式 Bruce1 内容。下表是设计时的判据；本次实际结果和覆盖边界见文末。

| 用例 | 实际操作 | 判据 |
| --- | --- | --- |
| I01 | 两个独立认证窗口进入同一固定源场景，各自运行 | 两个运行标识与模拟实例不同，源版本一致；各自初始交互计数为 0，无共享角色控制 |
| I02 | 仅 A 正常移动并 E 交互，再仅 B 交互两次 | A/B 玩家坐标与计数只受各自输入影响；A=1、B=2，使用真实模拟状态与画面确认 |
| I03 | A 暂停观察 | 游戏 CanvasLayer 默认消失；原来隐藏的 UI 仍隐藏；A 的相机保持可控制；B 按当前契约继续运行 |
| I04 | 暂停状态在原游戏 UI 覆盖区域拖动视角、平移、缩放 | 相机实际 position/target 改变并在截图中体现；玩家/对象模拟状态不因相机操作变化 |
| I05 | 暂停时打开/关闭 UI，再继续运行 | UI 可见性可逆，切换不重复实例化、不改变交互计数；原来隐藏的 Control 不能被错误显示；继续运行恢复合理 UI 状态 |
| I06 | A 重启 | A 生成新的运行实例并回到初始计数/坐标/输入序列；B 的实例、进度与控制不受影响 |
| I07 | A 停止并再次运行；加载期间停止/重启 | A 回到源稿编辑；迟到的资源/运行结果不能恢复旧 UI 或控制；新运行从初始状态开始 |
| I08 | 两窗口的源对象与预制件编辑 | 编辑文档仍按原协作事务同步；测试中的运行态计数/坐标不写回源稿 |

`independent-preview-fixture.mjs` 提供真实 GDScript 夹具：满屏 `MOUSE_FILTER_STOP` Control、品红 CanvasLayer、可见状态计数、原本隐藏的子 Control、相机地标。交互计数由 authority `interact` 回调产生，测试不直接写 gameplay state。

分层证据：Godot headless 证明实际模拟隔离、正常输入、初始状态与 UI 节点/相机变换；CUA 双窗口证明实际 Web UI 显隐、图像变化和窗口状态对比；VM 只用于生命周期围栏，不替代前两层。必须等主集成提供构建及源码匹配信息后启动服务与导出运行测试。单独 headless 开发可在临时源码副本中执行，并明确它不是当前发行构建验收。

## 2026-09-08 实际执行结果

正式 runtime build `8e9caea4d3541c3df560d986b27e538926cc3f413a9df07eddf590e70a826a46`。执行命令：

```sh
WORLD_ATELIER_EXPECT_RUNTIME_BUILD=8e9caea4d3541c3df560d986b27e538926cc3f413a9df07eddf590e70a826a46 node --test tests/creation/independent-preview-godot.test.mjs
node --test tests/creation/preview-mode-lifecycle-workspace.test.mjs
```

Headless：31 项实际 Godot 检查全部通过，无引擎脚本错误；测试先将 manifest 列出的全部源码哈希与独立测试副本逐项匹配，再执行。证据在 `.local/creation-verification/independent-preview/2026-09-08T03-24-59.087Z/`，`result.json` 列出每项检查和关键状态，`runtime-source-manifest.json` 记录源码/build 匹配。VM：最终 12 项生命周期检查通过，明确使用假的 DOM/iframe/API，保留 legacy shared Stop 释放本人控制用例。末次补充的两个故障边界用例执行生产 `onPreviewEvent`/`suspendWorld` 切片与实际 `WorldModeSequence`，证明初次启动失败返回编辑并销毁失败 iframe，而已运行的脚本错误在进入暂停的待确认阶段仍保留当前局、冻结源稿与错误文本。这两个边界的运行事件为显式测试替身；没有据此追加真实引擎/Web故障注入验收声明。

CUA：使用真实 Chrome 两个标签页，分别以临时用户 A/B 登录 `127.0.0.1:48923` 与 `localhost:48923`，共享同一个临时服务和固定源稿；不同 origin 只用于隔离浏览器账号存储。项目 `game-4f6f6d61-6afd-4091-af08-6babfdbc11d8`，场景 `scene-harbor`，源稿 `src-ad51e08aa94cf584a9c90bb14d290d5535b4916e3c0f2e0317b2704c37d50fc2`。两页实际 iframe build 均为上述 build，未向页面直接注入状态或运行 ACK。

| 实际浏览器检查 | 观察结果 |
| --- | --- |
| 双窗口独立运行和交互 | A 正常交互后计数 1，B 仍 0；B 两次交互后为 2，A 仍 1。A world `preview:38aa220f-bff1-45f9-ab83-764441f5069b`，B world `preview:c861ce10-843c-41f7-838e-5a2f89aab63c` |
| 仅 A 移动 | A 位置到约 `[0.46438,-0.05059,2.64697]`；B 保持 `[0,-0.05031,3]` |
| A 暂停，B 继续 | A 的实际 tick/计数冻结在 `4764/1`；B 同一局从 tick 2223 继续至 7391 和 10733，计数保持 2 |
| UI 默认隐藏与切换 | 暂停后紫色 CanvasLayer 面板消失；点击显示恢复原面板，展示计数 1/tick4764；再次暂停默认仍为隐藏。原隐藏子 Control 未被显示的内部节点检查由 headless 覆盖 |
| 相机真实画面变化 | 暂停转交相机初始 position `[5,7,10]`；在原面板区域滚轮后为 `[4.66899,6.60279,9.33799]`。UI 显示时在面板上滚轮仍改变位置至 `[5.00883,7.01059,10.01765]`。前视相机 `[0,1.4,3.53347]`、target `[0,1.4,-2]`；三色地标/角色由透视变为明显的正面图像。模拟 tick 始终4764 |
| 继续运行 | 同一 A world 与计数 1 保留，tick继续，截图恢复原游戏相机的透视画面 |
| 从暂停重新开始 | A 新 world `preview:6be5d3cb-b478-47d1-8646-15cf8714d023`，新 iframe nonce `1f422de3-cd33-428c-8629-415520733aac`，计数0/初始位置；B 保持原 world、计数2/tick10733 |
| 停止并编辑 | 运行 iframe 被移除，只余最初编辑 iframe nonce `25f55352-e2d0-4a07-8b24-22aa4aaa9ec9`；品红 UI、游戏角色和运行脚本生成的三个地标均消失，源稿锚点编辑视图恢复 |
| 最终静态调整刷新复查 | 刷新后运行标签显示“运行中”；暂停默认隐藏UI，只有一个“继续运行”，不显示禁用的变换/历史工具；Chrome记录没有 warn/error |
| 运行不写回源稿 | 末次真实 GET branch 的 head 与上述固定源版本完全相同，记录在 `live-browser/source-after.json` |

截图以 CUA 工具实际图像输出保存在验证会话中；未声称有本地 PNG 文件。Web 验证覆盖滚轮和方向切换的实际图像；CUA 的公开拖动接口只支持默认左键，RMB/MMB 拖动通过匹配源码的真实 Godot `Viewport.push_input` 路径检查，没有声称 Web 手动右键拖动已覆盖。未在本轮重复多人源稿/预制件编辑的完整协作验收（I08 仅检查运行不污染源稿）。未以此次测试宣称正式 Bruce1 已验收；正式内容由主集成者另行实测。

所有测试标签页已关闭；自有 launcher PID 40470 与服务 PID 40471 正常退出，`lsof -nP -iTCP:48923 -sTCP:LISTEN` 确认无监听。测试数据和日志仅留在独立临时目录及 `.local/creation-verification/independent-preview/`，未修改正式数据。
