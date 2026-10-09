# Creation 私有备份交接

2026-09-07。新增独立 `tools/backup-creation.mjs` 和 `tests/creation/backup-creation.test.mjs`；没有修改旧 `tools/backup.mjs`、主仓、服务存储或运行世界。无需新依赖；使用 Node 内置 SQLite backup API。不会启动 Godot、Agent 或监听端口。

## 命令

```sh
node tools/backup-creation.mjs create --data=/absolute/creation-data --out=/absolute/new-private-backup --evidence-root=/absolute/private-review-evidence --runtime-root=/absolute/preview-releases
node tools/backup-creation.mjs restore --from=/absolute/backup --out=/absolute/new-private-restored-bundle
node --test tests/creation/backup-creation.test.mjs
```

`--data` 指向包含 `creation.sqlite` 和 `assets/` 的 creation 数据目录。`--evidence-root` 默认 `<data>/review-evidence`；`--runtime-root` 默认 `<data 的父目录>/releases`，若主服务另配 runtimeBuild，应显式传入 `dirname(runtimeBuild)/releases`。`--out` 必须是源存储目录外的新位置，拒绝覆盖已有目录。

也可直接导入 `createCreationBackup({data,out,evidenceRoot,runtimeRoot,onSnapshot?})` 和 `restoreCreationBackup({from,out})`。可选 onSnapshot 是服务端调度/进度回调，在固定数据库已备份且读取完后调用，仅给出完成时间；CLI 不暴露此回调。不要把这两个管理函数直接变成普通用户可访问的公开 HTTP 接口。

## 一致性与保留范围

创建流程以 `new DatabaseSync(source,{readOnly:true})` 打开在线库，用 SQLite backup API 生成一致的完整数据库副本并关闭源连接。之后的记录枚举全部来自这份固定副本，执行 SQLite integrity_check。代码不会停止服务或宣称在线库停写；实际测试在快照完成后的复制阶段继续写入原库，新写入不会混进备份。

当前没有 GC，所以已被数据库引用的不可变文件应继续存在；如果以后启用 GC，宿主须在复制期间持有这些保留根或暂停 GC。无需为当前实现全程暂停场景编辑或游戏。

输出目录及所有子目录为 0700，文件为 0600。备份包含会话、成员权限、登录记录等私有数据，整体保持私有，不提供公共 URL。CLI 标准输出只有成功状态、路径和计数，不打印数据库内容。

完整包布局：

```text
backup.json                         完成标志及逐文件 SHA-256/字节数清单
retention.json                      源版本、资产闭包、review/capture/runtime 保留清单
data/creation.sqlite                固定的完整 creation 数据库
data/assets/<sha256>.glb|gd          全部已登记资产，包括当前未引用的资产
data/review-evidence/<sha256>        数据库引用的全部原始证据字节
runtimes/<build_id>/manifest.json   每个被引用 Web 构建的原始清单
runtimes/<build_id>/<file>          构建清单内的全部导出文件
```

保留所有 persisted creator_revision，检查父版本和已知域版本引用不悬空。资产采用保守闭包：复制所有 creator_asset，另枚举每个源版本的 flat objects、hierarchy nodes、历史 prefab_revisions、模型 override 和 behavior override 中的模型/脚本引用，检查对应资产登记存在。

历史 review、已完成图片、未完成/过期 capture 及其 baseline_ref 都保存在完整 DB 中。备份检查 capture baseline 和已记录 evidence 引用不能缺失，并校验每个 artifact 的 storage_key、SHA-256 和原始长度。字节键由固定 DB 中的合法 digest 推导；不读取记录里的任意路径、URL、Agent 工作区或凭据文件。

运行时保留根来自 world/failure、verification/delivery、inspection、review/capture/evidence 的固定版本字段。引用的归档缺失或损坏时整个备份失败，不把缺失的旧构建排除后标为完成。文件清单哈希必须符合 `build_id = sha256(JSON.stringify({sources,files}))`，四个 Web 入口产物必须存在。

有 `runtime_capabilities.json` 的新构建还校验：恰好一个同名 source；source SHA = files SHA = 实际文件 digest；实际文件长度正确；JSON 语义等于 manifest.capabilities。三个位置只出现部分声明也会拒绝。旧构建没有该文件和顶层字段时按原清单处理。

源内容 manifest 的完整字节语义保存在 SQLite 中。Godot 历史宿主源码并未由旧 builder 归档，因此仅保留 runtime manifest.sources 路径/hash 清单，并显式标为 `source_bytes_included:false`。新能力 JSON 的原始字节属于已复制的 Web files；不捏造其他历史源文件。可执行引擎、当前可变宿主源码、验证工作目录和 Agent 工作区不在此数据备份格式内，恢复数据不等于世界进程已经启动。

## 完成与恢复边界

所有内容写入随机私有 staging 目录。逐文件复制时计算并核对 SHA-256/长度，写入文件和目录均 fsync。只有完整闭包成功后才写 `backup.json status:complete` 并重命名为最终目录；失败清理本次 staging，不产生最终完成目录。

restore 只接受完成清单，拒绝路径逃逸、symlink、重复文件、坏 hash 和长度不符。它从已复制的 DB 再次推导闭包，因此从备份清单里删掉一张仍被 DB 引用的图片也不能通过。只有通过全部核验才写 `restore.json` 并发布新目录。

恢复输出仍为上述 `data/` 与 `runtimes/` 布局，外加 `restore.json`；宿主需把 CreationService.data 指向 `<bundle>/data`，证据目录指向 `<bundle>/data/review-evidence`，并按固定 build 选用 `<bundle>/runtimes/<id>`。新服务仍需匹配 Godot 宿主源码/引擎并实际启动验证。这里不会激活旧 world epoch 或伪造运行 ACK。

## 实际测试

Node v26.3.0；`node --test tests/creation/backup-creation.test.mjs` 15/15 通过（含嵌套故障子测试）。测试有真实 SQLite 在线备份、CLI create/restore、文件复制/权限/hash、删除原 live 目录后读取历史图片和未完成采集基线、私有 session 内容保留、越权读取拒绝、晚于快照的在线写入隔离。

坏 evidence/asset/runtime 字节、缺失资产登记/采集基线/构建、symlink、路径逃逸、删除清单内必需证据、能力顶层虚假声明、能力源/导出 hash 不同均被拒绝，未留下完成目标。另验证旧无 capability 构建恢复。

测试的 world、Agent、validator、Godot Web 产物是标明 FAKE 的边界夹具；字节备份恢复是真实的，不代表实际 Godot/浏览器/Case 13 验收。主集成仍需按独立角色在自己的临时真实数据集执行命令并留证。
