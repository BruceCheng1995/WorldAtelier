import { createHash } from 'node:crypto';
export const MAX_GLB_BYTES = 20 * 1024 * 1024;
export function inspectGLB(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 28 || bytes.length > MAX_GLB_BYTES) throw new Error('模型文件须为 28 字节至 20 MB 的 GLB');
  if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error('无效的 GLB 2.0 文件头或文件长度');
  let at = 12, json = null, binaryLength = 0, chunks = 0;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) throw new Error('GLB 数据块不完整');
    const length = bytes.readUInt32LE(at), type = bytes.readUInt32LE(at + 4);
    if (length % 4 || at + 8 + length > bytes.length) throw new Error('GLB 数据块边界无效');
    if (chunks === 0 && type !== 0x4e4f534a) throw new Error('GLB 首块必须为 JSON');
    if (type === 0x4e4f534a) {
      if (json || length > 4 * 1024 * 1024) throw new Error('GLB JSON 数据块无效');
      try { json = JSON.parse(bytes.subarray(at + 8, at + 8 + length).toString('utf8').trim()); } catch { throw new Error('GLB JSON 解析失败'); }
    } else if (type === 0x004e4942) { if (binaryLength) throw new Error('GLB 包含重复二进制块'); binaryLength = length; }
    else throw new Error('暂不支持该 GLB 数据块');
    chunks++; at += 8 + length;
  }
  if (json?.asset?.version !== '2.0' || !Array.isArray(json.meshes) || !json.meshes.length || !binaryLength) throw new Error('GLB 必须包含可渲染的网格与二进制数据');
  if ((json.nodes?.length ?? 0) > 20000 || json.meshes.length > 5000) throw new Error('模型节点数量超出预览上限');
  for (const part of [...(json.buffers ?? []), ...(json.images ?? [])]) if (part.uri != null) throw new Error('请导出嵌入纹理和网格的独立 GLB；不支持外部文件引用');
  if (json.buffers?.length !== 1 || !Number.isSafeInteger(json.buffers[0].byteLength) || json.buffers[0].byteLength <= 0 || json.buffers[0].byteLength > binaryLength) throw new Error('GLB buffer 长度无效');
  for (const view of json.bufferViews ?? []) {
    const offset = view.byteOffset ?? 0;
    if (view.buffer !== 0 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(view.byteLength) || view.byteLength < 1 || offset + view.byteLength > json.buffers[0].byteLength) throw new Error('GLB bufferView 越界');
  }
  return { hash: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, meshes: json.meshes.length, nodes: json.nodes?.length ?? 0, materials: json.materials?.length ?? 0 };
}
