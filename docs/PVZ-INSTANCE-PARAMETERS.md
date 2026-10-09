# 植物大战僵尸实例参数修复 · 2026-09-08

实际工程 `game-cf0039b0-7916-48be-b19a-aaaa4b236696` 的六种植物/僵尸预制件已有 11 项公开参数，但全部标为 `instance_editable:false`。花园规则也只读取预制件目录的默认值，单纯显示输入框不会改变玩法。

本次在原工程开放这 11 项实例参数，并补齐豌豆场景模板缺失的 `definition.projectile_speed` 绑定。六个场景模板显式使用 `prefab_property_overrides:{}`：没有标记的参数继承预制件当前值；修改时原子写入行为参数及该参数的 `true` 标记；恢复默认删除标记，后续预制件修改继续被继承。相同数值的显式修改仍保留覆盖意图。没有启用此字段的旧版平面对象和层级实例保持原有语义。

游戏规则通过固定 GameRuntime 包中的当前场景 ID、模板稳定 ID、预制件 ID 与来源节点 ID 解析覆盖，只替换已公开的参数。此游戏的六个实例是生成角色用的场景模板：参数作用于本场景该类植物/僵尸，保存后重新试玩生效；不是修改一个正在运行中的临时角色。地图本身未声明公开参数，面板仍显示 0。试玩检查器保持只读，编辑模式可修改源稿。

实际修改保留了现有数值、模型、坐标、名称、场景/对象 ID、会话和历史版本。只更新六份公开参数设计、六个模板的覆盖元数据、一个缺失绑定，以及花园脚本的不可变引用。应用前备份并检查源版本，通过 CreationAssets.publish + CreationStore.apply 的正常事务串行提交；随后由原启动器恢复 48910 服务。

- 应用后源版本：`src-e453731d2deabf3f3d5bcda2a8ee0c6340858c70ce256f560393fe676a4f1a72`
- 新规则资产：`2cf99ee48d872d48e200afbbb601a697441cd814eb9ed923c49b299d79d12a59`
- 本地事务、原始备份和读回检查：`.local/creation-repairs/pvz-instance-parameters/`，不入 Git。

验证：`semantic-authoring.test.mjs` 17 项通过；语义 host/frontend、实例名称及层级回归 65 项通过。独立角色运行 `pvz-instance-runtime.test.mjs`，在隔离数据库中经真实 SemanticAuthoring 修改全部 11 项参数，再通过 snapshotProjectRuntime + assembleProject 启动真实 canonical Godot。四个阶段各检查两个实际场景，覆盖默认值、实例修改不影响定义/另一场景、更新定义保留覆盖、恢复后继续跟随下一次定义更新；均通过，所有 Godot 进程退出码 0 且无脚本错误。

运行证据：`.local/creation-verification/pvz-instance-runtime/native-LkLSwh/report.json`。原 48910 页面已刷新到应用后的源版本，豌豆实例显示两个启用的输入框：子弹攻击力 28、子弹飞行速度 8。后续观察到该窗口已进入试玩，控件按既有设计变为只读，未停止用户的试玩。此记录不声称完整一局玩法验收。
