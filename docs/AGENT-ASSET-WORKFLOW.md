# 游戏 Agent 资产权限修复与 skill

2026-09-10。已在原 48910 服务加载。入口仍为 `http://127.0.0.1:48910/creation-workspace.html`。

## 问题与修复

会话 `session-07b9bb62-30c0-42af-b8c9-fe6ba96379b1` 使用 full-access，但平台开发者指令、工作区清单和工具校验同时要求 text_files_only，甚至禁止资产生成/转换。该会话因而连续报告无法导入网上找到的坦克模型。网络并非此次阻碍：创作命令本来已开启网络。

引用式上下文继续保留。资产文件可在服务器的当前会话下载、读取、生成、转换并放入可编辑 Godot 工程；`submit_native_workspace` 安全扫描磁盘，原子保存资产新增、替换、删除及原生场景/脚本修改。资产字节不通过模型工具参数传入，回执、附件和溢出文件仍过滤载荷并限制传输大小。`world_read(source_path)` 对资产返回路径、哈希、大小和 `context_only`，不再错误称为只读。

跨回合保留支持未提交二进制，也支持保存后继续修改图片等资产。过程中发现并修复 macOS `/var` 与 `/private/var` 别名导致的重基复制问题。原有路径、符号链接、权限、租约、文件版本、冲突、幂等、托管运行文件及超过 100 文件原子提交保护保持。旧 `asset_publish` 恢复已有 GLB/GDScript 按路径登记；PNG 等其他类型直接进入原生工程，无需扩充旧资产库协议。

## skill 接入

[game-assets/SKILL.md](../skills/game-assets/SKILL.md) 是平台版本化入口，准备会话时投影到 `.agents/skills/game-assets/`。`workspace.json.skills`、会话 AGENTS.md、新建/恢复线程开发者指令及新回合提醒均可发现它；旧会话不必换线程。主 skill 按需路由至：

- [素材来源](../skills/game-assets/references/sources.md)：Kenney、Poly Haven、ambientCG、OpenGameArt、Godot Asset Library，以及 itch.io/Sketchfab 的具体下载与许可边界。
- [制作与导入](../skills/game-assets/references/creation-and-import.md)：Godot 内建几何、Pillow、Blender 后台制作，以及尺寸、PBR、透明、动画、部件绑定和 Web 适配。
- [来源记录](../skills/game-assets/references/provenance.md)：原下载/衍生文件哈希、作者、许可、署名、生成脚本和实际导入结果。
- [文件助手](../skills/game-assets/scripts/asset_files.py)：有界流式下载、ZIP 安全展开、防覆盖、失败清理；仅返回精简文件回执。

Blender 先由创作命令后台导出 GLB，再交给受限 Godot 导入进程。Pillow 缺失时可在本会话 venv 安装。Godot 仍使用现有 headless/Dummy 或明确 `--wa-render` 启动器；此功能不夺取用户桌面输入、打开 App 或发声，不新增自动验收门禁。

## 本次新证据

本轮 98/98 项独立测试及 skill quick_validate 通过，执行命令和证据范围见 `.local/asset-skill-verification/independent-test-results.md`。独立测试覆盖真实 PNG/GLB 字节归档、增改删、连续回合、保存后续改动、101 文件原子资产包及移动 head 冲突，并验证工具回执、附件和历史回放不展开资产。真实 Godot 4.6 通过同一 canonical GameRuntime 加载修改后的 PNG 并实例化 GLB。

skill 实际试用下载了 Khronos 官方样例 GLB/PNG，核实并保存其 Cesium CC-BY-4.0 来源署名；Pillow 12.3.0 绘制透明 PNG，Blender 5.2.1 LTS 后台生成 GLB，Godot BoxMesh 场景绑定这些文件。11 文件通过中央事务一次提交，10,466 字节的 Agent 回执无资产 Base64，真实 Godot 日志输出：

```text
ASSET_SKILL_FORWARD_OK public_glb=1 public_png=1 pillow=1 blender=1 godot_boxmesh=1
```

证据在 `.local/asset-skill-verification/forward-2026-09-10T05-53-00.371Z/`，包含来源、脚本、固定输入、源回执、报告与 canonical-test.log。测试用独立数据，结束关闭并删除临时数据库；这是下载、制作、事务和实际引擎加载证据，没有声称视觉或完整玩法验收。

正式服务在确认无活动 Agent、构建、世界后，由 PID 38359 受控关闭，经 `npm start` 启动 PID 50827；health 返回 `agent_asset_files: true` 和 `creator_skills: ["game-assets"]`，原工作台 HTTP 内容一致。指定会话工作区已刷新为 native_files，并安装 skill；原线程、全部作者文件哈希、分支 head、50 个会话和 415 条消息保持。只读检查与投影回执在 `.local/asset-skill-verification/deployment/`。这次修复没有替换真实坦克资产或发布游戏；原会话可继续其已授权创作。
