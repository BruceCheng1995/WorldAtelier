# A 纯 hierarchy runtime pack 交付

2026-09-07。在 `/Users/chengzhi/.codex/worktrees/3d7f/WorldAtelier`、`codex/hierarchy-prefabs` 完成本批纯运行包；主目录、实际世界、公共 service/UI 和 Godot 文件均未修改。契约先行提交 `69e7cfb` 已由 root 接受。

## 集成文件

| 文件 | 用途 |
| --- | --- |
| `services/creation/hierarchy-runtime.mjs` | 同步纯 `packHierarchyRuntime`，格式 `creation-runtime-hierarchy-2` |
| `tests/creation/hierarchy-runtime.test.mjs` | 12 项独立 Node 测试，不监听端口，不使用数据库或 runtime |
| `tests/fixtures/hierarchy-runtime-source.mjs` | 无外部资产的两级嵌套数学夹具生成源 |
| `tests/fixtures/hierarchy-runtime-mounts.json` | 固定可消费 JSON，10 objects / 4 mounts，完整 address / 矩阵 / 版本 / 挂载 |
| `docs/handoffs/hierarchy-runtime-CONTRACT.md` | 精确字段、ID/hash 算法、可运行子集、传输边界 |

模块仅依赖 A 已交付的 `hierarchy.mjs`、`packages/scene/transform.mjs` 和未改的 `schema.mjs`，无 store/service/运行进程依赖。本批没有改源层级规范或既有实现。root 只合入本批文件和已选定的 A 源模块，禁止整体导入旧快照基线 `6002f15`。

```js
import {packHierarchyRuntime} from './hierarchy-runtime.mjs';
const pack = packHierarchyRuntime(fixedManifest, {
  project_id, branch_id, resource_id, source_revision: fixedRevision,
  assetAllowed: (hash, extension) => canReadProjectAsset(hash, extension),
});
// root 组装 scene.hierarchy_pack=pack；独立 scene.asset_access 提供授权地址。
```

调用者必须先授权并解析固定 revision；本模块不查询 moving head、不验证用户权限、不读取资产字节。assetAllowed 必须返回同步 boolean true，其他值均拒绝访问。源文档及固定定义哈希完整验证；资产访问只检查有效展开及覆盖后实际使用的 GLB/GDScript。

## 本批测试证据

实际执行 `node --test tests/creation/hierarchy-runtime.test.mjs`：**12 / 12 通过，无跳过**。

- 独立数值断言证明 parent → mount → prefab root → 嵌套实例变换均保留；以 `assembly_order + local_transform` 重建每个世界矩阵，与包内结果逐项相符。
- 完整保留 resolver 字段，未覆盖定义 node version 与有效 node/object version 分开；源对象未变。
- 固定实例保持旧定义；升级、祖先移动、覆盖、source revision 改变不改变同实例路径下 runtime ID；另一实例不受覆盖影响。
- 旧 flat 400 对象迁移后的原 ID 全部保留，新增根独立计数。
- 有效模型和脚本闭包排除被覆盖旧引用及无关资源；拒绝无许可/异步许可、非 canonical URL、错配固定定义哈希。
- 对象/实例 map 插入顺序变化不影响 canonical pack；JSON round-trip 与 pack_hash 校验一致。
- 1000 总对象+挂载接受，1001 整体拒绝；世界边界覆盖对象、被 prefab 根位移抵消的 mount 原点和组件 offset。
- 视觉剪切和完整矩阵保留；sphere 非均匀/剪切、box 物理剪切明确拒绝；正交非均匀 box、统一缩放 sphere 与完整矩阵 trimesh 可进入候选。
- 拒绝嵌套 ID 与顶层原 ID 碰撞；Ref kind 为 object/mount 保持独立命名空间；拒绝非 JSON 输入及未知 Area shape。
- 已提交 JSON fixture 与当前模块输出严格相等；fixture 无资产、无脚本，也无模拟运行回执。

fixture pack_hash：`df82718c8001edc8065b2dcc92a504b45c756d0beb86b241f5fb0bb83a8be0e0`。

冻结基线 `/Users/chengzhi/Projects/WorldAtelier/.local/integration-baseline/creation-core-680cd7a5/manifest.json`：52 个文件逐一比对相对路径、字节数与 SHA-256，全部匹配；仅只读参照，未覆盖本树公共实现。

## 验证边界与后续责任

这批证明纯派生语义、拒绝规则和 JSON 契约，不代表 Godot runtime 已支持、真实 GLB/GDScript 已校验、双 Web/真实主权 ACK/重启恢复已通过。root 已接受 `scene.hierarchy_pack` + 独立 `scene.asset_access`，并保留 `scene.objects` 作只读 UI 元数据。Godot worker 接入候选加载、物理和观察时须以 canonical pack 为准。现有实际世界不在本批迁移范围；触发接触 checkpoint 修复由 Godot worker 按主集成安排单独处理。仍由原唯一独立测试角色完成固定集成后的运行验收，本批不另建验收负责人或开启 Case 19/20。
