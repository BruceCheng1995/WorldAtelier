# B：私有验收证据采集模块

日期：2026-09-07。交付位置为 B 隔离 worktree；主集成尚需接入路由、UI、保留策略及备份。没有启动或改动主服务、真实世界、Agent、`service.mjs`、`worlds.mjs`、`store.mjs` 或 UI。不要合并快照基线 `f646332`。

## 文件与依赖

- 新增 `services/creation/review-capture.mjs`、`tests/creation/review-capture.test.mjs`。
- `goal-review.mjs` 只改两处：允许 `authenticated_client_observation`；带 `pin.review_id` 的证据必须匹配本轮，该新 kind 必须提供它。对应新增一个 ledger 边界测试。
- 旧 `goal-review-evidence.mjs` 未修改。生产接入使用新实例的 `resolveEvidence`，不要继续使用旧示例 resolver 处理新采集。
- 没有对 UI 文件写入。主 UI 可将新 kind 显示为“用户提交的图片（未验证渲染）”，将 `runtime_trace` 显示为“服务端运行快照（不代表画面）”。

## 服务端连接

```js
const captures = new CreationReviewCapture({
  store: creationStore,
  worlds: creationWorlds,
  directory: privateEvidenceDirectory,
});
const reviews = new CreationGoalReview({
  store: creationStore,
  resolveEvidence: captures.resolveEvidence,
  // 保留主集成的 publicTarget、hasPendingInput。
});
```

`worlds` 必须是当前服务实际持有的 `CreationWorlds` 实例。模块从它的 `worlds` Map 查找并核对同一个已激活实例，检查 `ready/activated/failed/failure/ws.readyState`、scope、build、epoch 以及当前快照。它不会从 `creator_world` 持久化行、请求 JSON、任意文件或 URL 构造“在线世界”。模块本身不启动 Godot，也不独立鉴定任意注入对象是不是 Godot；这个服务端依赖必须由宿主可信接线。

入口是同步方法，内部自带 SQLite transaction，不要包在另一个 store transaction 中。权限检查先于幂等回执重放。路由仍由宿主认证真实 user，并按既有同源规则和请求体限额处理。

## 采集协议

`captureRuntimeTrace(user, input)` 和 `beginClientObservation(user, input)` 共用开始参数：

```js
{
  request_id,       // 每个操作的新 UUID；超时重试复用，不跨操作复用。
  goal_id,
  review_id,
  expected_version,
  world_id,
  epoch,
  sequence,        // 可省略，取实际当前 snapshot.sequence。
}
```

其他字段会被拒绝，包括客户端自带的 snapshot、pin、kind、path、URL。指定 sequence 必须仍在该实例的当前快照或 history Map 内，并且不得早于本轮 delivery.applied_sequence，也不得晚于当前序号。当前及选定历史快照都须属于同 world、epoch、review revision，且无 runtime fault。应用回执必须未改写，并属于此 review 固定的资源、构建和运行。

两种开始操作都会立即将选定的真实服务端快照序列化为 JSON trace，并先持久保存其不可变字节，再提交数据库记录。它是对已接收 Godot 快照的服务端序列化，不宣称保留了原始 WebSocket 包的字节排列。返回：

```js
{
  capture_id,
  pin,
  baseline_ref,   // 已保留的 runtime_trace artifact.id。
  artifact,       // 该 trace 的私有描述，不含本地路径或 storage_key。
  expires_at,
  replayed,       // 只在重放时为 true。
}
```

固定 pin 包含 project、branch、session、goal、run、review、review_version、goal_revision、revision、runtime_build、resource、world、epoch、sequence、state_hash、delivery_id 和完整 target_refs。target_refs 只固定服务端已有的地址，不在这里发明 A 的资源地址协议。

客户端图片使用第二种开始操作，然后调用：

```js
captures.submitClientObservation(user, capture_id, {
  bytes: rawUint8Array,
  mime_type: 'image/png', // 或 image/jpeg。
});
// => {artifact, replayed?}
```

仅 PNG/JPEG 文件签名、原始大小 1 字节至 8 MiB；不接受 SVG、路径、URL、base64 字符串或任意元数据。宿主可从 HTTP raw body 取得 bytes，客户端不设置 submitted_by。只允许原采集发起人补交；会话共享和 reviewer 授权、项目写权限、同 goal/run/review/source/build/world/epoch 以及序号不倒退均再次核验。默认开始后 120 秒过期。正常世界序号前进、原历史被淘汰、同轮添加另一证据均不改写已固定的边界。

