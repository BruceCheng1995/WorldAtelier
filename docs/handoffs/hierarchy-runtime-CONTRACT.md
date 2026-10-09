# Hierarchy runtime pack v2 — 固定消费契约

2026-09-07。这是 **派生运行包契约**，不修改 `creation-hierarchy-2` 源规范，不表示现有 runtime 已支持。冻结参考基线 `680cd7a5a2b5e07654e24e0840e6279ba0478301d6848db0d52c22545c04bb9d` 的 52 个源码文件已逐一验证 SHA-256 和字节数。

生产入口：`packHierarchyRuntime(manifest, {project_id, branch_id, resource_id, source_revision, assetAllowed})`，位于 `services/creation/hierarchy-runtime.mjs`。全部作用域和固定 `source_revision` 必填；`assetAllowed(hash, extension)` 必须显式提供。同步纯函数，无 IO、无 source 写入、无状态迁移。失败整体抛出，不返回部分包。

## 顶层 JSON（所有字段必有）

```ts
type Ref = {kind: 'object' | 'mount', id: string};
type TRS = {position: number[3], rotation: number[4], scale: number[3]};
type Address = {project_id: string, branch_id: string, resource_id: string,
  instance_path: string[], definition_node_id: string};
type Pack = {
  schema: 2,
  format: 'creation-runtime-hierarchy-2',
  source_schema: 'creation-hierarchy-2',
  project_id: string, branch_id: string, resource_id: string,
  source_revision: string, source_document_version: string,
  root: Ref,
  required_capabilities: ['hierarchy-runtime-2', 'explicit-instance-mounts',
    'quaternion-local-trs', 'world-matrix-observation', 'fixed-asset-closure'],
  limits: {max_expanded_nodes: 1000, max_world_coordinate: 10000,
    physics_policy: 'orthogonal-box-uniform-sphere-v1'},
  objects: RuntimeObject[], mounts: RuntimeMount[], assembly_order: Ref[],
  prefab_closure: {resource_id: string, revision: string}[],
  asset_closure: {hash: string, extension: 'glb' | 'gd', url: string}[],
  pack_hash: string
};
```

矩阵均为 16 项 column-major affine、右手系、Y-up、米；quaternion 是 `[x,y,z,w]`。`world_matrix = parent_world_matrix * matrix(local_transform)`，不经 Euler 往返、剪切分解或正交化。`world_transform` 为 resolver 给出的 TRS 或 `null`；运行组装必须用局部 TRS 与显式父节点，矩阵供验证、物理及观察使用。

`objects` 和 `mounts` 各按 ID 的 Unicode 码元顺序升序。`assembly_order` 是确定的父先于子 Ref 列表，**组装必须使用它和 `parent`**。它包含全部 objects 和 mounts，一次且仅一次。不存在可丢弃的挂载节点。

## 对象

```ts
type RuntimeObject = {
  id: string, parent: Ref | null,
  address: Address, key: string, parent_key: string | null,
  node: SourceEffectiveNode,
  definition_resource_id: string, definition_revision: string,
  definition_node_version: string,
  local_transform: TRS, parent_world_matrix: number[16],
  world_matrix: number[16], world_transform: TRS | null,
  world_position: number[3], object_version: string, ancestry_hash: string
};
```

除 `id`、`parent`、`definition_node_version` 外，完整保留 `resolveScene` 的每一个字段。`node` 包含源节点原 ID、局部 `parent_id`、`kind/name/color/solid/model_hash/model_url/components/transform/version` 及源允许的其他元数据；它不是旧 flat runtime row。模型及行为内容读取 `object.node`，运行身份读取 `object.id`。`node.version` 是有效覆盖后的节点版本；`definition_node_version` 是未覆盖的定义节点版本；`object_version` 还包含固定实例链依赖；`ancestry_hash` 保留 resolver 原值。

`parent_key` 与 `node.parent_id` 只保留源含义，不能用于运行组装：prefab 根的真实运行父节点是 mount。

ID 固定算法（SHA-256 使用 `schema.mjs` 的 canonical `hash`）：

- 顶层 `instance_path=[]`：`id = definition_node_id`，保留旧 flat 迁移对象状态键。
- 嵌套：`id = 'node-' + hash([instance_path, definition_node_id])`，使用完整 64 位十六进制摘要。不含 revision、transform、parent_id 或版本。
- ID 在包内唯一；与用户顶层 ID 碰撞则 `runtime_id_collision` 整体拒绝，不自动改名。不同包用完整 address 作用域区分。节点跨实例路径移动会改变 ID。

Prefab 定义根仍是 object：其 `parent={kind:'mount',id:…}`。普通节点父亲是同实例路径下的定义父节点。场景根 `parent=null`。

## 显式实例挂载

```ts
type RuntimeMount = {
  id: string, key: string, parent: {kind:'object', id:string},
  address: {project_id:string, branch_id:string, resource_id:string,
    instance_path:string[]},
  instance_id: string, owner_resource_id: string, owner_revision: string,
  prefab_id: string, prefab_revision: string, instance_version: string,
  local_transform: TRS, parent_world_matrix: number[16],
  world_matrix: number[16], world_position: number[3], ancestry_hash: string
};
```

