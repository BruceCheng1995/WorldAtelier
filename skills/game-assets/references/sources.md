# 公开素材来源与下载

按需读取本文件。以下官方资料核对于 2026-09-10；下载时仍核对具体资产页、许可文件和当前接口，不把搜索摘要当作下载或授权证明。

## 少量候选，完整文件

- 先搜索用途 + 风格 + 格式，例如 `low poly tank glb CC0`、`pixel platformer tileset CC0`；默认比较 3–5 项。
- 先取得标题、作者、资产页、许可、缩略图、尺寸/面数/动画说明和可下载格式。选中后才获取完整文件清单。
- 网络请求在服务器执行，响应或大 JSON 落到 staging；用脚本筛选需要字段后打印摘要。二进制只返回路径、字节数和哈希。
- 小尺寸预览可以帮助选择；预览图不能冒充可用模型，也不能由预览清晰度推断模型质量。
- 保存稳定资产页和实际下载 URL；带时效签名的下载地址失效时回原站重新解析，不反复请求失效地址。
- 保留下载归档与原许可；只导入所需文件及依赖。一个站点不可用时换来源或使用可控制作工具。

## 默认来源

| 来源 | 适合 | 核对和获取方式 |
| --- | --- | --- |
| [Kenney](https://kenney.nl/assets) | 同画风 2D、低模、UI、音频套装 | 从具体资产页下载资源包，读其中许可证；资产页上的游戏素材为 CC0，允许商用、不强制署名。工具和其他商品不能自动套用资产许可。[官方说明](https://kenney.nl/support) |
| [Poly Haven](https://polyhaven.com/) | 写实模型、PBR 材质、HDRI | 先选模型/材质和分辨率，再使用官网或 API 提供的真实文件链接；保存依赖闭包。资产为 CC0。[官方 API 与条款入口](https://polyhaven.com/our-api) |
| [ambientCG](https://ambientcg.com/) | PBR 表面、贴花、地形、部分模型和图片 | 资产文件和资产预览为 CC0，可在游戏中包含原始文件、不强制署名。[许可](https://docs.ambientcg.com/license/)；[API](https://docs.ambientcg.com/api/) |
| [OpenGameArt](https://opengameart.org/) | 像素画、精灵、音效、音乐 | 逐项查看许可及 `Copyright/Attribution Notice`；记录作者指定署名。多许可时选择满足项目用途的一种并记录，不能假定全部 CC0。[官方 FAQ](https://opengameart.org/node/5571) |
| [Godot Asset Library](https://godotengine.org/asset-library/asset) | Godot 插件、着色器、脚本、示例与模板 | 按 Godot 版本、类别和许可筛选，检查来源仓库和具体版本；浏览下载无需登录。[Godot 4.6 官方使用说明](https://docs.godotengine.org/en/4.6/community/asset_library/using_assetlib.html) |

## Poly Haven：资产许可和 API 服务条件

[官方 API 页](https://polyhaven.com/our-api)于 2026-07-18 更新：live API 对个人、学术和商业用途均免费，默认接口不要求登录或 API key。旧文章所述商业 API 付费要求已不适用。

- API 请求设置可识别应用的独有 `User-Agent`，例如 `WorldAtelier-GameAssets/1.0`。
- 产品使用 live API 时向用户明确标注 Poly Haven 来源，例如素材来源栏或 “Powered by Poly Haven”。这是 API 服务条件；资产本身的 CC0 不强制署名。
- `GET https://api.polyhaven.com/assets` 返回资产列表/元数据。该响应可能很大，落盘后按名称、类别、标签筛选，不把全库 JSON 打进上下文。
- `GET https://api.polyhaven.com/files/{id}` 返回不同分辨率/格式的下载链接、大小、哈希及所需依赖。
- 只选择当前用途所需变体；小道具不要默认下载最高分辨率贴图或 HDRI。
- 不凭文件名猜下载 URL；使用接口当次返回的链接并核对实际下载结果。

## ambientCG：限制结果和字段

[v3 `/api/v3/assets` 文档](https://docs.ambientcg.com/api/v3/assets/)支持 `q`、`type`、`id`、`limit`、`offset`、`include` 等参数。

- `limit` 允许 1–500，缺省会给 100 条；搜索显式用 `limit=5`，按需分页。
- 先选 `include=title,url,dimensions,thumbnails`，需要时加 `maps`、`shortDescription`；避免长描述与完整统计。
- 选中资产后用 `id=<资产ID>&include=downloads,maps,dimensions` 获取具体文件。
- `type` 可选 `material`、`3d-model`、`plain-image`、`decal`、`atlas`、`hdri` 等；无效值会导致零结果。
- 可从官网搜索页复制查询参数到 API。示例：`https://ambientcg.com/api/v3/assets?type=material&q=sand&limit=5&include=title,url,dimensions,thumbnails`。
- 下载链接必须取当前返回数据；接口是个人维护的服务，失败时保留已下载文件并适度重试。[维护边界](https://docs.ambientcg.com/api/)

## 可选来源和现实边界

- [itch.io](https://itch.io/game-assets)：按具体作者页面确认许可。`$0 or Donate` 可通过官方跳过捐款入口免费下载；`No payments` 全文件免费；其他定价方式下单独文件可能有额外价格。“Name your own price”不能证明所有文件可免费取得。[价格规则](https://itch.io/docs/creators/pricing)
- [Sketchfab Download API](https://sketchfab.com/developers/download-api)：下载要求用户账户认证，API 提供 glTF、GLB、USDZ，不提供原始 FBX/OBJ。先确认模型可下载及具体 Creative Commons 许可；只有浏览权限时换其他来源，不绕过认证。
- 普通图片搜索用于找到原站。没有明确复用许可的新闻图、作品展示图、游戏截图不能直接作为可发布素材。

## 许可选择与 Godot 包接入

- “免费”是价格，“公开”是可访问性；项目使用、修改、分发和署名条件看具体许可。
- 默认优先 CC0 或能满足署名要求的许可。保留原作者、许可版本、来源和修改说明；CC0 也记录出处，便于恢复和去重。
- CC-BY 按要求署名；含 SA、NC、ND 或自定义条款时核对是否适合实际项目用途。许可不明优先换有明确许可的等效资产，避免无必要地打断用户。
- Godot 包区分完整模板与可安装插件：阅读文件清单，只合入必要目录和依赖；不得覆盖当前 `project.godot` 或无检查启用整个插件包。
- Godot Asset Library 中的版本标签是筛选依据，实际仍检查当前引擎、GDScript/C#/GDExtension、导出平台及附带美术的独立许可。
