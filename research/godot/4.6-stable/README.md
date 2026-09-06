# Godot 官方源码研究资料

此资料来自此前按用户要求下载的官方源码，作为新工程的外部技术参考保留；不属于被废弃的两套应用代码，也不证明新工程已有游戏功能。

- 官方仓库：<https://github.com/godotengine/godot>
- 固定标签：`4.6-stable`
- 提交：`89cea143987d564363e15d207438530651d943ac`
- 已核对的本机版本：`4.6.stable.official.89cea1439`
- 原始下载：[官方完整源码归档](https://codeload.github.com/godotengine/godot/tar.gz/89cea143987d564363e15d207438530651d943ac)
- 压缩包：65,700,229 bytes；SHA-256：`4387f22b1ef3ad9efd34ba0cd8075b0c3f192ddb3fc2ad7e400c9c44145900ad`
- 本地源码：[source/README.md](source/README.md)，完整解压约 331 MB，不含 Git 历史。
- [原始许可证](source/LICENSE.txt) 与第三方声明原样保留；[文件校验记录](source-manifest.json) 保存此前源码定位文件的哈希。

## 对新工程有效的技术结论

1. 新建 GDScript 可在运行时解析/编译；不要把直接覆盖活跃脚本及 `reload(true)` 当成通用迁移事务。[脚本加载](https://github.com/godotengine/godot/blob/89cea143987d564363e15d207438530651d943ac/modules/gdscript/gdscript.cpp#L739-L865)
2. 编译后会执行静态初始化，实例化/入退树也可产生副作用；离树不是强隔离。[静态初始化](https://github.com/godotengine/godot/blob/89cea143987d564363e15d207438530651d943ac/modules/gdscript/gdscript.cpp#L884-L903)
3. 部分 GDScript 运行错误不会变成向外传播的通用异常，外层仍可继续；不能仅凭 `{ok:true}` 生成成功回执。[VM 错误出口](https://github.com/godotengine/godot/blob/89cea143987d564363e15d207438530651d943ac/modules/gdscript/gdscript_vm.cpp#L3948-L4027)
4. 4.6 提供 `Logger` / `OS.add_logger`，但它只能记录已产生的错误；回调要考虑多线程。debug/release 会条件编译不同检查。[Logger](https://github.com/godotengine/godot/blob/89cea143987d564363e15d207438530651d943ac/core/core_bind.cpp#L220-L280) · [构建条件](https://github.com/godotengine/godot/blob/89cea143987d564363e15d207438530651d943ac/SConstruct#L518-L546)
5. 资源 REPLACE 可能原地改变共用资源，UID 可能指回旧路径；需要整个依赖集合版本化。[资源复用](https://github.com/godotengine/godot/blob/89cea143987d564363e15d207438530651d943ac/core/io/resource_loader.cpp#L418-L452)
6. `call_deferred` 与 `queue_free` 不提供事务或无重入保证；物理属性回读也不等于求解已经应用。[物理阶段](https://github.com/godotengine/godot/blob/89cea143987d564363e15d207438530651d943ac/main/main.cpp#L4838-L4920)
7. glTF 运行时加载和专用服务器路径可用作基础；桌面、Web、debug/release 各目标需实际导出验收。[glTF 注册](https://github.com/godotengine/godot/blob/89cea143987d564363e15d207438530651d943ac/modules/gltf/register_types.cpp#L106-L155)
8. 内建 GDExtension 重载要求工具构建；新方案对宿主/引擎升级采用匹配客户端下载与会话接续，不承诺任意二进制原地替换。[原生扩展重载限制](https://github.com/godotengine/godot/blob/89cea143987d564363e15d207438530651d943ac/core/extension/gdextension_manager.cpp#L154-L206)

此前原生机制与 Logger 探针属于旧工程历史研究。本次从零重建后，新的状态、同步、客户端与交接必须重新验证；没有复制旧应用或旧测试脚本作为新实现。
