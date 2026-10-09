# 世界关服与显式恢复补丁

本补丁已按固定补丁合入主工程，并在 48910 工作台加载。单元测试的 15 项 FAKE 边界验证与其后的独立真实 Godot 验证分别记录，不混为同一验收。

## 行为

- `CreationService.close()` 同步 `worlds.beginClose()`，再关闭实时连接，并行等待 worlds 与 Agent 关闭，最后关闭数据库。重复信号只启动一次关闭。
- Godot authority 启动使用独立进程组；保留自己的 ChildProcess 与独立 worker 集合，不 unref、不扫描或杀无归属进程。关闭发送 shutdown，保存精确 world/epoch/revision 的 ACK 快照。失败时仅向本服务自己的 child 发送 TERM/KILL，实际 child close 才完成回收；无法确认退出则 reject。
- `beginClose()` 固定健康已激活世界的最终检查点保存资格。随后 shutdown ACK 和 WS close 任一先发生，都不会把正常关服写为故障，也不会丢掉有效最终 ACK 帧。
- `world_join` 遇到任何持久化 failure 均 422，不自动重新验证或启动坏内容。源 head 移动也不隐式恢复。
- 显式 `/publish` 真实验证 passed 后进入原 `preparing` 锁，恢复固定 revision、runtime_build_id、state_hash；核对当前 branch head、权限与租约 `input.guard`。启动前、init 前、真实 init ACK 后及返回前复查；失败不能记录 delivery。
- 原 validation 窗口 auto join 保守返回 422；恢复 start/ACK 的 preparing 窗口为 409；成功后普通 join 可接入。并发自动 join 不能借用显式恢复 promise。
- 基础设施与明确启动前提拒绝允许显式重新验证后重试相同 source/build。行为或未知故障仍禁止同 source+build 重试；修复 source 或升级 runtime 后仍须真实验证。
- 新运行时已构建、旧权威已停止时，显式 publish 可恢复同源码与检查点。仍在运行的旧 runtime 升级保持现有 409；本补丁不新增在线客户端升级协议。

## 持久化字段

`creator_world` 保留原字段，新增 `failure_history: string[]`。`failure` 是当前停止原因；真实 init ACK 成功后消除当前 failure，保留全部历史引用。未通过启动 ACK 的候选不得将旧检查点冒记为候选 revision/build/epoch。

每次故障另写不可变 `creator_world_failure`：

- `id, world_id, epoch, revision, runtime_build_id, snapshot_hash`
- `kind: infrastructure | precondition | behavior | unknown`
- `message, at`
- 可选 `runtime_fault`：真实 worker fault 包。
- 可选 `process_exit: {code,signal}`：实际 child close。

现存 legacy 故障在恢复时归档。只有明确旧消息“Godot 权威连接中断”或“Godot 权威心跳超时”可追认为 infrastructure；不以 `runtime_fault:{}` 推定安全。真实 SIGINT/SIGTERM/SIGKILL 的 child close 归 infrastructure；无信号退出、worker/init 错误保守 unknown，实际 fault 包归 behavior。仅内部 assertStart 的明确 403/409/503 拒绝标记 precondition；任意 worker 错误的 status 不能获得此分类。

## 验证与限制

`node --test tests/creation/world-recovery-boundaries.test.mjs`：15/15 FAKE 控制边界测试通过，含锁隔离、版本/权限/检查点约束、晚 ACK、故障历史、关闭次序、信号分类、真实 close 之前不把 kill 当成功。三处产品文件 `node --check` 通过。

独立真实验证为 5/5，见 `.local/creation-verification/world-recovery/2026-09-07T08-21-13-970Z-7671c747/report.json`，固定构建 `680cd7a5a2b5e07654e24e0840e6279ba0478301d6848db0d52c22545c04bb9d`。实际向自有 Node 进程组发送 SIGINT，确认 Godot 使用另一进程组、真实 shutdown ACK 最终帧写入并回收；authority SIGKILL 后自动 join 422，显式真实验证恢复；迟发真实 VM fault 后重复 join 与重启均不能偷偷重试，修复内容后显式恢复并保留失败历史。测试含 3 个 Node 和 4 个 authority 进程，均已回收。断电/主进程硬 kill 仍最多恢复最后持久化帧，本补丁没有宣称零数据损失或跨主机分布式 fencing。关闭任一子系统失败会让 close reject，不能声称优雅关闭成功。
