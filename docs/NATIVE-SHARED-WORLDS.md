# 原生共享权威世界

本文描述 `creation-native-1` 的显式共享运行协议。独立 Play、公开独立试玩发行、共享房间各有独立入口和生命周期。完成构建不会发布共享房间；编辑源稿也不会推进房间正在使用的固定版本。旧固定共享世界继续使用原有运行端。

## 固定工程与运行角色

原生源稿的权威仍是 `source_files` 中的真实 Godot 工程。`native_nodes` 是引擎生成的编辑索引，不能用作共享玩法模拟器。

`project-snapshot.mjs` / `assembleProject` 先固定源版本、完整依赖、可信运行文件和工具链。`purpose: native_shared` 在现有构建队列中调用：

```js
configureNativeSharedProject({
  service, job, directory, godotPath,
  executionEnvironment, enforceIsolation: true, run
})
// => { directory, authority_directory, receipt }
```

`run(bin, args, cwd, options)` 使用构建队列已有的隔离、取消和进程追踪。两套工程都以 `GameRuntime` Autoload 和 `res://atelier_runtime/standalone.tscn` 启动：

| 目录 | 固定内容 | 执行职责 |
| --- | --- | --- |
| `native-authority/` | 完整作者工程、脚本、Autoload、资源和可信运行端 | 中央唯一真实 Godot 模拟 |
| `project/` | 从同一源通过 Godot 烘焙的 PackedScene、显示资源和可信客户端桥 | 实际原生节点呈现、声明输入绑定；不执行作者脚本/Autoload |

`release.native_shared` 固定 `protocol: 1`、`contract: wa-native-world-state-1`、`role`、`build_id` 和 `source_identity`。客户端额外记录资源 ID 到烘焙场景路径的映射。运行端只从这份固定工程解析资源 ID，不接受网络传入的任意脚本或场景路径。

`job.native_shared` 保存源身份、`authority_files`、`projection_files`（路径、SHA-256、字节数）、状态配置与实际 bake receipt。文件清单保留 `.atelier` 等源目录；排除 `.godot` 和 `.git`，拒绝符号链接以及读取中变化的文件。备份须连同这些固定输入保存，不能仅保留 Web 目录或日志。

固定构建身份包含生成器的完整本地模块依赖及按路径调用的 `tools/native-editor/bake_preview.gd`。更新烘焙器会产生新构建身份，并沿用工具链变化的完整转移规则。固定原生工程关闭 Godot 4.6 的文本资源二次打包转换，保留真实继承布局；共享显示端使用去脚本的 PackedScene 派生文件，作者源字节仍完整保留在权威工程和源归档中。

运行 `bake_preview.gd` 时保留完整引擎日志，只过滤已经由空 Godot editor SceneTree 实验复现的精确退出诊断 `ERROR: N RID allocations ... were leaked at exit.`。其他 ERROR、SCRIPT ERROR、非零退出和 bake receipt 的错误仍拒绝构建。

## 状态声明

在需要保存状态或接收输入的原生节点上声明稳定身份与网络契约：

```gdscript
# 对应 .tscn 中的 metadata/wa_node_id 和 metadata/wa_shared。
metadata/wa_node_id = "actor-root"
metadata/wa_shared = {
    "version": 1,
    "state": ["score", "velocity"],
    "defaults": ["speed"],
    "inputs": {"move": {"method": "shared_move", "owner": true}},
    "input_stop": "shared_stop"
}
```

这是场景元数据示意；不是可直接放入 `.gd` 的属性赋值语法。实际作者脚本例如：

```gdscript
extends Node2D
@export var speed: float = 160.0
var score: int = 0
var velocity: Vector2 = Vector2.ZERO

func shared_move(_player_id: String, payload: Variant) -> void:
    # 框架验证输入来源、目标、动作和有界数据；玩法取值由作者验证。
    var direction := clampf(float(payload.get("x", 0)), -1, 1)
    velocity = Vector2(direction * speed, 0)

func shared_stop(_player_id: String) -> void:
    velocity = Vector2.ZERO

func _physics_process(delta: float) -> void:
    position += velocity * delta
```

