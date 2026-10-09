# 语义设计、可调属性与共享知识

2026-09-08。用户通过游戏对象、系统的功能描述与可调属性表达设计；Agent 负责 Godot 实现。本模块接入原中央源稿、事务、分支和会话，不另建一份设计数据库。实现入口为 `services/creation/semantic-authoring.mjs`，纯数据约束在 `semantic-design.mjs`。

## 工作台操作

原入口仍为 `http://127.0.0.1:48910/creation-workspace.html`。

- 输入 `@` 搜索当前场景对象；当前选中的一个或多个对象排在首位。选择后固定完整对象身份与版本，名称只用于查找。
- 输入 `@@` 搜索整个预制件定义，包括未放入场景的预制件和没有模型的游戏系统。
- 输入 `$$关键词` 搜索共享知识。发送前会加入最多三条实际相关知识的固定索引与全文；没有匹配时保留草稿并提示，不编造引用。
- 输入 `/` 可选择 `/plan`（讨论设计）或 `/goal`（持续目标）。选择和退出都会保存到当前会话，刷新后恢复。
- 左侧“游戏知识”可查找功能描述与规则、浏览全文、加入会话参考。发送后的引用标注“对象／预制件／知识”。

右侧“对象”面板把“修改功能”“控制属性需求”置顶，位于模型预览上方。两个入口默认创建全新的私人 Agent 会话，固定当前对象或定义作为目标附件并填入需求草稿；保留原会话草稿及其执行模式，不自动发送未补充的需求。重复点击使用同一次会话创建，切换分支或会话后不把请求写入错误目标。

可调属性集中到一个默认展开、可折叠的模块，空间、外观与层级设置也收纳在其中。属性按“名称＋输入控件”单行排列：数值/整数用数字输入，布尔用复选框，枚举用下拉，字符串用文本框，颜色用色块与十六进制输入；位置、旋转、缩放保留 XYZ 控件。类型、范围、说明与默认来源平时隐藏，悬停名称或聚焦控件时查看；恢复默认使用行尾按钮。属性区折叠状态在当前对象刷新后保留。功能描述置于面板底部，定义仍可编辑保存。

已有游戏不会自动得到推测的功能描述或参数。未公开能力的资源显示明确空状态，可由 Agent 查看实际实现后补齐。

## 设计资源

场景与预制件仍使用原 `kind: scene | prefab`。资源可持久化 `design`；没有该字段的历史资源，读取时显示空设计，不回写历史版本。

```json
{
  "description": "打开宝箱获得指定数量的奖励。",
  "category": "object",
  "exposed_properties": [{
    "id": "reward_count",
    "name": "奖励数量",
    "description": "每次开启时给予的物品数量。",
    "type": "integer",
    "unit": "个",
    "min": 1,
    "max": 20,
    "step": 1,
    "default": 2,
    "instance_editable": true,
    "binding": {
      "node_id": "core",
      "behavior_id": "reward_logic",
      "property_key": "amount"
    }
  }],
  "relations": [{"resource_id": "inventory", "description": "奖励交给背包系统。"}]
}
```

- `category` 为 `object | system`，描述游戏含义。无模型系统可以是预制件中的 `anchor` 节点承载真实行为。不要创建运行时不支持的 `node.kind: system`；层级 `group` 仍不能承载组件。创建空系统只创建设计资源，不代表功能已经开发。
- 属性绑定指向指定节点中稳定 `behavior.id` 的 `properties[property_key]`，不使用数组下标或显示名称寻找实现。定义必须已存在对应行为与参数，参数实际值必须符合约束。未实现的属性应通过 Agent 开发，不能先显示为有效控件。
- 支持 `number / integer / boolean / string / color / enum`。枚举选项为 `{value: string, label: string}`；颜色为 `#RRGGBB`。服务器检查类型、数值范围、正步长、默认值、唯一属性 ID、唯一绑定，以及 `instance_editable`。`unit` 是显示单位，不自动换算数值。
- 同一份行为参数是实际数值来源；没有另存一份面板值。绑定、脚本或类型发生变化时应一起调整设计，并执行实际游戏检查。
- `design` 参与资源版本、不可变预制件归档和分支合并。关联目标必须属于同一份资源清单。现有资源、会话、资产与未知历史元信息不因加入设计字段而删除。

