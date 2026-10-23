# 原生合并与离线工作区接入

2026-10-23。本文件记录此次代码接口和接入点。主集成负责公共路由与原工作台接线；不新增服务端口或第二套源稿。

## 原生分支合并

`NativeMerges.preview(user,p,b,{source_branch_ids:[...]})` 固定有序来源，兼容旧 `source_branch_id`。结果包含 `id`、`algorithm`、`plan_identity`、`target_revision`、`sources`、`steps`、`changes`、`conflicts`、`unresolved_count`、`statistics`。

新增方法和建议路由：

| 路由 | 调用 |
| --- | --- |
| `POST .../merge-preview` | `nativeMerges.preview(user,p,b,input)` |
| `POST .../merge-review` | `nativeMerges.review(user,p,b,{preview_id,resolutions})` |
| `POST .../merge-revert-preview` | `nativeMerges.revertPreview(user,p,b,{revision})` |
| `POST .../merge` | 原 `nativeMerges.merge(...)`，调用方式不变 |

公共 `merge-preview` 的原生判定需要识别 `source_branch_ids`。多来源要求所有固定版本和共同基线均为原生源。单个来源的 legacy 路径保持原实现。

`conflicts` 是真正的局部冲突，不能再从 `changes[].key` 构造决议。每项 `key` 携带三方输入的 fingerprint；`resolutions[key]` 支持 `source`、`target`、`base`，文本还支持 `{choice:'manual',text:'完整片段'}`。已删除显式覆盖与显式默认不同。完整变换（含独立序列化的 position/rotation/scale）是一个冲突组，不拼接双方各轴。

手工决议可能改变后续来源的冲突，`review` 可先重算；`merge` 遇新冲突返回 409 / `native_merge_conflicts` 与 `details.preview`。未使用的旧决议也要求重新核对，不能把旧选择套到新内容上。来源或目标 head 移动返回 `native_merge_stale_plan`。多个最优共同基线返回 `native_merge_ambiguous_base`；此批保守拒绝交叉历史，不随机选基线。

合并只写一个最终多父 revision、一个 receipt 和一个事件，中间步骤仅为候选。结果 `unchanged:true` 表示来源已纳入且无文件变化，此时主集成不必广播新的提交。`result.revert.revision` 可发起补偿预览；不使用旧 `inverse` 文件覆盖，不回退分支 head。补偿保留合并后的其他编辑，同字段变化继续明确冲突。

前端独立模块 `apps/creation-workspace/native-merge-panel.js`：

```js
const nativeMergePanel=createNativeMergePanel({
  request:(route,options)=>api.api(route,options),
  modal,close:closeModal,
  assertCurrent:scope=>{/* 核对当前项目、分支、写权限和编辑模式 */},
  applyBranch:acceptBranch,notify:toast
});
nativeMergePanel.open(context(),project.branches.filter(b=>b.branch_id!==branch.branch_id));
```

这是分支级操作；`assertCurrent` 不必绑定某个资源 tab，合并可能合法删除当前文档。模块复用现有 modal/CSS，没有新页面或后台。

## 原生离线服务

初始化：

```js
import {NativeOffline} from './native-offline.mjs';
this.nativeOffline=new NativeOffline({service:this});
```

在原 `CreationService.request` 已执行 `this.auth(req)` 且完成写入 Origin 检查后：

```js
if(area==='native-workspaces')return this.nativeOffline.request(user,req,res,url);
```

关闭时将 `this.nativeOffline.close()` 加入原等待清理链。不要把该路由暴露在游戏运行 origin。

| 接口 | 作用 |
| --- | --- |
| `POST /native-workspaces` | `{request_id,project_id,branch_id,revision?}` 登记用户工作区 |
| `GET /native-workspaces?project_id=...` | 本人仍有编辑权限的工作区 |
| `GET /native-workspaces/client.mjs` | 下载固定依赖身份的单文件 Node 客户端 |
| `GET /native-workspaces/:id?revision=...` | 固定源文件清单，不推进基线 |
| `GET /native-workspaces/:id/blobs/:hash` | 经版本/上传/运行输入作用域授权读取实际字节 |
| `POST /native-workspaces/:id/uploads` | `{request_id,base_revision,workspace_version,files,source_identity?}` 固定本地快照，返回缺件 |
| `PUT .../uploads/:upload/blobs/:hash` | 原始字节；哈希与大小须匹配该上传清单 |
| `GET .../uploads/:upload` | 查询缺件、当前计划或已提交的固定回执 |
| `POST .../uploads/:upload/prepare` | `{resolutions?,replan?}` 真实原生规范化后调用同一合并内核 |
| `POST .../uploads/:upload/commit` | `{preview_id,resolutions?}` 原子写源版本、工作区新基线和幂等结果 |
| `POST /native-workspaces/:id/advance` | pull 只确认前向远端基线，不提交工作文件 |
| `POST /native-workspaces/:id/runtime` | 固定可信模板、适配器、装配器依赖和工具链身份 |
| `DELETE /native-workspaces/:id` | 撤销后续操作；已下载文件不会被远程删除 |

