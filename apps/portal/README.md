# 世界工坊网页入口

Vue 3 / Vite 的中文协作开发入口，装载真实 Godot Web 发行产物。没有 Three.js 游戏替代层，也没有伪造的运行确认。

## 启动与构建

在工程根目录安装依赖，然后：

```sh
npm --prefix apps/portal install
npm --prefix apps/portal run build
```

生产构建由中央服务直接提供。独立开发时：

```sh
WORLD_ATELIER_API=http://127.0.0.1:48900 npm --prefix apps/portal run dev
```

Vite 默认监听 `127.0.0.1:48910`，代理 API、版本产物、受权限控制的内容和游戏 WebSocket。页面使用本机字体，无外部字体/CDN 依赖。

## 已实现的流程

- 注册、登录、工程创建、成员角色、分支创建与内容合并。
- 大画幅 Godot 游戏区域、辅助输入按钮、独立世界选择、分支跳转。
- 源码 head、可玩发行与所选世界实际发行分别显示；游戏正在运行的分支显示在游戏工具栏。
- 对象检查器、坐标/缩放/颜色/碰撞编辑、玩法规则、对象创建与删除、提交说明。
- 浏览器草稿保留基础提交；并发冲突保留本地修改；读取最新版前保留一份本地备份。
- 离线工作区下载与 JSON 上传。服务器提供的发行/状态种子保留在下载包中；上传只提交内容与基础版本，不提交玩法进度。
- 实际构建记录轮询，构建与世界应用分开操作。维护任务与对象/分支绑定；“已交付”只能来自服务端验证应用证据。
- 桌面固定发行清单与对应产物下载链接。

## 游戏接入与证据边界

先锁定 checkout，流式下载该发行的 Web 产物，逐文件校验 SHA-256，然后 prepare-join。界面只展示真实字节进度。

目标 iframe 在原游戏仍保留时启动。只有来自该 iframe 窗口、符合其 origin、且 `world_id/release_id` 均匹配的真实 `active` telemetry 才切换为当前世界。iframe 加载完成不等于世界进入成功；错误不会伪造 ACK。热更新是否成功还需要服务端和真实 Godot 客户端测试。

辅助输入只发送 `{source:'world-atelier-portal',type:'command',action,payload}`，不设置游戏状态。键位提示与运行端一致：WASD 移动、Space 攻击、Shift 闪避、E 交互；运行端还支持 Q 升级与 Tab 地图。

## 真实 UI 验收

先另启隔离端口和数据目录的中央服务，再将 Vite 指向该端口。使用工程根目录已有的 Playwright 依赖：

```sh
PORTAL_URL=http://127.0.0.1:48932 \
PORTAL_EVIDENCE=/absolute/path/to/isolated/evidence \
node apps/portal/tests/ui-smoke.mjs
```

测试通过 UI 创建两名真实用户与工程，验证成员权限、同对象并发冲突和草稿保留、分支隔离、离线内容导入、任务状态、伪造消息拒绝、权限降级及移动尺寸。它使用实际中央服务，不拦截或模拟响应。它不替代真实游戏、导出客户端、多人玩法与 VFX 的完整端到端验收。