## 实例与定义

读取详情时区分 `resource`（设计所属定义）与 `target`（当前操作对象）。返回 `properties` 包含真实 `value`、`inherited_value`、`overridden`、`editable`、`binding_valid`；这不等于当前浏览器的试玩已经应用该源版本。

层级实例使用完整 `{project_id, branch_id, resource_id, instance_path, definition_node_id}`。实例绑定固定预制件版本；修改定义不会自动升级已有实例。升级仍走原固定预览、冲突决议与 `upgrade_instance` 事务。

定义当前绑定值是新建／升级实例的继承值；声明里的 `default` 是“初始重置值”。例如定义当前值改成 11 而声明初始值为 2，新实例继承 11，实例恢复默认也回到其固定定义版本的值；只有定义的 `reset_property` 使用初始值 2。

嵌套实例的继承值包含外层预制件对子实例的覆盖。实现仅在临时投影中去掉当前场景最外实例的行为覆盖，再通过原 `resolveScene` 计算继承基线，不把最内层定义的默认值误当作最终继承值。属性修改使用原原子 `components.behaviors` 覆盖；恢复一个属性保留其他修改，整组回到继承状态时删除当前实例的该覆盖。

旧 `creation-flat-1` 对象副本没有通用的层级实例地址。绑定只接受显式 `prefab_node_id`、单节点来源定义，或可匹配的原节点 ID；不按名称猜多节点预制件的对应关系。不可靠的旧实例返回 `binding_valid: false`、`editable: false`、`unavailable_reason`，可继续浏览描述并请 Agent 补齐来源绑定。定义自身的无效绑定直接拒绝保存。

## HTTP 接口

以下均在 `/creation-api/` 下，`B` 代表 `projects/:p/branches/:b`。

| 方法与路径 | 输入与结果 |
| --- | --- |
| `GET B/semantic-resources` | 可传 `revision`；返回作用域与全部 `resources`，包括未摆放预制件和系统。 |
| `GET B/semantic-resources?resource_id=…` | 可附 `object_id`（flat）或 JSON `address`（hierarchy）；返回 `{project_id, branch_id, revision, resource, target, properties}`。 |
| `POST B/semantic-resources` | `action: create_resource | update_design | set_property | reset_property`，见下文。 |
| `GET B/knowledge` | `q, revision, limit`；返回固定版本的 `{query, total, items}`。`id` 查询返回单个完整 `item`。 |
| `POST B/knowledge` | `action: put | delete`，共享知识进入原源稿事务。 |
| `POST sessions/:sid/semantic-attachments` | 固定整个预制件或知识条目，加入本人会话草稿。 |

修改请求必须携带 `transaction_id`、`base_revision`。服务检查权限、当前版本与目标版本；相同请求身份重试返回原回执，不得改变请求内容。冲突保留用户输入并重新读取，不静默按最新对象重绑。

`update_design` 传 `resource_id`、该定义的 `expected_version` 和完整 `design`；实例面板新增属性应先打开来源定义，不能把实例修改伪装成全局设计修改。`create_resource` 传 `resource_id, name, kind, design`。

`set_property` / `reset_property` 使用详情中的 `target.resource_id`、`target.object_id/address`、`target.expected_version`，再传 `property_id`；设置时额外传 `value`。成功返回原事务结果 `{revision, branch, changed_resources, inverse, …}`，界面重新读取详情。源保存与运行应用是两件事。

知识写入示例：

