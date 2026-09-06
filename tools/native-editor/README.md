# Godot 原生场景工作区

`workspace checkout` 下载完整包后会在 `editor/` 生成独立 Godot 4.6 工程。打开 `editor/project.godot` 和 `world.tscn`，在 3D 视图里选择真实 Node3D，修改 X/Z 位置、统一缩放、Display Name、Object Color、Solid，保存场景。原生 `EditorPlugin.scene_saved` 信号导出源码，并以场景上次保存的基础快照与当前 `content.json` 三方合并。

```sh
WORLD_ATELIER_TOKEN=... node tools/workspace.mjs checkout --project=ID --dir=/path/to/workspace
WORLD_ATELIER_TOKEN=... node tools/workspace.mjs watch --dir=/path/to/workspace --world=ID
```

第二条命令监听真实场景导出产生的源码变化，提交后等待实际 Godot 构建与固定发行应用。构建完成、世界已应用分别输出，导出场景本身不代表世界交付成功。编辑器窗口保存后可以继续编辑，在线游戏无需因兼容内容修改而重启。

离线工作区包含模型 GLB、对应原始哈希、编辑器适配脚本和完整原生客户端。编辑器需安装 Godot 4.6；保存导出需 Node。Node 路径在 `project.godot` 的 `world_atelier/node_binary`，跨机器移动时修改为该机器 Node 路径。双击离线基线启动无需 Node。离线编辑后的试玩通过 `node launcher/launch.mjs --offline=workspace.json --edited` 进行真正 Godot 校验，使用独立存档。

## 保存与冲突

- 每个对象保存稳定 ID 和原始字段。受支持属性写回源码，其余对象/规则/任务字段保留。
- 第二次原生保存不会把同伴在前一次合并中的独立字段改动回滚：场景基础记录的是已导出的场景快照，而非合并后源码。
- 冲突保留在 `editor/native-export-conflicts.json`，工作区 `content.json` 不覆盖。按冲突记录调整原生场景对应字段后再次保存。
- watch 正在上传时保存可能因工作区锁而拒绝导出；场景仍保留，完成后从编辑器 Project → Tools → World Atelier: Export scene to workspace 重试。
- 远端合并引入模型或脚本引用后，push 使用当前成员权限下载缺失依赖，校验 SHA-256。失败保留已提交源码与错误 `source-preparation-error.json`；`refresh-assets --dir=...` 只补资源，绝不改变基础提交。
- 新下载工作区若源稿依赖缺失，会明确保留 `NATIVE-EDITOR-UNAVAILABLE.txt`。补齐资源后运行 `node launcher/workspace-cli.mjs editor --dir=.` 生成工程。

## 表达范围

本桥接支持当前 schema 1 的真实原生对象字段编辑，包含本地 GLB 预览和碰撞节点。Y 位置、旋转、非统一缩放无法被当前 XZ 游戏内容表达，导出时明确拒绝。非适配节点不参与内容导出。碰撞编辑目前是 solid 与统一 scale，形状由游戏实现决定。完整任意 Godot 场景、GDScript 生命周期或引擎源码修改需构建新 runtime，再由中央服务执行版本交接；本适配器不声称任意场景或代码 HMR。

使用官方 [EditorPlugin.scene_saved](https://docs.godotengine.org/en/4.6/classes/class_editorplugin.html#class-editorplugin-signal-scene-saved) 和 [工具脚本](https://docs.godotengine.org/en/4.6/tutorials/plugins/running_code_in_the_editor.html)。验收脚本中编辑自动化调用真实 `EditorInterface.save_scene()`，经过同一插件信号与导出逻辑，不伪造运行端确认。
