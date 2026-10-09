# 原生场景编辑适配器

Godot 4.6 的 PackedScene、场景编辑状态和 ResourceSaver 决定引用、默认值及实例差异。工具没有第二套继承求值器，不从 JSON 重新装配场景。所有调用只针对中央事务的可丢弃完整候选工程。正式调用必须设置 `enforceIsolation: true`。

```js
import { importNativeProject, runNativeScene } from './tools/native-scene/invoke.mjs';
await importNativeProject({ projectDirectory, enforceIsolation: true });
const result = await runNativeScene({
  projectDirectory,
  enforceIsolation: true,
  request: {
    protocol: 'wa-native-scene-1',
    scene_path: 'res://scenes/garden.tscn',
    action: 'apply',
    assign_ids: true,
    ops: [{
      op: 'set_property',
      target: { node_id: 'shooter', instance_ids: ['placement-a'] },
      property: 'attack', value: 20,
    }],
  },
});
```

`importNativeProject` 使用真实 `--headless --editor --import`。首次完整导入生成 `.godot` 缓存、`.gd.uid`、`.glb.import` 等引擎资源旁文件，并发现脚本/资源错误。`.godot` 不属于源稿；原生 UID/import 旁文件应由完整源事务收集并固定。普通场景调用也会启动编辑器扫描，所以第一次 inspect 可能产生这些旁文件；应先导入再收集完整源文件。`inspect` 不调用 ResourceSaver 保存场景，但项目自身 `@tool` 代码可能执行，故候选工程和执行隔离必须同时存在。

`runNativeScene` 支持 `godotPath`、`adapterPath`、`timeoutMs`、`signal`。`executionEnvironment` 可注入现有 `prepareExecutionEnvironment` 函数；收到的目录/读写白名单包含候选工程和已创建的请求/响应临时目录。默认正式集成从 `services/creation/execution-environment.mjs` 加载同一帮助函数。隔离不可用时拒绝运行；没有无保护回退。开发探针可显式省略隔离选项。

## 请求

- `action: inspect`：只加载、索引，不保存场景。
- `action: apply`：内存中执行整批操作，成功才 pack/save；保存后重新加载字节建立响应。
- `action: create_scene`：新建真实场景，附加 `root_type`（默认 Node3D）、`name`、`node_id`，再执行 ops；拒绝覆盖已有文件。
- `assign_ids`：apply/create_scene 默认 true；只为当前场景自有节点和直接实例分配缺少的身份。导入应从依赖底层到顶层规范化，保留 Godot 保存的 `unique_id`，再建立上层实例覆盖。

目标 `target` 支持 `{node_id,instance_ids}` 或明确的 `{path}`。无限定重复 ID 拒绝操作。`path` 相对当前场景根，根为 `.`；它仅用于初次导入或明确文件编辑，不作为中央稳定身份。迁移保留独立变换挂载时，可用 `{instance_ids,mount:true}` 定位技术挂载。

| op | 其他字段 |
| --- | --- |
| set_property | target, property, value |
| reset_property | target, property |
| transform | target, value:{position,rotation 或 rotation_degrees,scale}；rotation 为弧度、rotation_degrees 为度 |
| rename | target, name |
| create_node | parent（默认根）, type, name, node_id, properties |
| instantiate | parent（默认根）, scene_path, name, instance_id, properties |
| delete_node | target |
| reparent | target, parent, keep_global_transform（默认 true） |

原生值 JSON 采用数值/字符串/布尔，Vector2/3/4、Color、Quaternion 可传数组或 `{$type:'Vector3',value:[...]}`；NodePath 为 `{$type:'NodePath',value:'...'}`；已有 Resource 为 `{$type:'Resource',path:'res://...'}`。未支持的复杂属性应提交真实原生文件，不能通过字段编辑丢失类型。脚本替换、owner、scene_file_path、稳定 metadata 等结构属性须走原生源文件或专用结构操作，不能用普通属性绕过。

## 响应

`{ok,protocol,engine_version,scene_path,changed_files,errors,nodes,dependencies,connections,diagnostics}`。`ok` 包括捕获的真实 Godot 脚本/资源错误；不能只看进程返回值，GDScript 编译失败可能返回 0。调用封装还拒绝丢失响应、超时、输出超限和启动阶段错误。

