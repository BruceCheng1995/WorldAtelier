# 从零重建记录

日期：2026-09-06。清理验证时间：2026-09-06 23:38（Asia/Shanghai）。

## 工程与会话入口

- 新名称：世界工坊 · World Atelier。
- 唯一工程根目录：`/Users/chengzhi/Projects/WorldAtelier`。
- 在全新目录初始化 Git，默认分支 `main`；没有导入旧应用的代码、资产、存档、依赖或 Git 历史。
- 原会话启动目录 `/Users/chengzhi/Documents/Codex/2026-09-06/new-chat/AGENTS.md` 已改为指向新工程。
- Codex Projects 查询已返回 `WorldAtelier`，路径与新根目录一致，`isGitRepository=true`；项目 ID 为 `b2a3da1f-a431-40d1-9375-07425b539031`。

## 已完成的旧工程清理

用户明确允许废弃并直接删除两套旧工程。删除前核对了绝对路径、真实目录身份、非符号链接，以及新工程不在待删目录之内。

| 旧目录 | 实际结果 |
| --- | --- |
| `/Users/chengzhi/Projects/RuntimeAtelier` | 已递归删除，删除后确认不存在 |
| `/Users/chengzhi/Projects/runtime-atelier` | 已递归删除，删除后确认不存在 |

通过工作目录识别并终止 6 个旧工程进程：25400、30267、30287、30295、30329、30343。终止后未发现以旧根目录或其子目录为工作目录的进程；4815、48765、48766 均无监听服务。

在用户 LaunchAgents 与系统 LaunchDaemons 中对两个旧绝对路径进行检索，未发现对应启动项。本次清理范围是这两套本地工程和相关进程；没有对其他工程或远程托管资源执行删除。

## 保留的第三方研究资料

此前用户要求下载的官方 Godot 4.6 完整源码移至 [research/godot/4.6-stable](../research/godot/4.6-stable/README.md)。它是第三方研究资料，不作为旧应用迁移。

- 固定提交：`89cea143987d564363e15d207438530651d943ac`。
- 原归档：65,700,229 bytes。
- 本次重新计算 SHA-256：`4387f22b1ef3ad9efd34ba0cd8075b0c3f192ddb3fc2ad7e400c9c44145900ad`，与原下载记录一致。
- 本次逐一核对原清单中 30 个源码文件的 SHA-256，全部匹配；源码许可证保留。
- 解压源码与归档已排除在新 Git 仓库之外；研究说明及来源清单可随仓库维护。

本地机器验证记录保存在 `.local/legacy-service-stop.json` 与 `.local/bootstrap-verification.json`，不进入 Git。

## 新工程当前可交付内容

已建立工程入口、总体架构、协议设计、开发上下文、Godot 源码研究说明，以及各模块的职责占位文件。

中央服务、数据库、任务调度、客户端启动器、网页游戏、Godot 世界、分支同步和热更新均尚未实现。没有启动新的游戏服务或部署远程系统，也没有将旧工程的通过记录计为新工程测试结果。
