# 真实目标续修与审核协议专项

`agent-review-live.test.mjs` 会启动真实 Codex turn，必须获得主集成对目标服务的明确授权后手动运行。它只使用已运行的 48921 服务，创建专用账号/项目/session/world；不启动或停止服务，不访问其他项目，不操作浏览器，不预写业务脚本。

```sh
WORLD_ATELIER_RUN_REAL_AGENT_REVIEW=1 \
WORLD_ATELIER_CREATION_ORIGIN=http://127.0.0.1:48921 \
WORLD_ATELIER_CREATION_CODE_ROOT=/absolute/path/to/authorized/server-copy \
WORLD_ATELIER_EXPECT_RUNTIME_BUILD=actual-64-hex-build-id \
node --test tests/creation/agent-review-live.test.mjs
```

第一条真实 turn 制作受控坏脚本并调用真实 Godot 验证；审核要求 revise 后，第二条真实 turn 在同一目标修复、验证、实际发布。驱动再发送一次真实 interact，读回服务端留存的两份权威快照字节，核对哈希与固定身份后提交体验条件和 pass。没有真实证据、技术失败、过时 run/version、异参重放、无读取权限的请求必须被拒绝。

每次运行生成 `.local/creation-verification/agent-review/<timestamp>/`：报告、脱敏完整执行事件、HTTP/WS 原件、实际下载的 runtime_trace 和当时执行的 driver。登录凭据仅在 0700 目录的 `access.private.json`（0600）。不得提交凭据或原始数据到 Git。

如果第一条 turn 已启动而驱动等待超时，保留原失败。不得重发目标。仅在原报告没有开始 RB03 且后台源码哈希仍完全相同时，可设置 `WORLD_ATELIER_AGENT_REVIEW_RESUME_REPORT=/absolute/path/to/original/report.json` 后运行相同命令：重新登录原账号，继续观察原 session/run，不创建新目标。恢复连接使用继续旧 live 的协议入口；不能把它当当前源稿已应用。实际审批或输入请求保持待处理，不伪造回复。

2026-09-07 独立结果：[5 / 5 报告与边界](../../.local/creation-verification/agent-review/2026-09-07T10-26-04-392Z-1b21445e/SUMMARY.md)。包含真实受控编译失败、续修和发布；前序环境失败及驱动超时另存。本批没有浏览器/GPU、Case13 UI、导出原生应用、服务重启、备份恢复或新取消/审批验收声明。
