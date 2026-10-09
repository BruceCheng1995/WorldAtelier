# 世界工坊应用图标

当前使用 `world-atelier-site-v5` 与 `world-atelier-admin-v5`，2026-09-09 按用户“实际显示很小，看不清细节”修订为粗体英文 WA（World Atelier）字母标记。通过内置 imagegen 生成，提示词在同目录；PNG 源图保留，16 / 32 / 64 / 128px 版本使用 macOS sips 等比缩放。

- **主站：深绿底、浅薄荷色 WA。** 字母加高、笔画加粗，扩大 W 间隙和 A 开口；以 16px 可识读为目标。
- **后台：琥珀底、深紫色 WA。** 沿用同一字形，以明暗反转和暖色块区别主站，不增加小场景或细小标识。

`../index.html` 明确提供主站 16 / 32 / 64px 三个 PNG favicon；64px 的链接保留 `#atelierFavicon` ID。`#workspaceHome .atelier-app-icon` 嵌入主站 128px PNG。

`../admin.html` 与 `../admin-login.html` 共用后台 16 / 32 / 64px favicon 和 128px `.brand-symbol`。页面品牌图为装饰图，不改变链接、按钮的可访问名称或导航行为。

小图使用 data URI，沿用原服务静态页面读取方式，无需增加路由或重启工作台。更新时同步三个页面中的嵌入引用；浏览器可选择对应分辨率，128px 用于页面品牌。验图时使用实际 16 / 32px 尺寸，不以放大的源图替代小尺寸观察。

`world-atelier-flat-v2*`、通用 SVG、`v3` 字形方案与 `v4` 场景图为历史探索，当前页面不再引用。

Chrome 中被 Codex 接管的标签可能被工具层临时叠加箭头（`data-codex-favicon-badge`），核对页面源码与 `data-codex-original-favicon-href` 可区分工具标记和站点图标。