```json
{
  "action": "put",
  "transaction_id": "new-request-uuid",
  "base_revision": "src-fixed-version",
  "expected_version": null,
  "knowledge_id": "death-rule",
  "entry": {
    "id": "death-rule",
    "title": "死亡与任务物品",
    "content": "死亡后保留任务钥匙。",
    "tags": ["死亡", "任务", "背包"]
  }
}
```

编辑已有条目传其实际 `expected_version`。删除传 `knowledge_id` 与版本；不改写历史条目。

## Agent 动态工具与原事务

主服务将下列工具绑定到当前执行者的项目、分支及有效运行租约，不接收用户文本中的跨项目授权：

| 工具 | 作用 |
| --- | --- |
| `semantic_read` | 读取全部设计单元，或指定资源/对象的描述与实际绑定参数。 |
| `semantic_apply` | 与 HTTP 语义资源操作相同；先读本文和当前版本。 |
| `knowledge_search` | 按关键词查询共享设计索引。 |
| `knowledge_read` | 按稳定条目 ID 和可选固定版本读取完整内容。 |
| `knowledge_write` | 保存或删除共享知识，使用固定源版本与事务 ID。 |

对应 `service.semantic` 的方法为 `resources`、`updateResource`、`knowledge`、`updateKnowledge`、`attach`。Agent 的 `origin` 透传原 `service.committed`；普通文件写入不是中央源保存。

语义修改回执保存实际 `committed_ops`，Agent 由这些操作提取完整绑定目标；修改一个实例参数不会把同场景其他实例列为修改目标。幂等重放保留同一操作和固定源版本，旧回执从其固定输入重建操作，不能按当前显示名称推测目标。

原 `world_apply` 新增操作：`set_resource_design {resource_id, expected_version, design}`、`put_knowledge {knowledge_id, expected_version, entry}`、`delete_knowledge {knowledge_id, expected_version}`。知识操作没有 `resource_id`。参数数值修改仍通过 `patch_object / patch_node / set_override / remove_override`，保留原对象、版本和撤销约束。

## 共享索引、引用与权限

共享条目保存在 `manifest.knowledge[id] = {id, title, content, tags, version}`，随源稿保存、分支和合并。资源索引从名称、设计描述、属性说明、单位与关联生成；搜索采用名称/内容关键词匹配与排序，不声称具有语义向量检索能力。

索引项 ID 为 `resource:<resource-id>` 或 `knowledge:<entry-id>`。每次查询返回精确项目、分支和 `revision`；条目有自己的 `version`。`$$` 的候选、已加入引用与失效状态应分开：改变关键词重新检索，切分支保留原分支草稿，不把旧条目无提示混入新提示词。

共享设计读取仅允许本项目有效 `owner/editor/viewer` 协作者；公开试玩身份不会由这些接口取得共享知识。写入只允许 `owner/editor`。知识来自共享资料，不抓取其他人的私人会话；Agent 之间的可查询性不扩大私人消息权限。

预制件附件输入 `{kind: "prefab", project_id, branch_id, revision, resource_id, role}`；知识附件输入 `{kind: "knowledge", project_id, branch_id, revision, knowledge_id, role: "reference"}`。知识 ID 使用上述带前缀的索引 ID。`revision` 必填并须可达于会话所属分支。

返回附件包含 `id, kind, project_id, branch_id, revision, source_revision, session_id, role, name, snapshot, captured_at, sha256`，以及资源/知识版本。预制件快照是完整固定资源，包含设计与行为参数；知识快照包含完整条目内容。改名、后续修改、分支切换不会改写历史快照。

`reference / target` 表示引用用途；`@ / @@` 表示引用对象类别，两者不要混淆。知识只允许参考。一个消息里的所有附件不能都当作修改目标；附件是用户提供的数据，不是高优先级指令或最新状态授权。修改前仍需读当前源版本。

## Plan、Goal 与验证边界

