import { DatabaseSync, backup } from "node:sqlite";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { resolve, join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../services/control-plane/content.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...values] = process.argv.slice(2);
const args = Object.fromEntries(
  values.map((value) => {
    const [key, ...rest] = value.replace(/^--/, "").split("=");
    return [key, rest.join("=")];
  }),
);
const hex = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const runtimeRoot = resolve(
  args["runtime-root"] ?? join(root, ".local/artifacts"),
);
function fresh(path) {
  if (existsSync(path))
    throw Error("Destination already exists; choose a new directory: " + path);
  mkdirSync(path, { recursive: true });
}
function inside(base, path) {
  const result = resolve(base, path);
  if (result !== base && !result.startsWith(base + "/"))
    throw Error("Invalid backup path");
  return result;
}
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const value = join(path, entry.name);
    if (entry.isSymbolicLink())
      throw Error("Unexpected symlink in immutable artifacts");
    return entry.isDirectory() ? files(value) : [value];
  });
}
function copy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

if (command === "create") {
  if (!args.data || !args.out)
    throw Error("create requires --data=SERVER_DATA --out=NEW_BACKUP");
  const data = resolve(args.data),
    destination = resolve(args.out),
    stage = destination + ".preparing";
  if (existsSync(destination)) throw Error("Backup already exists");
  fresh(stage);
  const database = join(data, "world-atelier.sqlite");
  if (!existsSync(database)) throw Error("Server database missing");
  const source = new DatabaseSync(database, { readOnly: true });
  mkdirSync(join(stage, "data"), { recursive: true });
  try {
    await backup(source, join(stage, "data/world-atelier.sqlite"));
  } finally {
    source.close();
  }
  const snapshot = new DatabaseSync(join(stage, "data/world-atelier.sqlite"), {
    readOnly: true,
  });
  const rows = (kind) =>
    snapshot
      .prepare("SELECT body FROM documents WHERE kind=?")
      .all(kind)
      .map((r) => JSON.parse(r.body));
  const assets = rows("asset"),
    releases = rows("release"),
    worlds = rows("world");
  snapshot.close();
  for (const asset of assets) {
    if (!hex(asset.hash)) throw Error("Invalid asset identity");
    const path = join(data, "objects", asset.hash);
    if (digest(readFileSync(path)) !== asset.hash)
      throw Error("Asset integrity failure");
    copy(path, join(stage, "data/objects", asset.hash));
  }
  for (const release of releases) {
    if (!hex(release.content_hash)) throw Error("Invalid release identity");
    const path = join(data, "artifacts", release.content_hash, "content.json");
    if (digest(readFileSync(path)) !== release.content_hash)
      throw Error("Content integrity failure");
    copy(
      path,
      join(stage, "data/artifacts", release.content_hash, "content.json"),
    );
  }
  const runtimes = [...new Set(releases.map((r) => r.runtime_hash))];
  for (const hash of runtimes) {
    if (!hex(hash)) throw Error("Invalid runtime identity");
    const source = join(runtimeRoot, hash);
    for (const path of files(source))
      copy(path, join(stage, "runtimes", hash, relative(source, path)));
  }
  const manifest = {
    format: 1,
    created_at: Date.now(),
    worlds: worlds.map((w) => ({
      id: w.id,
      release_id: w.release_id,
      epoch: w.epoch,
      sequence: w.durable_sequence,
      tick: w.state?.tick,
    })),
    runtimes,
    files: files(stage).map((path) => ({
      path: relative(stage, path),
      bytes: lstatSync(path).size,
      sha256: digest(readFileSync(path)),
    })),
  };
  writeFileSync(join(stage, "backup.json"), JSON.stringify(manifest, null, 2));
  renameSync(stage, destination);
  console.log(
    JSON.stringify({
      ok: true,
      backup: destination,
      worlds: manifest.worlds,
      files: manifest.files.length,
    }),
  );
} else if (command === "restore") {
  if (!args.from || !args.data)
    throw Error("restore requires --from=BACKUP --data=NEW_SERVER_DATA");
  const source = resolve(args.from),
    destination = resolve(args.data),
    stage = destination + ".restoring";
  if (existsSync(destination))
    throw Error("Restore never overwrites an existing server database");
  const manifest = JSON.parse(
    readFileSync(join(source, "backup.json"), "utf8"),
  );
  if (manifest.format !== 1 || !Array.isArray(manifest.files))
    throw Error("Unknown backup format");
  for (const file of manifest.files) {
    const path = inside(source, file.path);
    if (lstatSync(path).isSymbolicLink())
      throw Error("Backup symlink rejected");
    const bytes = readFileSync(path);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
      throw Error("Backup integrity failure: " + file.path);
  }
  fresh(stage);
  for (const file of manifest.files.filter((f) => f.path.startsWith("data/")))
    copy(inside(source, file.path), inside(stage, file.path.slice(5)));
  mkdirSync(runtimeRoot, { recursive: true });
  for (const hash of manifest.runtimes) {
    if (!hex(hash)) throw Error("Invalid runtime identity");
    const runtime = join(runtimeRoot, hash),
      entries = manifest.files.filter((f) =>
        f.path.startsWith("runtimes/" + hash + "/"),
      );
    if (existsSync(runtime)) {
      for (const file of entries) {
        const path = inside(
          runtime,
          file.path.slice(("runtimes/" + hash + "/").length),
        );
        if (!existsSync(path) || digest(readFileSync(path)) !== file.sha256)
          throw Error("Existing immutable runtime differs from backup");
      }
    } else {
      const candidate = runtime + ".restoring";
      fresh(candidate);
      for (const file of entries)
        copy(
          inside(source, file.path),
          inside(candidate, file.path.slice(("runtimes/" + hash + "/").length)),
        );
      renameSync(candidate, runtime);
    }
  }
  renameSync(stage, destination);
  console.log(
    JSON.stringify({
      ok: true,
      data: destination,
      runtimes: manifest.runtimes,
      worlds: manifest.worlds,
    }),
  );
} else
  throw Error(
    "Usage: node tools/backup.mjs create --data=PATH --out=NEW_PATH | restore --from=PATH --data=NEW_PATH [--runtime-root=PATH]",
  );