`state` 读取并恢复权威实际 Node 属性，可以包含没有 `@export` 的私有变量。`defaults` 是允许同进程更新的配置，必须与 `state` 分离；原生索引还要求这些参数确实是同类型的导出属性。作者不应把变化中的玩法数据写入 defaults。

所有带稳定 ID 的 Node2D / Node3D 自动传输完整局部 Transform2D / Transform3D，包括负缩放、非均匀缩放和 shear。`visible` 与摄像机启用状态有内建显示同步。Label 文本、Control 布局和其他变化中的内建属性需要在 `state` 中声明，例如 `text`、`position`、`size`。自定义脚本变量在客户端保留为状态影子；去脚本 Node 只应用其确实拥有的内建属性。观测返回的实际 Node 属性和影子值必须区分。

值编码支持有界有限 JSON、StringName、向量、Quaternion、Color、Transform2D / Transform3D；拒绝 Node、Resource、Callable、RID、未支持类型、非有限数及超限容器。类型标签使用 `$type`，作者 Dictionary 不应使用保留的 `$` 字段。

状态声明版本变化时，作者提供 `shared_migrate_state(previous_version, state) -> Dictionary`。传入、返回的是快照中的可序列化状态；向量等保留其类型标签。缺失迁移函数、删除仍在检查点中持有状态的节点/属性、动态资源缺失或类型不兼容会拒绝恢复。

作者 Autoload 可在 `_ready()` 设置 `wa_node_id` 与 `wa_shared`；其声明状态使用 `["@autoload", autoload_name]` 地址前缀保存。客户端不执行这些 Autoload。

## 动态实例、玩家和关卡

权威运行中的桥提供：

```gdscript
GameRuntime.shared.is_authority() -> bool
GameRuntime.shared.key_for(node) -> String
GameRuntime.shared.players() -> Array
GameRuntime.shared.player(player_id) -> Dictionary
GameRuntime.shared.spawn(resource_id, spawn_id, parent_key="", owner_id="", initial_state={}) -> Node
GameRuntime.shared.despawn(spawn_id)
GameRuntime.open_scene(resource_id)
```

`spawn` 真实加载固定工程中登记的 PackedScene；稳定 `spawn_id` 必须唯一。`parent_key` 为空时挂到实际当前关卡根，否则是完整稳定地址。`owner_id` 绑定可控制此实体的玩家；`initial_state` 用于实例根的已声明状态。动态嵌套保留完整实例链，例如 `['player-alice', 'nested-crate']`，再加预制件内部原生实例 ID。

稳定节点 key 是 `JSON.stringify([instance_ids, node_id])`。共享运行的 key 不替代编辑协议的地址；服务通过固定源版本和原生视图映射对象。

桥的信号为：

```gdscript
player_joined(player: Dictionary) # id/name/color/online/last_input_seq
player_left(player_id: String)
player_input_stopped(player_id: String)
initialized
scene_loaded(resource_id: String, scene_generation: int)
```

作者在权威场景中订阅玩家事件，决定角色创建与移除。独立 Play 的 `GameRuntime.shared` 为 null，兼容两种玩法的脚本应自行分派。框架不添加通用角色或硬编码移动规则。

切关时不重放 `player_joined`，以免重复执行奖励或入场副作用。新关卡可以在 `scene_loaded` 时枚举 `players()`，按 `online` 状态创建其角色；角色是否跨关保留由作者的声明状态决定。`restoring` 在检查点恢复前已经设为 true，作者 `_ready()` 可以据此避免与动态实例恢复重复创建对象。恢复后的玩家先离线，真正重连后重新授权。

当前关卡 `resource_id` 与房间入口分别保存。快照携实际 `scene_generation`；A→B、A→A 都会改变代次。输入、应用确认、观察与选择必须使用当前代次，不能只凭一个复用的节点 ID。冷恢复从检查点记录的实际关卡启动，进程转移还会改变 epoch。

## 原生输入绑定

