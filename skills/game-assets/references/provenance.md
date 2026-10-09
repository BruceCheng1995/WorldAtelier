# 资产来源与导入回执

仅为实际使用的资产留记录，遵循已有工程目录；新项目可用 `assets/provenance/<asset-id>.json` 和对应许可文本。不要将整个检索目录、网页登录数据、签名下载凭据或私人对话提交进游戏。

一个模型与其整套贴图可以共用一条记录；不同作者或许可证的组件分开说明。示例字段（按实际情况裁剪，不能把占位符当事实）：

```json
{
  "name": "资产名",
  "source_url": "具体资产页面的永久链接",
  "author": "原作者",
  "license_id": "CC0-1.0 / CC-BY-4.0 / MIT / 该资产实际许可",
  "license_url": "原站或正式许可文本链接",
  "license_file": "assets/provenance/example-LICENSE.txt",
  "attribution": "实际要求的署名文本；无强制要求可留空",
  "retrieved_at": "ISO 8601 时间",
  "original": {"sha256": "原下载文件SHA256", "bytes": 123, "filename": "model.zip"},
  "files": [{"path": "assets/models/example.glb", "sha256": "导入文件SHA256", "role": "model"}],
  "modifications": ["实际完成的尺寸/减面/材质/格式变化"],
  "generator": {"script": "tools/build_example.py", "tool_version": "实际安装版", "parameters": {}},
  "dimensions": {"units": "m", "aabb_size": [1, 1, 1]},
  "dependencies": ["assets/textures/example_albedo.png"],
  "target_resource": "res://prefabs/example.tscn"
}
```

网络资产没有 generator 可删该项；自制资产写 `origin: "procedural"` 并记录真实脚本、参数和产物，不能假称下载自公开库。混合/衍生资产保留原作者与许可证，不因脚本加工就声称原创或改成 CC0。

CC BY 等需要署名时，把相应信息并入游戏已有 credits/第三方许可文件，确保随实际交付可访问。多许可条目写清选用哪一个及其条件；许可不清或与用途冲突时先找清楚的替代，不凭“免费”推断授权。

回合的检查结果、日志和保存版本放本会话 `outputs/`，避免提交后为写 revision 反复制造新源版本。对话可用一条短收据：

```text
资产 → 来源/许可 → res:// 路径 → SHA256 → 导入与绑定结果
源稿：实际保存 revision；检查：实际运行项；未完成：具体事项
```

`sha256` 来自实际文件字节，不能由文件名推断。原下载哈希与转换后的哈希分开；外部 URL 可能变化，不能把 URL 当固定源版本。预览图证明外观，headless 导入证明可加载，各自如实记录。
