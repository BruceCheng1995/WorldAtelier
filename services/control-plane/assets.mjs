import { readFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "./content.mjs";

export function materializeContent(store, data, project_id, source) {
  const content = structuredClone(source),
    refs = new Map();
  for (const object of content.objects)
    if (object.model_asset) refs.set(object.model_asset, "model/gltf-binary");
  for (const behavior of content.behaviors ?? [])
    refs.set(behavior.asset_hash, "text/x-gdscript");
  let total = 0;
  content.asset_blobs = {};
  for (const [hash, mime] of refs) {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
      throw Error("Invalid content asset hash");
    const asset = store.get("asset", project_id + ":" + hash);
    if (!asset || asset.mime !== mime)
      throw Error(
        "Content references an unavailable or incompatible project asset",
      );
    const bytes = readFileSync(join(data, "objects", hash));
    if (digest(bytes) !== hash) throw Error("Stored asset integrity failure");
    total += bytes.length;
    if (total > 8_000_000) throw Error("Content asset bundle exceeds 8 MB");
    content.asset_blobs[hash] = { mime, data_base64: bytes.toString("base64") };
  }
  return content;
}

export function releaseContent(data, release) {
  const bytes = readFileSync(
    join(data, "artifacts", release.content_hash, "content.json"),
  );
  if (digest(bytes) !== release.content_hash)
    throw Error("Release content integrity failure");
  return JSON.parse(bytes.toString("utf8"));
}