输入方法签名是 `(player_id: String, payload: Variant)`，停止方法签名是 `(player_id: String)`。`owner: true` 的动作只允许对应实体所有者；`owner: false` 表示作者声明的全局动作，仍经过中央访问权限与控制令牌校验。客户端没有通用 `set` 接口。

可信桥把作者 InputMap 和原生 Button 接到声明动作：

```gdscript
metadata/wa_shared_keys = [{
    "input_action": "move_right",  # project.godot 的 InputMap 动作名
    "target_key": "@owner:actor-root",
    "action": "move",
    "payload": {"x": 1},
    "released_payload": {"x": 0}
}]
metadata/wa_shared_bind = {
    "target_key": "@owner:actor-root", "action": "fire", "payload": {}
}
```

目标省略时使用绑定节点本身的完整 key；`@owner:<node_id>` 查找当前玩家所属实例中的节点。只有明确绑定的 Button 恢复原生输入。按住键每 100ms 续发；松开使用 `released_payload` 或空输入。

空输入、离开和 750ms 输入超时都会调用实际 `input_stop` 并发出停止信号。只停止该玩家拥有的节点及无所有者的全局节点，不停止其他玩家实体。作者必须在停止回调中清掉持久移动/操作意图。冷恢复保留检查点状态供核对，并在首次恢复推进时清理旧连接的输入意图。

## 协议与控制围栏

中央通过现有认证 loopback WebSocket 启动权威。握手为 `worker_hello`，核对协议、源身份和 build ID；`init` 固定 world/epoch/revision/source/入口及可选检查点。初始化失败不能上线候选。

每个完整快照包括：

```text
schema: wa-native-world-state-1
world_id, epoch, scene_revision, source_identity
resource_id, scene_generation, sequence, tick
players: { uid: { id, name, color, online, last_input_seq } }
nodes: { key: { node_id, instance_ids, version, state, transform?, kind, display, autoload } }
spawns: { spawn_id: { resource_id, parent_key, owner_id } }
removed, parameter_overrides, runtime_fault, object_states
```

快照约每 100ms 发送；`sequence` 每次取快照递增，`tick` 来自权威真实推进。`object_states` 只保留旧行为兼容状态，不代表任意原生脚本的全部内存。暂停/init 期间仍发送心跳，中央不能将事务暂停误判为死进程。

中央发给客户端的 join 基线固定完整快照、state hash、`control_generation` 和 `input_seq_base`。客户端先实际加载固定烘焙关卡并应用静态/动态节点状态，然后发 `shared_ready`，回报 world/epoch/revision/source、实际关卡及代次、sequence/hash/control token。中央精确核验保存的基线后才发 `active`。

输入序号从基线 `last_input_seq` 后递增，重连不从 1 重置。输入还携 world/epoch/revision/resource/generation/control token；中央覆写 player ID，拒绝跨玩家、陈旧代次或没有 active 控制的输入，再交权威做动作与所有权校验。权威会在作者输入触发真实切关后等待新场景完成，再返回 ACK。所有 ACK 和周期快照统一进入服务的单调快照更新逻辑；关卡或代次改变立即撤掉客户端旧控制并重新建立应用基线。

客户端桥使用现有同源、iframe source 与 nonce 校验。`ready` 仅在真实固定入口加载成功后发出；`NATIVE_SHARED_CLIENT_READY` 是构建启动标记，不是授权 ACK。`shared_ready` 才表示该客户端已应用指定的真实共享基线。

个人检查流程先发空输入并等待权威快照确认该输入序号，随后只冻结本客户端快照应用和显示。权威和其他玩家继续。`world_state` 保留 `playing / entering_inspect / inspecting / resyncing`、request ID/mode ACK、已应用/冻结/最新序号以及停止输入确认。返回游玩时应用最新缓存快照。检查摄像机、选择和 UI 显示开关使用现有调试桥，不暂停权威 SceneTree。

## 内容更新与回退