路径包括本次挂载 ID，`id='mount-'+hash(instance_path)`，`key=JSON.stringify(instance_path)`，Ref 的 kind 提供独立命名空间。`owner_*` 指声明该 instance 的固定源定义；`prefab_*` 指加载的固定定义。挂载 `local_transform` 就是源 instance.transform。`parent_world_matrix` 是声明 instance 的父 object 世界矩阵；`world_matrix` 是父 object 世界矩阵乘挂载局部矩阵。`ancestry_hash` 等于该 mount 下 prefab 根对象的 resolver `ancestry_hash`，覆盖完整外层祖先和本次挂载。挂载本身不承载行为状态。

## 固定依赖、哈希与传输

`prefab_closure` 仅包含本包可达的固定 prefab `(resource_id, revision)`，去重后按 resource_id/revision 排序。覆盖不会替换挂载拓扑。未升级的实例继续加载旧 revision，不跟随资源目录最新版本。

`asset_closure` 只包含展开及覆盖后实际使用的 GLB 和 API 1 GDScript，按 extension/hash 排序并去重。`url` 恒为 `/preview-assets/<hash>.<extension>`，无 token、cap、查询参数、绝对主机。有效 node 中的 model/script URL 与 closure 一致。模块检查规范引用和显式资产许可；资产字节真实性及 GDScript/GLB 自包含约束由主集成的资产导入验证和 Godot 候选检查继续负责，纯 pack 不伪称读取过资产。

`pack_hash=hash(pack 去掉 pack_hash)`，包括作用域、source revision、全部有效节点、挂载、依赖、能力要求和限制。没有生成时间、运行 epoch、玩家状态或观测数据。返回值可 JSON round-trip，重复输入产生相同包。不得给 canonical pack 的 URL 添加凭据。服务使用独立的传输 envelope/map 提供下载授权并保留 canonical pack/hash；Godot 验证字节 hash 后装配。

主集成已确认 transport：`scene.hierarchy_pack = pack`；`scene.asset_access = [{hash, extension, url}]` 单独携带带 cap 的授权下载 URL；`scene.objects` 只作 UI 元数据兼容列表。Godot 的几何、行为、身份与层级以 `hierarchy_pack` 为准，按 `(hash, extension)` 查 `asset_access`；不能反向从兼容列表重建 canonical 内容。纯模块只返回 pack，不生成 envelope 或授权。

`required_capabilities` 是候选要求，并非服务或 runtime 的实际能力声明。主集成仍须做 actual capabilities / build ID 协商；旧 runtime 必须拒绝未知 format。

## v2 可运行子集与原子拒绝

- objects（含 group/root）加 mounts 的总数 ≤1000；超过则 `runtime_expansion_limit`。不截断数组。
- 每个 object/mount 的世界原点及显式物理组件 offset 变换后的中心，各坐标绝对值 ≤10000；超过则 `runtime_world_bounds`。所有矩阵必须有限。这个中心限制不等于已检查 GLB 几何外沿，后者仍是资产/Godot 候选职责。
- 视觉节点保留世界剪切。box collider 和 box Area 必须世界 basis 正交，可有非均匀缩放；剪切则 `runtime_sheared_box_unsupported`。trimesh collider 可以采用完整世界矩阵烘焙顶点，禁止悄悄正交化。
- sphere trigger/interactable Area 必须世界 basis 正交且三个轴长度相等，容差 `1e-7`（归一化轴点积与轴长相对差）。否则 `runtime_sphere_transform_unsupported`；不能用最大轴把椭球冒充原球。Area shape 默认 sphere；不支持的 shape 明确拒绝。
- runtime 使用 object 的完整世界矩阵变换组件 offset；box 尺寸乘世界轴长，sphere 半径乘统一世界轴长。不能沿用旧 flat row 的局部 `.position/.scale` 作为世界量。
- 源 resolver/文档原有节点、深度、TRS 和固定依赖校验仍适用；本包不放宽源规范。应用时整体构造候选，任何下载/脚本/矩阵/物理失败保留现有运行世界，不能部分应用。

## 集成责任

A 提供本纯 pack、独立 Node 测试与逻辑 fixture；root 负责 service/assets/worlds/realtime/agent/UI 与候选切换；Godot worker 独占 runtime。状态键使用 `object.id`，引用与观察须同时携带完整 address、固定 source revision、object_version/ancestry_hash，以及真实 runtime world matrix。已有世界迁移、双 Web、主权 ACK、重启恢复均须后续真实集成证据，不能由 pack 测试外推。

可消费 JSON fixture：`tests/fixtures/hierarchy-runtime-mounts.json`；其生成源在同目录 `hierarchy-runtime-source.mjs`。这是无外部资产的数学/身份夹具，10 objects + 4 mounts；不包含实际运行 ACK。测试会逐字段比较 fixture 与当前模块产物，防止契约示例漂移。