旧轮次未完成的上传在新轮次开始后返回 409。已完成上传的相同字节重试返回原历史 artifact，不改挂当前目标；不同字节不能替换它。开始请求的重试同样返回原绑定，UI 应使用返回的 pin，而不能用当前选中目标覆盖。若 POST 路由包含 goalId，宿主还应检查路径与固定 pin 的 goal_id 一致。

每张图片单独成为 `kind: authenticated_client_observation`，其 `pin.provenance` 为 `authenticated_user_upload`，`render_verified: false`，保留真实 authenticated user 的 submitted_by。这证明谁提交了哪些不可变字节，以及开始时固定的服务器世界边界；不证明图片确在该世界或时刻由浏览器绘制，也不把客户端声明提升为可信 GPU 证明。`runtime_trace` 的 provenance 为 `server_runtime_snapshot`，同样 `render_verified: false`。

采集不会自动调用 addEvidence 或 decide。UI 选择并描述实际检查后，将本轮 artifact.id 放入 `addEvidence.artifact_refs`。resolver 强制每个新 artifact 的全套私有范围和 exact review_id 匹配，并重新读取校验字节；ledger 在 decide 时再次调用它。过去的 artifact 仍可按历史权限读取。

## 私有读取

`readArtifact(user, artifactRef)` 返回 `{artifact, bytes}`。当前会话主人可读；共享会话的当前项目成员可读。写入只允许主人或当前显式 reviewer，且必须有项目编辑权限。撤销共享、成员身份或 reviewer 授权会影响后续相应操作，包括重试。

原始证据目录必须在公开静态目录和项目 GLB/GDScript 资产目录之外。默认新目录 0700、新文件 0600；传入的目录和祖先路径由服务器管理，不允许客户端控制。文件名只能是 SHA-256；读操作拒绝 symlink、缺失、非普通文件、过大文件及哈希不符。发布对象使用临时文件 fsync + 不覆盖的 hardlink + 目录 fsync，再提交数据库引用。数据库失败可能遗留无引用对象，不会留下可读的半成品记录；没有自动删除逻辑。

GET artifact 路由每次调用权限读取，返回精确 mime_type 和大小，设置 `X-Content-Type-Options: nosniff`、`Content-Disposition: attachment`、`Cache-Control: private, no-store`。不要添加公开免认证文件链接。图片签名检查不是完整解码或内容净化，宿主不得把内容以内联 HTML 解释。

## 保留和备份

`retentionRoots()` 为服务端 GC/备份提供源 revision、run input revision、runtime build、所有 review 轮次（包括没有采集的）、goal/run/session/delivery/verification、快照边界及 artifact 字节键。源 revision 根还需由宿主遍历资产和依赖闭包。未完成/过期采集与历史轮次继续保留，没有 GC 或隐式过期删除。

`enumerateBackupArtifacts()` 是同步生成器，每项为 `{relative_path, storage_key, sha256, byte_length, bytes}`；relative_path 固定 `review-evidence/<sha256>`。枚举时实际读取并验证字节，损坏就失败。此方法和 retentionRoots 都是服务器管理接口，不能直接暴露给普通 HTTP 客户端。

备份过程须暂停采集写入，生成一致的完整 `creation.sqlite` 备份，再枚举复制上述字节并按清单校验。完整 DB 同时保留权限、会话、goal/run/review、capture、receipt 和 artifact 元数据；只复制证据文件不构成可恢复备份。恢复使用新 DB 和新私有证据目录；可读历史 trace 不等于新世界已运行。现有 `tools/backup.mjs` 尚未集成这部分。

## 本次验证

Node v26.3.0；执行：

```sh
node --test tests/creation/review-capture.test.mjs tests/creation/goal-review.test.mjs
```

37/37 通过：15 个新采集/存储测试和 22 个 ledger 测试。另有 `node --check services/creation/review-capture.mjs`、`git diff --check` 通过。新测试未开监听端口，没有碰主服务或真实世界。

实际验证了 SQLite transaction、权限、文件字节和 SHA-256、历史/序号边界拒绝、重复请求、旧图晚到、新轮次拒挂、同轮正常推进、损坏/缺失/symlink、进程内重开数据库，以及通过 SQLite backup API 备份到新路径、删除原证据目录后从新路径读取历史图片与 trace。world/socket/snapshot/Agent run/validator/delivery 全部是标明 FAKE 的替身；这些测试不证明实际 Godot、浏览器截图、路由认证接线或 Case 13 已通过。

主集成后仍需以独立测试世界验证真实 Godot snapshot/history 与 source/build 匹配、浏览器原始上传、切目标或轮次后旧图晚到的 UI 行为、权限下载、主备份恢复路径。独立验收角色由主集成保持，此处没有新增测试代理。
