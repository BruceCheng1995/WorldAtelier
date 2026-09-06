# 世界工坊 · World Atelier

从中央服务器选择主干或分支，取得匹配的客户端与世界状态，进入游戏；在网页、Godot 编辑器或离线工作区制作内容，再提交回对应分支。

**当前只有架构设计和新工程骨架，尚无可启动的服务或游戏。** 这是用户要求的从头重建，不是旧项目改名或迁移。

先阅读 [总体架构](docs/ARCHITECTURE.md) 和 [协议设计](docs/PROTOCOL.md)。

```text
apps/
  portal/                 网页分支入口、协作编辑、下载和实际 Web 游玩
  desktop-launcher/       客户端版本缓存、校验、启动与会话跳转
services/
  control-plane/          身份、工程、分支、发布、存储元数据与任务
  world-orchestrator/     权威世界进程的启动、租约、检查点和调度
runtimes/
  godot/                  同一 Godot 工程的客户端、权威端与共享玩法
workers/                  Codex、资产构建、目标导出和独立测试执行器
packages/
  contracts/              各端共用的数据与消息协议
  runtime-sdk/            模块、状态、事件、热更新和同步接口
content/                  示例世界与模块的创作源文件
docs/                     设计、决定与后续验收
research/godot/4.6-stable/ 官方引擎研究资料，源码及压缩包不进入 Git
.local/                   本地验证记录，以及后续服务数据、缓存和测试世界
```

起步实现采用一个本地中央 API 服务和独立运行/构建进程即可，不把“中央服务”限定成一台机器或一个进程，也不先拆成大量微服务。语言与部署供应商尚未锁定；可优先评估 Node/TypeScript 控制服务配合 Godot 权威运行进程。

客户端切换的验收是版本匹配、状态接续和控制权正确；普通兼容内容仍争取在当前游戏内热更新。网页入口必须实际执行游戏玩法，只有 Three.js 模型预览不算完成。
