# 桌面启动器与完整离线工作区

从固定发行清单取得真正的 macOS Godot 导出包，验证 SHA-256，运行原生客户端，并依据运行端 telemetry 确认进入。下载、启动与实际取得控制权分别记录。

## 在线原生游玩

已登录账号的短期服务 token 通过 `WORLD_ATELIER_TOKEN` 环境变量传入，不写入工作区、日志或分享包。

```sh
node apps/desktop-launcher/launch.mjs \
  --server=http://127.0.0.1:48900 \
  --project=PROJECT_ID --branch=main
```

可用 `--world=WORLD_ID` 指定同分支世界。客户端下载完成后再次 prepare-join；版本已经改变会明确失败，需要重新解析。它不会在失败时终止别的已运行客户端，也不会无期限重复进入。

缓存按 runtime hash 分隔。下载 ZIP 在 staging 校验长度与 SHA-256；解压后记录并复核所有文件哈希、可执行标记和符号链接。缺失、损坏或不完整的 `.app` 不会因目录存在而被信任，会从已验证 ZIP 在 staging 重建。离线 ZIP 损坏会明确拒绝运行，不发起隐藏下载。

## 下载完整离线包

先保证该分支至少有一个经过真实构建的可玩发行。

```sh
node tools/workspace.mjs checkout \
  --server=http://127.0.0.1:48900 \
  --project=PROJECT_ID --branch=main \
  --dir=/absolute/path/MyExpedition
```

下载包含：

| 文件 | 用途 |
| --- | --- |
| `workspace.json` | 账号/工程/分支/工作区身份、基础源码版本、固定可玩发行与状态来源 |
| `content.json` | 可编辑源码；不会被游戏启动覆盖 |
| `source-assets.json` | 源码依赖的真实 GLB/GDScript blobs，按哈希校验 |
| `play-content.json` | 固定可玩发行完整内容，含对应资产 |
| `client/` | 已验证 macOS ZIP 和完整 `.app` |
| `Play offline.command` | 无需 Node、原仓库或网络的原生游玩入口 |
| `launcher/` | 可独立执行的 Node 编辑验证、导入与启动工具 |
| `saves/` | 依账号、工作区和状态域隔离的本机进度 |
| `PLAYABLE-SHA256.txt` | 直接游玩前校验应用和可玩内容的文件清单 |

双击 `Play offline.command`，或在终端执行它。整个文件夹可以移动到其他目录；默认进入已验证的 `play-content` 与它匹配的状态种子。后续重启接续本机进度。这个入口不需要 Node，也不会连接中央服务。

较新的 `source_head` 可能尚未构建；包中的 `source_ahead_of_playable` 会明确记录，源码不会被冒称为可玩内容。默认游玩也不会自动应用未验证编辑。

## 离线修改与验证

编辑 `content.json` 后，可完全离线运行：

```sh
node launcher/launch.mjs --offline=workspace.json --edited
```

也可在工程中使用 `node tools/workspace.mjs play --dir=PATH --edited`。该路径使用下载的真实 Godot 导出执行 headless 内容验证，再打开同一导出的实际游戏。源码引用的模型和行为必须存在于本地资产包且哈希匹配；错误候选不会修改既有可玩内容或存档。

默认可玩世界和每个不同的已验证本地候选各自拥有独立状态域；不会静默迁移背包、任务或物理状态。相同候选重启会复用自己的存档。`--new-save` 明确创建新的空白本地存档。当前没有实现跨本地候选的存档迁移，所以修改候选内容会进入新的本地进度。

源资产可通过编辑工具上传并下载到工作区；只修改 JSON 中的资产哈希，不能凭空获得缺失的模型或源码。默认独立包可以运行已下载的全部依赖；制作新的 GLB/GDScript 后需要在本地资产字典中按真实 SHA-256 登记，或联网通过资产 API 上传并取得内容包。

## 重新联网、协作上传

整个包移出仓库后也可使用内置 CLI：

```sh
node launcher/workspace-cli.mjs push --dir=. --server=http://127.0.0.1:48900
```

仓库内对应命令：

```sh
node tools/workspace.mjs push --dir=PATH --server=http://127.0.0.1:48900
node tools/workspace.mjs watch --dir=PATH --world=WORLD_ID
```

`push/watch` 只发送 `{format,project_id,branch,base_revision,content,message}`，不发送 `asset_blobs`、发行包或玩法状态。默认接着调度真实构建；设置 `--world` 才应用到所选世界。`--no-build` 只提交源码。`--runtime-hash=HASH` 可明确固定已导出的构建客户端；省略时由服务选择当前导出。世界应用携带此次构建的 release ID，下载/构建期间分支再次推进会明确要求重新解析，不静默应用另一版本。

服务端三方合并完成后，工具将上传期间新增的本机编辑重放到服务器合并结果，再更新 `content.json` 与基础提交，避免下一次上传回滚同伴的改动。若重放冲突，保留当前文件和完整三方证据 `local-conflicts.json`，拒绝后续自动推送。编辑完成后明确执行：

```sh
node tools/workspace.mjs resolve --dir=PATH --accept-current
```

本地写入使用锁、每个文件的原子替换及恢复 journal；上传前后文件保存在 `.history/`。不把多个文件的更换伪称为单个文件系统事务。一个本地工作区应由一个源稿编辑器写入；跨用户协作使用独立工作区和服务器三方合并。

## 原生验收证据

启动器可传入只含普通输入动作的 JSON 脚本，以及运行日志/截图位置：

```sh
node apps/desktop-launcher/launch.mjs \
  --project=PROJECT_ID --input-script=/absolute/input.json \
  --log-dir=/absolute/evidence --capture=/absolute/evidence/native.png \
  --capture-after=3 --quit-after-seconds=5
```

`input.json` 示例：

```json
[
  {"at":1,"action":"select","payload":{"object_id":"landing_crystal_0"}},
  {"at":1.3,"action":"interact","payload":{"object_id":"landing_crystal_0"}},
  {"at":2,"action":"move","payload":{"x":0,"z":1},"duration":0.35}
]
```

输出含引擎 `runtime.log`、真实 telemetry 快照、`telemetry.jsonl` 连续记录及 `launch-receipt.json`。在线回执核验 world/release/user；不通过 `/host` 或伪造状态制造成功。

完整实际验收脚本：

```sh
WORLD_ATELIER_ROOT=/absolute/WorldAtelier \
DESKTOP_EVIDENCE=/absolute/isolated-evidence \
node apps/desktop-launcher/tests/e2e.mjs
```

默认使用独立 48933/48934 端口、独立数据目录及真实已导出的 Godot。会打开独立原生窗口并自动截图/退出，关闭它自己启动的中央服务后继续验证离线包。测试不会部署外部服务。
