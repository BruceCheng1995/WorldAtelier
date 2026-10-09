# 可控制作、适配与导入

按当前任务选择相关段落。具体工程路径、源事务和发布边界遵循主 skill；这里的规格建议是起点，按镜头和真实运行结果调整。

## 工具与后台运行

- 先读 `workspace.json`，使用它声明的 Godot `engine.executable` 和可编辑工程；检查 Python、Pillow、Blender 的实际版本。
- 缺少 Pillow 时可在本会话创建 venv 并安装依赖；不要修改系统 Python，也不要把缺依赖解释成禁止制作资产。
- 以下从本会话目录运行，实际版本与安装结果写入生成记录；已有可用环境时直接复用：

```sh
python3 -m venv outputs/asset-tools/venv
outputs/asset-tools/venv/bin/python -m pip install Pillow
outputs/asset-tools/venv/bin/python outputs/asset-staging/draw_assets.py
```

- World Atelier 无人值守 Godot 检查默认 headless，启动器强制 Dummy 音频；必要画面检查只用同一启动器的 `--wa-render` 后台模式、有限帧数和脚本内输入，读取保存图片。
- 不打开/激活 Godot App，不注入桌面键鼠，不用普通、最小化或屏外窗口兜底，不发声。保留游戏本身的玩家输入和音频代码。

## Godot 原生几何