会话保存 `execution_mode: default | plan | goal`。Plan 用于讨论、读取与形成实施计划，不应写源稿或启动构建；实施需要进入允许执行的模式。Goal 使用主执行器的原生持续目标能力，并由主服务保留任务、运行和状态对应关系。执行结束、源保存与运行应用继续分别记录；会话顶部验证流程已移除；不能通过给普通消息改标题来模拟原生 Goal。

Plan/Goal 的执行器接口与生命周期由 `codex-agent.mjs`、`agent-runs.mjs` 维护。本文只记录产品与权限边界，不把下列参数运行测试算作原生 Goal 或浏览器输入交互验证。

验证命令：

```sh
node --test tests/creation/semantic-authoring.test.mjs
node --test tests/creation/semantic-runtime.test.mjs
```

语义数据测试 16 项通过，覆盖真实 SQLite 重开、flat/hierarchy 参数写入、外层预制件覆盖与多份嵌套实例、范围拒绝、权限、历史、分支合并、不可变附件，以及实际动态工具的精确目标与回执重放。

真实运行测试使用 `CreationStore + CreationAssets + SemanticAuthoring`，经 `CanonicalGameValidation` 的 `project-snapshot` / 注册固定工程流程启动 `GameRuntime + standalone.tscn`。四次独立 headless Godot 运行中，真实 GDScript 在 `initialize/tick` 读取 `ctx.properties`：

| 固定候选 | 左实例 | 右实例 | 无模型系统 |
| --- | --- | --- | --- |
| 初始 | 2 | 2 | 3 |
| 调整左实例与系统 | 7 | 2 | 11 |
| 定义改成 4，实例未升级 | 7 | 2 | 11 |
| 只升级右实例 | 7 | 4 | 11 |

每次检查至少 120 次实际行为 tick、启动回执的源版本、原生入口、不可变工程哈希与完整源稿。系统由 `anchor + behavior` 构成，没有模型。没有伪造 ACK、替代入口、HTTP 测试服务或 Web 导出。

主根集成后的四阶段证据在 `.local/creation-verification/semantic-runtime/native-6p2r66/`；更多真实 Agent、浏览器与独立运行证据见 [SEMANTIC-AUTHORING-VERIFICATION.md](SEMANTIC-AUTHORING-VERIFICATION.md)。它们不代表完整玩法、美术、共享世界发布或所有平台验收通过。重跑会生成新的独立证据目录；不得用旧目录替代新版本验证。


## 预制件定义与场景实例（2026-09-08）

场景中的预制件实例显示顶部实例名称、允许实例调整且已连接真实行为的参数，以及只读功能描述。未公开给实例的属性不显示；功能修改与控制属性需求入口放在来源定义。实例名称按用户后续要求统一为顶部双击编辑；坐标、旋转、缩放复用参数控件。进入来源定义后，仍能编辑功能、默认属性，并从两项常用入口创建新的 Agent 会话。

“跳转到预制件”打开真实来源资源，定义页的“返回实例”恢复原场景和精确对象选择。返回记录保存项目、分支、资源以及对象 ID / 完整层级地址；改名不影响定位。场景或实例被删除时给出提示，不按同名对象替代。来源按钮提示实例所引用的版本；进入定义编辑不会自动升级已有的固定版本实例。

预制件定义使用紫色四菱形组件图标，实例使用同色空心菱形；图层、预制件目录与文档切换保持一致，并保留文字提示。颜色不替代对象地址，也不影响协作者身份颜色。

创建实例时由中央事务按当前文档已有名称分配序号，例如“宝箱 1”“宝箱 2”；多节点旧版预制件保留各来源节点名称再编号。明确的自定义名称与撤销恢复名称保留。用户可以单独改名，名称不是唯一身份键。完整层级实例将名称保存在实例挂载上，旧版实例保存在对象上；均保持版本冲突检查、定义与其他实例独立。