每个 node 包含 path、node_id、instance_ids、name、type、owner_path、scene_file_path、metadata、properties、transform、local_transform、world_transform。`transform` 是 UI 兼容 TRS：position/scale 数组，rotation 使用度。完整 local/world_transform 为带类型的原生矩阵，保留非均匀缩放/剪切信息；二维行保留真实 Transform2D。

每个 property 包含 name/type/type_name/hint/hint_string/usage/exported/value/inherited_value/default_known/default_source/overridden/stored_locally。有效值来自实例化节点，默认值来自引擎实际实例化的所属场景或 Script/ClassDB 原生默认值，覆盖标记来自重新 pack 到内存后的 SceneState。本内存 pack 也规范化 Godot 通过 unique_id 恢复的改名路径；inspect 不保存它。

`storage_property` 明确原生存储粒度。Node3D 的 position/rotation/scale 等编辑器别名共用 `transform`，其覆盖标记来自该字段；它们不是独立保存的覆盖。中央操作应继续使用完整原子变换事务，不能按别名并发合并或生成独立参数撤销。

Resource 值包含 class/path/local_to_scene。仅测试请求 `include_runtime_ids:true` 时附本进程 `instance_id` 验证共享；该数字不能保存为中央身份或参与内容哈希。

metadata/wa_node_id 是定义节点身份，metadata/wa_instance_id 是放置身份。完整实例链按外到内排序。迁移的 `wa_instance_mount=true` 技术挂载计入链，其下无放置 ID 的 `__Definition` 实例不增加链元素；工具不会给这种子根补随机实例 ID，也不会给技术挂载补假对象节点 ID。原生直接实例仍采用根上的 wa_instance_id。

## 保存与边界

- MAIN 编辑状态保留非脚本默认的预制件值；新实例用 INSTANCE 状态。修改嵌套子节点时启用完整原生 editable-instance 链。
- 对继承来的内部结构 rename/delete/reparent 明确拒绝，要求编辑所属定义。允许实例自有属性覆盖及自有子节点。
- rename/reparent 更新可解析的 NodePath 属性与当前场景内建 Animation 轨道。需要修改外部共享动画资源时拒绝并保留候选原字节，由更广的原生源事务处理；不默默保存失效引用。
- 引用路径校验与父子循环检查在工具内执行；中央服务还必须重查权限、源 head、lease、完整依赖和并发前置条件，再一次提交全部源文件。
- `dependencies` 仅是 ResourceLoader 可见的资源引用图，不是完整 GDScript preload/load 依赖闭包；脚本源码或动态加载改变必须使用完整工程源身份保守失效。
- 定义删除造成已保存实例覆盖目标消失时，Godot 的对应警告转为 `ORPHANED_SCENE_OVERRIDE` 拒绝候选，不能静默跳过丢失覆盖。只有中央已获得明确丢弃指令时，才对受影响场景执行 `action:'apply', discard_removed_overrides:true`；引擎用真实 pack/save 移除悬空块，响应 `discarded_overrides` 记录实际警告。普通成功的 unique_id 改名恢复不被此规则拒绝。
- 场景未进入游戏树，不调用游戏 _ready；编辑构建仍可能执行 @tool/_init 或加载原生扩展。实际 OS 隔离限制读取/写入/网络/继承环境，不能把离树描述成沙箱。
- 本适配器不负责热更新、共享世界权威或发布。成功是候选源文件及索引成功，不是游戏行为验收。

## 本次实际证据

同目录上级的 `test/probe.mjs` 和 `test/advanced.mjs` 使用本机真实 Godot 4.6、新进程重开文件，覆盖双实例参数隔离、定义默认与脚本默认不同、定义跟随/reset删差异、双层嵌套重名节点、局部/世界变换、未知资源/metadata/信号/动画保留、原生 unique_id 改名恢复、NodePath/动画改名、create/instantiate/delete/reparent、二维新场景、迁移挂载身份、原生继承场景以及坏输入拒绝。`test/isolation.mjs` 验证候选外合成哨兵读取/写入被拒绝、宿主测试环境变量不继承、候选内写入允许。探针不代表中央协作、网页或游戏运行已经集成验收。
