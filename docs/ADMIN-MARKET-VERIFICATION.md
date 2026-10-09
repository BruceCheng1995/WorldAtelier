# 资源市场后台验证 · 2026-09-10

实现入口：`http://127.0.0.1:48910/admin#/market`。主集成负责产品代码与浏览器检查，独立测试角色负责 `tests/creation/admin-market.test.mjs`。

## 已验证

- 新增后台协议 4 项：唯一管理员、同源/字段/理由/版本/幂等审计；上下架包含固定版本文件和新导入；官方重复安装/更新及重启保留下架；历史记录缺少治理版本时正确使旧请求失效。
- PV、显式文件下载、导入回执计数及重启补记：失败和无匹配回执不计；同事务去重；近 7 个 UTC 自然日热度。计量测试的提交回执使用明确标注的边界 fixture，不是引擎运行证明。
- 真文件系统扫描：共享 hash、保留历史、未引用对象、分配块、丢失原件、不跟随符号链接。该项包含在上述 4 项分组内。
- 6 项既有检索回归、1 项市场备份回归；既有真实市场导入测试 2 项通过（包含实际 headless Godot 导入、独立副本、固定版本、权限与幂等），约 42 秒。
- 10 项现有后台资源比较与权限回归通过。
- 5 项真实 Chrome headless 界面流程：原后台市场页/占用；分页、搜索、筛选、排序；下架后的公开 404；恢复、审计；390px 小屏无页面横向溢出。没有 pageerror，临时服务及数据已清理。

浏览器证据：`.local/creation-verification/admin-market-browser/2026-09-10T10-32-45-228Z/`，含 `report.json`、`desktop.png`、`unlisted-detail.png`、`mobile.png`。
原有真实 Godot 导入证据：`.local/creation-verification/asset-market/aa402952-46e1-4266-b2ab-b5332cd4fe97/`。
后台资源回归：`.local/creation-verification/admin-resource-comparison/2026-09-10T10-31-19-857Z-695b0da5/report.json`。

## 正式加载边界

正式监听 PID 4115，为原工程 `services/preview/server.mjs`，数据路径 `.local/model-preview/creation/creation.sqlite`。只读 SQL 核对 9 游戏、10 分支、142 源版本、53 会话、6 账号、26 市场资源、35 市场版本。

本轮未重启正式服务：仍有 `run-8a5c5cea-bae0-4e56-bcb3-382dc73df94e` 处于 running，属于持续 goal；保留该执行。没有更改正式资源上下架、导入测试素材、发布游戏或删除资产。

已在现有管理员浏览器确认正式 `#/market` 导航可见，旧后端下明确显示“更新已就绪，当前服务尚未加载新版后端”。新增 `admin/session.market_admin_version=1` 作为前后端能力标记；等待加载时不发送不存在的运营接口请求。完整运营功能仅在隔离新版服务得到验证，不能称正式上线完成。

剩余：当前执行安全结束或用户授权中断后，重新核对任务和世界，受控重启原服务，再读取正式市场列表/真实占用和管理员页面。保留源稿、会话、既有版本及计数；不将测试端口交付为产品入口。

## 正式加载完成（2026-09-10 20:51 CST）

用户授权开始后重新核对：原服务 PID 4115 与启动器 PID 4114 均已不存在，48910 没有监听；不是本轮终止了活动服务。按启动锁恢复约定保存旧锁证据、清除失效锁，经 `npm start` 启动新版，当前服务 PID 78200。`health.market_admin_version=1`，原生创作、Agent、自动恢复及世界服务均已启用。

正式管理员已有登录保持有效。在原 Chrome 的 `/admin#/market` 实际刷新后，列表显示 26 个资源（全部上架），搜索/状态筛选/排序入口可见，真实文件系统扫描完成：市场原件及历史约 25.7 MB、游戏原生源对象约 216.1 MB、模型与脚本约 22.6 MB，合计分配块约 264.4 MB；数据卷可用约 946.8 GB。统计起点为 20:50:08，本轮没有通过读取公开详情或导入测试包制造下载/热度。

启动前后 9 游戏、10 分支、142 源版本、53 会话、6 账号、26 市场资源、35 市场版本数量一致。原遗留 run 的恢复核对结果为 `interrupted`，`auto_resume.status=stopped`、`cleanup_status=verified`，不宣称原任务完成。

启动报告与服务日志：`.local/creation-verification/admin-market-live/startup.json`、`service.log`。后台运营更新已正式加载，先前“等待重启”的边界已解除；没有调整正式资源上架状态、删除原件或创建额外产品服务。