- `MeshInstance3D` 配合 `BoxMesh`、`CylinderMesh`、`SphereMesh` 等，适合地台、墙、简单机械和可见碰撞代理；尺寸和材料成为原生可编辑资源。
- 需要布尔交并差时使用简单 CSG。按独立物件拆树，只对需要切割的部分做布尔；定型后考虑烘焙成 `MeshInstance3D`，保留可编辑来源。
- 参数化道路、地形、轮廓适合 `ArrayMesh` / `SurfaceTool`。明确顶点绕序、法线、UV、索引与材质；`SurfaceTool` 可生成法线和索引。
- 静态几何生成一次并保存，不在每帧重建；`ImmediateMesh` 适合少量动态/调试几何。大量重复同一网格可考虑 `MultiMesh`。
- 可见模型与物理碰撞分开设计；运动物体优先简单形状/凸碰撞，避免直接使用高面数渲染模型作为复杂碰撞。
- 来源：[原生几何](https://docs.godotengine.org/en/4.6/tutorials/3d/procedural_geometry/index.html)、[CSG 与烘焙](https://docs.godotengine.org/en/4.6/tutorials/3d/csg_tools.html)。CSG 教程带未全面更新至 4.6 提示，具体 API 以当前引擎为准。

## Pillow 绘图

- 保存生成脚本、画布尺寸、调色板、随机种子和输出路径，使精灵、图标、蒙版、规则贴图可以复现和修改。
- 透明 PNG 明确使用 RGBA；直接向 RGBA 画布绘制半透明色是替换该像素，不会自动与原图混合。使用独立图层和 `Image.alpha_composite`：

```python
from PIL import Image, ImageDraw
base = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
ImageDraw.Draw(layer).ellipse((32, 32, 224, 224), fill=(255, 180, 60, 180))
result = Image.alpha_composite(base, layer)
result.save("outputs/asset-staging/glow.png")
```

- 像素图保持整数网格，缩放用 nearest；普通图形需要平滑边缘时可大画布制作后高质量缩小。
- sprite sheet 保持每帧尺寸、角色落点和留白一致，记录帧序/FPS/循环；atlas 留 padding，按真实过滤和缩放检查串色。
- 在深浅底色上查看少量预览，检查透明边和裁剪；不要调用 `Image.show()` 打开桌面应用。
- 来源：[Pillow ImageDraw、RGBA 与合成](https://pillow.readthedocs.io/en/stable/reference/ImageDraw.html)、[Image 缩放与保存](https://pillow.readthedocs.io/en/stable/reference/Image.html)。

## Blender 后台建模和转换

- 先用安装版 `--version`、`--help` 核对选项；Python API 和 glTF exporter 参数也按安装版本检查，不把网上示例的参数直接视为可用。
- 已确认的后台调用形式如下；替换为真实可执行文件和本会话脚本绝对路径，日志重定向到本会话文件：

```sh
<blender-executable> --background --factory-startup --disable-autoexec --python-exit-code 1 --python <absolute-script.py>
```

- 由 Agent 编写可审阅脚本创建/转换资产；下载的 `.blend` 是输入资料，不启用其自动脚本。`--python` 执行的是明确指定的脚本。
- 记录单位、目标尺寸、轴向、部件名称、原点/挂点、材质和随机种子；生成完成保留脚本及必要 `.blend`，输出 GLB 供游戏导入。
- GLB 导出前应用合适的变换，确定三角化与法线，检查 UV 和贴图路径；节点材质使用 glTF 可表达的 PBR，复杂程序纹理按需烘焙。
- 动画保留 rest pose、需要的骨骼和片段；检查动作范围与循环。机械模型保留炮塔/炮口等独立变换节点，不能合并后丢失玩法挂点。
- 来源：[命令行参数](https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html)、[glTF 导出](https://docs.blender.org/manual/en/latest/addons/import_export/scene_gltf2.html)。官方网页不可抓取时以本机帮助和实际 API 为准。

## Godot 导入规格

- 首选 GLB/glTF；`.gltf` 必须保留 `.bin` 和贴图等相对依赖。OBJ 不适合骨骼/动画/PBR。Godot 4.6 的 FBX 默认使用 ufbx，并非总要安装 FBX2glTF。
- `.blend` 直接导入依赖服务器安装 Blender，而且该 Godot 执行环境必须允许调用它。World Atelier 的受限 Godot 导入进程默认禁止子进程，优先由创作命令后台导出 GLB；把 `.blend` 编辑源保存在会话 staging，或使用工程已有的不参与导入的源文件管理方式。Web 浏览器不能启动 Blender，不影响服务器先转换再构建。
- 导入后检查 AABB/真实高度、原点和部件位置。Godot 是 Y-up；相机前方为 -Z，有朝向模型的约定正面为 +Z，不能混为一谈。
- 将导入美术包在现有原生场景/预制件中，设置必要引用、材质覆盖和碰撞；避免直接改会被重新导入覆盖的生成结果。
- 来源：[支持格式](https://docs.godotengine.org/en/4.6/tutorials/assets_pipeline/importing_3d_scenes/available_formats.html)、[尺寸方向与导出约定](https://docs.godotengine.org/en/4.6/tutorials/assets_pipeline/importing_3d_scenes/model_export_considerations.html)。

## 材质、图片和 Web

- PBR 通道必须对应：颜色图按颜色处理，normal/roughness/metallic/AO 按数据处理；ORM 为 R=AO、G=roughness、B=metallic。gloss 不是 roughness，必要时反相。
- Godot 法线采用 OpenGL 约定；DirectX 法线需反转 Y。检查法线贴图导入标记、UV、材质槽和依赖完整性。
- 带 alpha 的图片不会自动令 3D 材质透明：草叶/栅栏可用 Alpha Scissor，半透明 VFX 才用 Alpha；控制透明叠层和不必要双面渲染。
- 3D 通常启用 mipmap 和适用平台的 VRAM 压缩；像素图避免有损压缩，并检查 nearest 过滤。2D 是否生成 mipmap 看实际缩放需要。
- 透明边优先检查 Fix Alpha Border；使用预乘 alpha 必须匹配材质混合模式。PNG 文件小不代表显存占用小。
- 来源：[材质和透明](https://docs.godotengine.org/en/4.6/tutorials/3d/standard_material_3d.html)、[图片导入](https://docs.godotengine.org/en/4.6/tutorials/assets_pipeline/importing_images.html)。
- Web 目标使用 Compatibility/WebGL2；不要默认素材、shader、C# 插件或原生扩展都能在浏览器工作。GDExtension 需专门的 Web 构建和相应导出配置。
- 初次可选低模与 1K/2K 贴图，再按镜头提高；减少无用材质槽、超高面数、透明大面积叠层和不需要的动画。数值是预算起点，不是统一硬限制。
- 选择相称检查：导入可加载，模型在真实目标场景出现，尺寸/朝向/材质正确；涉及动画、碰撞、机械部件时检查它们。必要时验证实际 Web 构建外观和加载，不把 headless 成功当视觉证明。
- 来源：[Godot 4.6 Web 导出与限制](https://docs.godotengine.org/en/4.6/tutorials/export/exporting_for_web.html)。
