# 预制件头图：独立局域网浏览器验证

2026-09-08。由独立测试角色执行；实现文件由主集成角色修改。测试只涉及缩略图显示和缓存，不代表玩法验收。

执行命令：`node tests/creation/prefab-thumbnail-lan-browser.mjs`。

最新稳定源码报告：[report.json](../.local/creation-verification/prefab-thumbnail-lan/2026-09-08T04-30-38-962Z/report.json)。运行时为 Godot 4.6 stable / workspace runtime 0.3.0，Chrome 152.0.7977.76；通过实际网卡地址 `http://10.222.132.235:55109` 访问，浏览器 `isSecureContext=false`。账号、模板游戏、源稿事务、数据库、端口和浏览器上下文均隔离，结束后已关闭测试服务并删除临时数据。

| 实际检查 | 结果 |
| --- | --- |
| 逐张滚动触发真实 Godot 渲染 | 6/6 卡片 ready，持久缓存 6 张 JPEG；信标图为 384×288、431 个量化颜色、4652 个明亮像素 |
| 刷新后重开全部预制件 | 6/6 图片恢复；缩略图 Engine 请求为 0；信标仍有 1 次授权源稿读取 |
| 通过真实 `patch_object` 事务调整信标 | 源版本、预制件版本和缓存 key 均改变；启动缩略图渲染器，生成与旧图不同的 JPEG |
| 浏览器脚本异常及源码稳定性 | `page_errors=[]`；HTML、bridge、workspace 三个源码文件前后哈希一致 |

独立检查者已查看[冷渲染截图](../.local/creation-verification/prefab-thumbnail-lan/2026-09-08T04-30-38-962Z/beacon-cold.png)和[修改后截图](../.local/creation-verification/prefab-thumbnail-lan/2026-09-08T04-30-38-962Z/beacon-changed.png)，模型主体可辨认，没有错误占位。

正式 48910 原入口也做了只读核对：修复前专用 renderer 在 LAN HTTP 启动时返回 `Cannot read properties of undefined (reading 'addModule')`；修复后同一运行时 build 返回真实 `ready`，没有页面脚本异常。见[正式入口记录](../.local/creation-verification/prefab-thumbnail-live/report.json)。未登录正式账号、修改正式源稿或停止正式服务。

初始测试只等待信标，刷新时其他未缓存卡片启动 Engine，因此该轮全页零 Engine 断言不成立；后续改为等待并缓存全部六卡。另一次全用例通过的记录检测到并行任务改动 `workspace.js`，原[哈希漂移记录](../.local/creation-verification/prefab-thumbnail-lan/2026-09-08T04-29-20-252Z/report.json)保留，以上最新报告已重新执行并确认无漂移。

范围限制：浏览器运行在本机并访问实际网卡 IP，没有使用第二台物理电脑。本报告不宣称已完成跨机器网络或 GPU 兼容性验证。