同进程路径只接受固定运行代码/工具链不变、原生资源与节点结构/脚本/连接/状态声明不变，且差异全部属于声明的导出默认参数。`classifyNativeSharedUpdate` 输出 `{resource_id,node_id,instance_ids,property,previous,value}`；不能把更新整个 JSON 状态当成参数变更。

中央先暂停旧权威，运行端检查所有旧值/类型后统一应用参数，保留声明状态、完整矩阵、玩家、动态实例和 tick。作者可提供 `shared_validate_defaults() -> String`，空串表示通过。setter 或验证失败时恢复参数和声明状态，候选不提交。反向事务使用 `previous=forward.value, value=forward.previous`。

只有源 head、权限、房间版本再次核验且 world/delivery/幂等 receipt 同事务提交后，才恢复运行并引导客户端切到对应固定显示工程。提交前失败先探测权威实际版本，必要时反向应用，再恢复旧世界。进程和 epoch 可以保持不变；短暂参数事务暂停不等于零中断承诺。

已提交参数也作用于后续动态 spawn 和切关重建的静态节点，在作者 `_ready()` 前应用。切换到另一份固定源工程时清除旧进程的参数覆盖，候选固定源自身的默认值生效；声明玩法状态按检查点恢复。

脚本、结构、状态声明或其他不兼容内容变化走检查点接管：旧权威暂停，隔离候选真实启动并恢复；失败回收候选、恢复旧权威。候选成功且中央事务完成后，切换 epoch/固定 build，客户端重新应用并确认，再授控制和回收旧进程。这是进程转移，不是原进程热重载。

显式发布使用原有分支 `publish` 入口，带 revision/resource_id/request_id/expected_world_version；`GET shared-world` 查询房间和发布操作，`GET shared-playable` 只返回当前共享固定发行。权限在耗时构建、候选启动和最终事务前重新检查。独立试玩的 `game-releases` 不被共享发布推进。

## 边界与真实证据

框架不复制任意脚本调用栈、未声明变量、任意运行中新增 Node、Resource 对象图、Callable、引擎物理接触缓存或操作系统资源。需要跨客户端/检查点保留的动态对象应通过 `shared.spawn` 创建，状态应声明。已有单机脚本和旧行为即使能在权威运行，也不等于它们已具备正确多人所有权、输入、UI 与状态迁移语义；这些仍需作者适配。

2026-09-09 的运行端证据保存在隔离目录 `.local/native-framework/workers/native-shared/evidence/`：

| 证据 | 实际执行与检查 |
| --- | --- |
| `assembly-report.json`、`assembly.log` | 真实 Godot import/bake；作者工程字节保持固定；独立 authority 与去脚本 PackedScene 显示工程 |
| `authority-report.json`、`authority-test.tap` | 实际 Godot worker 与真实 WebSocket；两名玩家；私有变量/Autoload；2D/3D 矩阵；所有权/陈旧输入拒绝；检查点；同 PID 参数变更及 setter 回滚 |
| `authority-boundary-report.json` | 暂停心跳、玩家输入停止隔离、超时停止、动态嵌套/移除、真实 A→B 与旧关卡输入拒绝、实际当前关卡冷恢复、非法 Resource 状态拒绝；更新参数后切关/回场与 spawn 的 `_ready()` 读值；跨源恢复使用候选默认值 |
| `client-probe-report.json`、`client-probe.log` | 28 项实际 headless 原生客户端检查：收到 ready 即 join；真实 Node/矩阵；真实 InputEventKey 与 InputEventMouseButton；Button 动作；停止 ACK 后冻结；继续应用最新状态；真实属性观测与状态影子区分 |

客户端矩阵比较采用 `1e-6` 浮点序列化容差，保留完整 basis；不通过分解 TRS 重建。参数拒绝测试有意触发作者 setter ERROR，用于证明事务回滚，其日志保留；成功客户端 probe 无 ERROR。

上述表格记录运行端和工程装配证据。两台真实浏览器的原工作台交互、共享发布与生命周期结果见 [原生框架补齐验证](NATIVE-COMPLETION-VERIFICATION.md)；框架验证不替代每个具体游戏的多人玩法输入测试。