普通工作区归本人和固定项目/分支管理，不借用 Agent lease。每次实际下载、写入以及异步规范化/合并后的提交重新检查权限。知道某个全局 blob 哈希不构成访问权：不在该工作区授权版本中的文件必须实际上传字节，不能借全局去重读其他项目内容。

## 客户端与断网运行

可在工程内运行 `node tools/native-workspace-cli.mjs help`，或下载便携单文件。支持 `--login` / `--login=账号` 隐藏密码交互；非交互使用 `WORLD_ATELIER_TOKEN`。令牌仅在命令内存，Godot 子进程使用隔离环境，不继承创作令牌。

命令：`checkout`、`status`、`sync`、`pull`、`recover`、`conflicts --export=新目录`、`resolve --resolutions=文件`、`abort`、`prepare-play`、`refresh-runtime`。

目录分离：`project/` 是可提交的原生源，`.wa-workspace/` 保存缓存、基线、journal、冲突原件、可信模板、独立运行副本和历史备份。源文件不硬链接缓存。上传期间新增的落盘修改在服务回执后再三方回放；pull 不直接覆盖本地文件。批量替换先原子保留实际旧文件，再以不覆盖方式安装新文件，中断靠 journal 恢复。已经确认提交的操作不能用 abort 丢弃回执。

checkout 同时缓存 `snapshotProjectRuntime` 的可信原始模板、当前 `adapter.gd`、便携装配器依赖闭包身份和 Godot 可执行程序哈希。`prepare-play` **完全不发网络请求**：从当前落盘源制作隔离候选，以真实 Godot 4.6 导入和 `NativeProjects.indexDirectory` 发现新增场景、原生入口与依赖，再复用 `assembleNativeProject` / `nativeLaunchSettings` 生成 GameRuntime + standalone 工程。`project/` 中的作者配置、目录文件与资产不被运行覆盖回写。

装配输出在 `.wa-workspace/play/`，回执区分原始工作文件、引擎规范化输入和 canonical 文件身份。缺失依赖、工具链/装配器不同或隔离环境不可用时明确失败；保留候选供检查，不退回旧场景清单冒充新游戏。首次支持现有本机 macOS 隔离环境，不声称多平台完成。

`refresh-runtime` 才联网刷新可信模板与工具链身份。模板与 CLI 身份不匹配时需要下载匹配客户端；已打开的运行不会被同步自动替换。独立离线运行使用工作区存档域，源提交不携带 `user://`，也不覆盖共享世界的权威进度。

前端 `createNativeOfflinePanel({...onNativeClient})` 复用同一 modal，提供下载和命令指导；`onNativeClient(scope)` 留给主集成的“本机接续共享世界”入口，避免重复面板。

## 备份保留接入

`tools/native-workspace-retention.mjs` 导出 `nativeWorkspaceRetention(rows)`。请在原 `nativeSourceRetention(rows)` 中调用，将返回的 `objects` 并入原 native-source objects 清单，并把摘要作为 `offline_workspaces` 保留。已有备份工具路径规则支持这些 `native-source/objects/<prefix>/<hash>` 文件。

该扩展保留未提交上传中已经收到/授权的字节、规范化候选、工作区合并计划、canonical 模板/适配器和运行输入。尚未上传的缺件不进入强制保留清单。SQLite 原样保存所有 workspace/upload/advance/runtime 记录；没有新的外部账号、数据库或独立服务。

## 开发自测范围

- `native-fine-merge.test.mjs`：纯 Node / SQLite / 原始文件，覆盖细粒度保留、多来源原子性、冲突、head/权限变化、补偿撤回、错误祖先拒绝。
- `native-offline-roundtrip.test.mjs`：自有 49031、临时数据，实际 HTTP / SQLite / 文件系统；覆盖增量、续改、冲突、断线回执、pull、批量替换恢复、权限、便携客户端。服务规范化使用受控 fixture；不能据此声称服务 Godot 验证。
- 该测试末尾另有真正本机 headless/Dummy/隔离检查：断网后修改入口并新增场景，真实引擎发现、canonical GameRuntime 运行读到本地新值，源目录与中央 head 不变，子进程没有创作令牌。它不是浏览器/GPU或共享接续证据。

独立测试角色仍需在主集成版本验证真实服务原生规范化、原工作台多源交互、备份恢复和新的共享客户端接续。开发自测不替代这些独立结果。
