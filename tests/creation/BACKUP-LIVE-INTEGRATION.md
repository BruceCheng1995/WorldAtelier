# 在线实际证据备份 / 存储恢复

`backup-live-integration.test.mjs` 使用已授权的在线 48921 数据，只创建新的 0700 备份和恢复目录，不开服务、authority、Agent，不发送玩法输入。需明确授权后执行；不要作为自动 CI 测试运行。

```sh
WORLD_ATELIER_RUN_LIVE_BACKUP=1 \
WORLD_ATELIER_BACKUP_SOURCE_DATA=/Users/chengzhi/Projects/WorldAtelier/.local/creation-verification/hierarchy-world/ui-fixture-c08affc6/creation \
WORLD_ATELIER_BACKUP_RUNTIME_ROOT=/Users/chengzhi/Projects/WorldAtelier/.local/creation-verification/integration-ui/code-1dde/.local/model-preview/releases \
WORLD_ATELIER_BACKUP_AGENT_REPORT=/absolute/path/to/completed/agent-review/report.json \
node --test tests/creation/backup-live-integration.test.mjs
```

输入须为独立真实 B 5 阶段报告，并保留同目录 `access.private.json`、`own-records-readonly.json` 和 `evidence-sha256.json`。这些私有文件不得入 Git。源数据路径有硬门禁；调整环境需重新获得主集成授权。

BI01 调用实际 `tools/backup-creation.mjs` 的 create API；在其快照回调中只读观察原世界继续推进，并核对固定副本不变。BI02 实际 CLI restore，并核对所有文件 SHA/长度/字节和权限。BI03 核对真实 trace、验证 JSON、全部引用运行构建。BI04 使用实际产品读取/权限方法与只读 SQLite 验证历史和私有证据，绝不伪造世界。

若 BI01–03 已成功但 BI04 测试假设需修正，可设置 `WORLD_ATELIER_BACKUP_RESUME_REPORT=/absolute/path/to/original/backup/report.json`：只对原已恢复副本窄测 BI04，不重复备份，不覆盖原报告。源码哈希必须一致。在线界面可能继续新开 review；按原 ID 与固定快照核对，不能把旧报告总数当作当前数据上限。

[2026-09-07 实际证据索引](../../.local/creation-verification/backup-integration/2026-09-07T10-43-12-431Z-c61f15a5/SUMMARY.md)：首次 3 项通过，修正测试假设后同恢复副本第 4 项通过；两次测试断言失败原件均保留。24 个清单文件一致。备份格式没有原始 validator 工作目录、Godot 引擎/宿主源码和 Agent 工作区；不据此声称已恢复运行。
