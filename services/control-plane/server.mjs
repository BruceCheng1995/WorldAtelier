import { clientAddress } from "./address.mjs";
import {
  objectAt,
  objectHash,
  objectHistory,
  reachableRevision,
  taskEvent,
} from "./object-history.mjs";
import http from "node:http";
import { WebSocketServer } from "ws";
import {
  randomUUID,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  readFileSync,
  existsSync,
  createReadStream,
  statSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { resolve, join, extname, dirname, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Storage } from "./storage.mjs";
import { validateContent, mergeContent, digest } from "./content.mjs";
import { releaseContent, materializeContent } from "./assets.mjs";
import { Builds } from "./builds.mjs";
import { Worlds } from "../world-orchestrator/worlds.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Retained only for historical protocol tests, never as a second product server.
const port = Number(process.env.WORLD_ATELIER_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535 ||
    [48900, 48910].includes(port) || !process.env.WORLD_ATELIER_DATA) {
  console.error("中央门户已退役。请运行 npm start，打开 http://127.0.0.1:48910/creation-workspace.html。历史协议测试必须显式指定独立 WORLD_ATELIER_PORT 和 WORLD_ATELIER_DATA。");
  process.exit(1);
}
function canonicalPath(path) {
  try { return realpathSync(path); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return join(canonicalPath(dirname(path)), basename(path));
  }
}
const data = resolve(
  process.env.WORLD_ATELIER_DATA,
);
const canonicalData = canonicalPath(data);
for (const protectedPath of [".local/server", ".local/model-preview"]) {
  const protectedData = canonicalPath(join(root, protectedPath));
  if (canonicalData === protectedData || canonicalData.startsWith(protectedData + sep) ||
      protectedData.startsWith(canonicalData + sep)) {
    console.error("历史协议测试不能使用或覆盖正式及历史服务数据，请指定独立 WORLD_ATELIER_DATA。");
    process.exit(1);
  }
}
const publicAddress = clientAddress(port, process.env.WORLD_ATELIER_PUBLIC_URL);
const bindHost = process.env.WORLD_ATELIER_BIND_HOST ?? "127.0.0.1";
const godot =
  process.env.GODOT_BIN ?? "/Applications/Godot.app/Contents/MacOS/Godot";
mkdirSync(data, { recursive: true });
const store = new Storage(join(data, "world-atelier.sqlite"));
const runtimeRoot = resolve(
  process.env.WORLD_ATELIER_RUNTIME_ROOT ?? join(root, ".local/artifacts"),
);
const worlds = new Worlds({ store, root, data, port, godot, runtimeRoot });
const builds = new Builds({
  store,
  root,
  data,
  godot,
  runtimeRoot,
  onTasks: (project_id, branch) => {
    for (const w of store
      .list("world")
      .filter((w) => w.project_id === project_id && w.branch === branch))
      worlds.tasks(w.id);
  },
});
const clients = new Set(),
  controls = new Map(),
  pendingCommands = new Map(),
  pendingHttp = new Map(),
  activationChains = new Map();
const id = (prefix) => prefix + "_" + randomUUID();
const fault = (status, message, details) =>
  Object.assign(Error(message), { status, details });
const publicUser = (u) => ({ id: u.id, name: u.name });
const slug = (value) => {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)
  )
    throw fault(400, "Use a branch name with letters, numbers, - or _");
  return value;
};
const membership = (project, user, write = false) => {
  if (!project) throw fault(404, "Project not found");
  const role = project.members[user.id];
  if (!role) throw fault(403, "Project membership required");
  if (write && !["owner", "editor"].includes(role))
    throw fault(403, "Editor permission required");
  return role;
};
const auth = (req) => {
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const session = store.get("session", digest(token));
  if (!session || session.expires_at < Date.now())
    throw fault(401, "Sign in required");
  const u = store.get("user", session.user_id);
  if (!u) throw fault(401, "Account missing");
  return u;
};
const branchFor = (project_id, name) => {
  const b = store.get("branch", project_id + ":" + name);
  if (!b) throw fault(404, "Branch not found");
  return b;
};
const projectFor = (project_id, user, write = false) => {
  const p = store.get("project", project_id);
  membership(p, user, write);
  return p;
};
function json(res, status, value) {
  if (res.operation) {
    const operation = {
      ...res.operation,
      status: "complete",
      response_status: status,
      response: value,
      finished_at: Date.now(),
    };
    store.put("operation", operation);
    pendingHttp.get(operation.id)?.resolve(operation);
    pendingHttp.delete(operation.id);
    res.setHeader("X-Operation-ID", operation.id);
    res.operation = null;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (Object.hasOwn(req, "parsedBody")) return req.parsedBody;
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 5_000_000) throw fault(413, "Request too large");
  }
  try {
    req.parsedBody = text ? JSON.parse(text) : {};
    return req.parsedBody;
  } catch {
    throw fault(400, "Invalid JSON");
  }
}
function session(user) {
  const token = randomBytes(32).toString("hex");
  store.put("session", {
    id: digest(token),
    user_id: user.id,
    expires_at: Date.now() + 7 * 86400000,
  });
  return { token, user: publicUser(user) };
}
function revision(project_id, content, parents, author, message) {
  const item = {
    id: "rev_" + digest({ project_id, content, parents }).slice(0, 24),
    project_id,
    content,
    parents,
    author,
    message,
    created_at: Date.now(),
  };
  store.put("revision", item);
  return item;
}
function commonAncestor(a, b) {
  const seen = new Set(),
    walk = [a];
  while (walk.length) {
    const key = walk.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    walk.push(...(store.get("revision", key)?.parents ?? []));
  }
  const remote = [b];
  while (remote.length) {
    const key = remote.shift();
    if (seen.has(key)) return store.get("revision", key);
    remote.push(...(store.get("revision", key)?.parents ?? []));
  }
  throw fault(409, "Branches do not have a common base");
}
function commitContent(project, branch, b, user, importing = false) {
  if (importing && (b.project_id !== project.id || b.branch !== branch.name))
    throw fault(409, "Offline workspace belongs to another project or branch");
  validateContent(b.content);
  const base = store.get("revision", b.base_revision);
  if (!base || base.project_id !== project.id)
    throw fault(409, "Unknown workspace base revision");
  const remote = store.get("revision", branch.source_head),
    merged = mergeContent(base.content, b.content, remote.content);
  if (merged.conflicts.length)
    throw fault(409, "Content conflicts require resolution", {
      conflicts: merged.conflicts,
      remote_revision: remote.id,
    });
  validateContent(merged.content);
  const rev = revision(
    project.id,
    merged.content,
    [remote.id],
    user.name,
    b.message ?? "场景编辑",
  );
  branch.source_head = rev.id;
  store.put("branch", branch);
  store.event(project.id, {
    kind: "commit",
    title: b.message ?? "场景编辑",
    branch: branch.name,
    actor: user.name,
    revision: rev.id,
  });
  return { revision: rev.id, content: rev.content, conflicts: [] };
}
async function createWorld(
  project,
  branch,
  name,
  checkpoint = null,
  origin = null,
  release_id = branch.playable_head,
) {
  if (!release_id) throw fault(409, "Build a playable release first");
  const w = {
    id: id("world"),
    project_id: project.id,
    branch: branch.name,
    name: name ?? branch.name + " · 共享世界",
    release_id,
    epoch: 0,
    sequence: 0,
    durable_sequence: 0,
    status: "starting",
    state: checkpoint ? structuredClone(checkpoint) : null,
    state_origin: origin,
    created_at: Date.now(),
  };
  store.put("world", w);
  if (!branch.default_world) {
    branch.default_world = w.id;
    store.put("branch", branch);
  }
  await worlds.start(w);
  return store.get("world", w.id);
}
function sanitizeWorld(w) {
  if (!w) return null;
  return { ...w, state: w.state ?? null };
}
function staticFile(res, path, immutable = false) {
  if (!existsSync(path) || !statSync(path).isFile())
    throw fault(404, "File not found");
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".wasm": "application/wasm",
    ".pck": "application/octet-stream",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".zip": "application/zip",
    ".ico": "image/x-icon",
  };
  res.writeHead(200, {
    "Content-Type": types[extname(path)] ?? "application/octet-stream",
    "Content-Length": statSync(path).size,
    "Cache-Control": immutable
      ? "public,max-age=31536000,immutable"
      : "no-cache",
  });
  createReadStream(path).pipe(res);
}
function inside(base, path) {
  const value = resolve(base, path);
  if (value !== base && !value.startsWith(base + "/"))
    throw fault(403, "Invalid path");
  return value;
}
const server = http.createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`),
      p = url.pathname.split("/").filter(Boolean).map(decodeURIComponent),
      method = req.method;
    if (url.pathname === "/health")
      return json(res, 200, {
        ok: true,
        version: "0.1.0",
        worlds: worlds.hosts.size,
      });
    if (p[0] === "artifacts") {
      if (!/^[a-f0-9]{64}$/.test(p[1] ?? ""))
        throw fault(404, "Artifact not found");
      return staticFile(res, inside(runtimeRoot, p.slice(1).join("/")), true);
    }
    if (p[0] !== "api" && p[0] !== "content") {
      return json(res, 410, {
        error: "中央门户已退役；此服务仅供历史协议测试。",
        workspace_url: "http://127.0.0.1:48910/creation-workspace.html",
      });
    }
    if (p[1] === "auth" && method === "POST") {
      const b = await body(req);
      if (
        typeof b.name !== "string" ||
        b.name.trim().length < 2 ||
        b.name.length > 40 ||
        typeof b.password !== "string" ||
        b.password.length < 8 ||
        b.password.length > 200
      )
        throw fault(
          400,
          "Name must be 2–40 characters; password at least 8 characters",
        );
      const name = b.name.trim();
      let user = store.list("user").find((x) => x.name === name);
      if (p[2] === "register") {
        if (user) throw fault(409, "Name already registered");
        const salt = randomBytes(16).toString("hex");
        user = {
          id: id("user"),
          name,
          salt,
          password_hash: scryptSync(b.password, salt, 64).toString("hex"),
        };
        store.put("user", user);
        return json(res, 201, session(user));
      }
      if (p[2] === "login") {
        if (
          !user ||
          !timingSafeEqual(
            Buffer.from(user.password_hash, "hex"),
            scryptSync(b.password, user.salt, 64),
          )
        )
          throw fault(401, "Incorrect name or password");
        return json(res, 200, session(user));
      }
      throw fault(404, "Unknown authentication route");
    }
    const user = auth(req);
    if (method !== "GET") await body(req);
    if (method !== "GET" && req.headers["idempotency-key"]) {
      const key = String(req.headers["idempotency-key"]);
      if (key.length > 100) throw fault(400, "Idempotency key too long");
      const fingerprint = digest({
          method,
          path: url.pathname,
          body: await body(req),
        }),
        operation_id = digest({ user_id: user.id, key });
      const previous = store.get("operation", operation_id);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw fault(409, "Idempotency key reused with different request");
        const result =
          previous.status === "complete"
            ? previous
            : pendingHttp.has(operation_id)
              ? await pendingHttp.get(operation_id).promise
              : null;
        if (!result)
          throw fault(
            409,
            "Operation outcome needs recovery; inspect original operation",
            { operation_id },
          );
        return json(res, result.response_status, result.response);
      }
      res.operation = {
        id: operation_id,
        user_id: user.id,
        fingerprint,
        status: "running",
        method,
        path: url.pathname,
        created_at: Date.now(),
      };
      store.put("operation", res.operation);
      let finish;
      const promise = new Promise((resolve) => (finish = resolve));
      pendingHttp.set(operation_id, { promise, resolve: finish });
    }
    if (p[1] === "operations" && p[2] && method === "GET") {
      const operation = store.get("operation", p[2]);
      if (!operation || operation.user_id !== user.id)
        throw fault(404, "Operation not found");
      return json(res, 200, { operation });
    }

    if (p[1] === "transfers" && p[2] && method === "GET") {
      const transfer = store.get("transfer", p[2]);
      if (!transfer || transfer.user_id !== user.id)
        throw fault(404, "Transfer not found");
      return json(res, 200, { transfer });
    }
    if (p[1] === "upgrades" && p[2] && method === "GET") {
      const upgrade = store.get("upgrade", p[2]);
      if (!upgrade) throw fault(404, "Upgrade not found");
      projectFor(store.get("world", upgrade.world_id)?.project_id, user);
      return json(res, 200, { upgrade });
    }
    if (p[0] === "content") {
      const rel = store
        .list("release")
        .find(
          (r) =>
            r.content_hash === p[1] &&
            store.get("project", r.project_id)?.members[user.id],
        );
      if (!rel) throw fault(403, "Artifact permission required");
      return staticFile(
        res,
        join(data, "artifacts", rel.content_hash, "content.json"),
        true,
      );
    }
    if (p[1] === "me") return json(res, 200, { user: publicUser(user) });
    if (p[1] === "projects" && p.length === 2) {
      if (method === "GET")
        return json(res, 200, {
          projects: store
            .list("project")
            .filter((x) => x.members[user.id])
            .map((x) => ({ ...x, role: x.members[user.id] })),
        });
      if (method === "POST") {
        const b = await body(req);
        if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 80)
          throw fault(400, "Project name required");
        const path = join(root, "content/world.json");
        if (!existsSync(path))
          throw fault(503, "Game content is not installed yet");
        const content = validateContent(JSON.parse(readFileSync(path, "utf8")));
        const project = {
          id: id("project"),
          name: b.name,
          members: { [user.id]: "owner" },
          created_at: Date.now(),
        };
        store.transaction(() => {
          store.put("project", project);
          const rev = revision(project.id, content, [], user.name, "初始世界");
          store.put("branch", {
            id: project.id + ":main",
            project_id: project.id,
            name: "main",
            source_head: rev.id,
            playable_head: null,
            publish_generation: 0,
            default_world: null,
          });
          store.event(project.id, {
            kind: "project",
            title: "建立世界工程",
            actor: user.name,
          });
        });
        return json(res, 201, { project });
      }
    }
    if (p[1] === "projects" && p[2]) {
      const project = projectFor(
        p[2],
        user,
        method !== "GET" && p[3] !== "checkouts",
      );
      if (p.length === 3 && method === "GET")
        return json(res, 200, {
          project: { ...project, role: project.members[user.id] },
          branches: store
            .list("branch")
            .filter((x) => x.project_id === project.id),
          releases: store
            .list("release")
            .filter((x) => x.project_id === project.id),
          worlds: store
            .list("world")
            .filter((x) => x.project_id === project.id)
            .map((w) => ({ ...w, state: undefined })),
          tasks: store.list("task").filter((x) => x.project_id === project.id),
          builds: store
            .list("build")
            .filter((x) => x.project_id === project.id),
          members: Object.entries(project.members).map(([uid, role]) => ({
            ...publicUser(store.get("user", uid)),
            role,
          })),
          activity: store.activity(project.id),
        });
      if (p[3] === "members" && method === "POST") {
        if (project.members[user.id] !== "owner")
          throw fault(403, "Owner permission required");
        const b = await body(req),
          member = store.list("user").find((u) => u.name === b.name);
        if (!member) throw fault(404, "Collaborator must register first");
        if (
          !["editor", "tester", "viewer"].includes(b.role) ||
          project.members[member.id] === "owner"
        )
          throw fault(400, "Invalid role change");
        project.members[member.id] = b.role;
        store.put("project", project);
        store.event(project.id, {
          kind: "member",
          title: `${member.name} · ${b.role}`,
          actor: user.name,
        });
        return json(res, 200, {
          member: { ...publicUser(member), role: b.role },
        });
      }
      if (p[3] === "members" && p[4] && method === "DELETE") {
        if (project.members[user.id] !== "owner")
          throw fault(403, "Owner permission required");
        const member = store.get("user", p[4]);
        if (!member || !project.members[member.id])
          throw fault(404, "Member not found");
        if (project.members[member.id] === "owner")
          throw fault(400, "Project owner cannot be removed");
        delete project.members[member.id];
        store.put("project", project);
        for (const socket of clients)
          if (
            socket.user.id === member.id &&
            store.get("world", socket.world_id)?.project_id === project.id
          ) {
            releaseClient(socket, "Project access revoked");
            socket.close(1008, "Project access revoked");
          }
        store.event(project.id, {
          kind: "member_removed",
          title: "已撤销 " + member.name + " 的项目访问",
          actor: user.name,
        });
        return json(res, 200, { removed: member.id });
      }
      if (p[3] === "assets" && method === "GET") {
        if (!p[4])
          return json(res, 200, {
            assets: store
              .list("asset")
              .filter((a) => a.project_id === project.id),
          });
        const asset = store.get("asset", project.id + ":" + p[4]);
        if (!asset) throw fault(404, "Asset not found");
        const bytes = readFileSync(join(data, "objects", asset.hash));
        if (digest(bytes) !== asset.hash)
          throw fault(500, "Asset integrity failure");
        return json(res, 200, { asset, data_base64: bytes.toString("base64") });
      }
      if (p[3] === "assets" && method === "POST") {
        const b = await body(req);
        if (
          typeof b.data_base64 !== "string" ||
          typeof b.name !== "string" ||
          b.name.length > 120 ||
          !["model/gltf-binary", "text/x-gdscript"].includes(b.mime)
        )
          throw fault(400, "Invalid asset metadata");
        const bytes = Buffer.from(b.data_base64, "base64");
        if (
          bytes.length < 1 ||
          bytes.length > 2_000_000 ||
          bytes.toString("base64") !== b.data_base64
        )
          throw fault(400, "Invalid asset encoding or size");
        if (
          b.mime === "model/gltf-binary" &&
          (bytes.length < 12 ||
            bytes.toString("ascii", 0, 4) !== "glTF" ||
            bytes.readUInt32LE(4) !== 2 ||
            bytes.readUInt32LE(8) !== bytes.length)
        )
          throw fault(400, "Invalid GLB container");
        if (
          b.mime === "text/x-gdscript" &&
          (bytes.length > 32000 ||
            !bytes.toString("utf8").includes("func evaluate("))
        )
          throw fault(400, "Behavior requires evaluate(context) entry");
        const hash = digest(bytes);
        mkdirSync(join(data, "objects"), { recursive: true });
        const destination = join(data, "objects", hash);
        if (!existsSync(destination))
          writeFileSync(destination, bytes, { flag: "wx" });
        const asset = {
          id: project.id + ":" + hash,
          project_id: project.id,
          hash,
          name: b.name,
          mime: b.mime,
          bytes: bytes.length,
          author: user.name,
          created_at: Date.now(),
        };
        store.put("asset", asset);
        return json(res, 201, { asset });
      }
      if (p[3] === "branches") {
        if (p.length === 4 && method === "POST") {
          const b = await body(req),
            name = slug(b.name),
            from = branchFor(project.id, b.from_branch ?? "main");
          if (store.get("branch", project.id + ":" + name))
            throw fault(409, "Branch exists");
          const branch = {
            ...from,
            id: project.id + ":" + name,
            name,
            default_world: null,
            publish_generation: 0,
            fork_revision: from.source_head,
          };
          store.put("branch", branch);
          store.event(project.id, {
            kind: "branch",
            title: `创建分支 ${name}`,
            actor: user.name,
          });
          return json(res, 201, { branch });
        }
        const branch = branchFor(project.id, p[4]);
        if (
          p[5] === "objects" &&
          p[6] &&
          p[7] === "history" &&
          method === "GET"
        )
          return json(
            res,
            200,
            objectHistory(
              store,
              project,
              branch,
              p[6],
              Math.max(
                1,
                Math.min(100, Number(url.searchParams.get("limit")) || 30),
              ),
            ),
          );
        if (p[5] === "content" && method === "GET") {
          const rev = store.get("revision", branch.source_head);
          return json(res, 200, { revision: rev.id, content: rev.content });
        }
        if (p[5] === "offline" && method === "GET") {
          const rev = store.get("revision", branch.source_head),
            candidate = store.get("release", branch.playable_head),
            release = candidate?.status === "ready" ? candidate : null,
            world = store.get("world", branch.default_world);
          let source_assets = {},
            source_preparation_error = null;
          try {
            source_assets = materializeContent(
              store,
              data,
              project.id,
              rev.content,
            ).asset_blobs;
          } catch (error) {
            source_preparation_error = error.message;
          }
          const seedMatches = !!(
            release &&
            world?.state &&
            world.release_id === release.id
          );
          const stateOrigin = seedMatches
            ? {
                world_id: world.id,
                release_id: release.id,
                epoch: world.epoch,
                sequence: world.durable_sequence,
                schema: release.state_schema ?? 1,
              }
            : null;
          return json(res, 200, {
            format: 1,
            workspace_id: id("workspace"),
            user_id: user.id,
            project_id: project.id,
            branch: branch.name,
            base_revision: rev.id,
            content: rev.content,
            source_assets,
            source_preparation_error,
            release_id: release?.id ?? null,
            release,
            play_content: release ? releaseContent(data, release) : null,
            play_revision: release?.revision ?? null,
            source_ahead_of_playable: rev.id !== release?.revision,
            state_seed: seedMatches ? world.state : null,
            state_seed_release: seedMatches ? release.id : null,
            state_origin: stateOrigin,
            state_seed_reason: seedMatches
              ? "Matching playable world checkpoint"
              : "No world checkpoint matches this playable release; start from its initial state",
            exported_at: Date.now(),
          });
        }
        if (["commit", "import"].includes(p[5]) && method === "POST") {
          const b = await body(req);
          return json(
            res,
            200,
            store.transaction(() =>
              commitContent(project, branch, b, user, p[5] === "import"),
            ),
          );
        }
        if (p[5] === "build" && method === "POST")
          return json(res, 202, {
            build: builds.schedule(project, branch, user, await body(req)),
          });
        if (p[5] === "merge" && method === "POST") {
          const b = await body(req),
            target = branchFor(project.id, b.target ?? "main");
          if (target.id === branch.id)
            throw fault(400, "Choose a different target branch");
          const base = commonAncestor(branch.source_head, target.source_head),
            local = store.get("revision", branch.source_head),
            remote = store.get("revision", target.source_head),
            merged = mergeContent(base.content, local.content, remote.content);
          if (merged.conflicts.length)
            throw fault(409, "Branch merge conflicts", {
              conflicts: merged.conflicts,
            });
          validateContent(merged.content);
          const rev = revision(
            project.id,
            merged.content,
            [target.source_head, branch.source_head],
            user.name,
            `合并 ${branch.name}`,
          );
          target.source_head = rev.id;
          store.put("branch", target);
          store.event(project.id, {
            kind: "merge",
            title: `${branch.name} → ${target.name}`,
            actor: user.name,
          });
          return json(res, 200, { revision: rev.id, branch: target });
        }
      }
      if (p[3] === "worlds" && method === "POST") {
        const b = await body(req);
        let source = null;
        if (b.from_world) {
          source = store.get("world", b.from_world);
          if (!source || source.project_id !== project.id)
            throw fault(403, "Checkpoint source is outside project");
        }
        return json(res, 201, {
          world: await createWorld(
            project,
            branchFor(project.id, b.branch ?? "main"),
            b.name,
            source?.state,
            source
              ? {
                  world_id: source.id,
                  release_id: source.release_id,
                  sequence: source.sequence,
                  epoch: source.epoch,
                }
              : null,
          ),
        });
      }
      if (p[3] === "tasks" && method === "POST") {
        const b = await body(req),
          branch = branchFor(project.id, b.branch ?? "main");
        let base = store.get("revision", b.base_revision ?? branch.source_head),
          observation = null;
        if (b.origin === "live") {
          const world = store.get("world", b.observed_world_id);
          if (
            !world ||
            world.project_id !== project.id ||
            world.branch !== branch.name
          )
            throw fault(403, "Annotation world does not belong to this branch");
          if (world.release_id !== b.observed_release_id)
            throw fault(
              409,
              "Observed world version changed; refresh before annotating",
            );
          base = store.get(
            "revision",
            store.get("release", world.release_id).revision,
          );
          observation = {
            world_id: world.id,
            release_id: world.release_id,
            epoch: world.epoch,
            sequence: world.durable_sequence,
            object_hash: objectHash(base, b.object_id),
          };
          if (
            b.observed_object_hash &&
            b.observed_object_hash !== observation.object_hash
          )
            throw fault(409, "Observed object version changed");
        } else if (
          !base ||
          base.project_id !== project.id ||
          !reachableRevision(store, branch.source_head, base.id)
        )
          throw fault(409, "Annotation base is outside branch history");
        if (!objectAt(base, b.object_id))
          throw fault(400, "Task object not found in the annotated revision");
        if (
          typeof b.title !== "string" ||
          !b.title.trim() ||
          b.title.length > 1000
        )
          throw fault(400, "Task description required");
        const task = {
          id: id("task"),
          project_id: project.id,
          branch: branch.name,
          object_id: b.object_id,
          title: b.title,
          status: "editing",
          author: user.name,
          created_at: Date.now(),
          base_revision: base.id,
          annotation_revision: base.id,
          base_object_hash: objectHash(base, b.object_id),
          origin: observation ? "live" : "source",
          observation,
          cycle: 1,
          history: [],
        };
        taskEvent(store, task, {
          kind: "created",
          status: "editing",
          actor: user.name,
          revision: base.id,
          object_hash: task.base_object_hash,
        });
        for (const w of store
          .list("world")
          .filter(
            (w) => w.project_id === project.id && w.branch === branch.name,
          ))
          worlds.tasks(w.id);
        return json(res, 201, { task });
      }
      if (p[3] === "checkouts" && method === "POST") {
        const b = await body(req),
          branch = branchFor(project.id, b.branch ?? "main"),
          release = store.get("release", b.release_id ?? branch.playable_head);
        if (b.release_id && release?.project_id !== project.id)
          throw fault(403, "Release does not belong to project");
        if (!release || release.status !== "ready")
          throw fault(409, "No healthy playable release yet");
        if (
          !["web", "macos"].includes(b.platform) ||
          !["join-live", "preview-frozen", "offline"].includes(b.mode)
        )
          throw fault(400, "Invalid checkout mode/platform");
        if (!release.artifacts.some((a) => a.platform === b.platform))
          throw fault(409, "This platform has no verified export");
        let world = null;
        if (b.mode === "join-live") {
          world = store.get("world", b.world_id ?? branch.default_world);
          if (
            world &&
            (world.project_id !== project.id || world.branch !== branch.name)
          )
            throw fault(403, "World does not belong to target branch");
          if (!world)
            world = await createWorld(
              project,
              branch,
              undefined,
              null,
              null,
              release.id,
            );
          if (world.release_id !== release.id)
            throw fault(
              409,
              "Selected world and resolved release differ; choose its current release or apply latest",
            );
          if (world.status !== "running") world = await worlds.start(world);
        }
        if (b.mode === "preview-frozen") {
          const original = store.get("world", branch.default_world);
          world = await createWorld(
            project,
            branch,
            `${user.name} · 独立试玩`,
            original?.state,
            original
              ? {
                  world_id: original.id,
                  release_id: original.release_id,
                  sequence: original.sequence,
                  epoch: original.epoch,
                }
              : null,
            release.id,
          );
        }
        const checkout = {
          id: id("checkout"),
          project_id: project.id,
          user_id: user.id,
          branch: branch.name,
          release_id: release.id,
          world_id: world?.id ?? null,
          platform: b.platform,
          mode: b.mode,
          expires_at: Date.now() + 30 * 60000,
        };
        store.put("checkout", checkout);
        return json(res, 201, {
          checkout,
          release,
          artifacts: release.artifacts,
          world: world ? { ...world, state: undefined } : null,
        });
      }
    }
    if (p[1] === "tasks" && p[2] && method === "PATCH") {
      const task = store.get("task", p[2]);
      if (!task) throw fault(404, "Task not found");
      projectFor(task.project_id, user, true);
      const b = await body(req);
      if (!["editing", "testing", "failed"].includes(b.status))
        throw fault(
          400,
          "Delivered status requires a verified world application",
        );
      if (
        b.status === "editing" &&
        ["delivered", "failed"].includes(task.status)
      ) {
        task.cycle = (task.cycle ?? 1) + 1;
        const branch = branchFor(task.project_id, task.branch);
        task.base_revision = branch.source_head;
        task.base_object_hash = objectHash(
          store.get("revision", branch.source_head),
          task.object_id,
        );
        delete task.candidate_build_id;
        delete task.candidate_revision;
        delete task.candidate_release_id;
        delete task.error;
      }
      task.status = b.status;
      taskEvent(store, task, {
        kind: "status",
        status: b.status,
        actor: user.name,
        revision: task.base_revision,
        object_hash: task.base_object_hash,
      });
      for (const w of store
        .list("world")
        .filter(
          (w) => w.project_id === task.project_id && w.branch === task.branch,
        ))
        worlds.tasks(w.id);
      return json(res, 200, { task });
    }
    if (p[1] === "worlds" && p[2]) {
      const w = store.get("world", p[2]);
      if (!w) throw fault(404, "World not found");
      projectFor(w.project_id, user, method !== "GET");
      if (method === "GET") return json(res, 200, { world: sanitizeWorld(w) });
      if (p[3] === "sleep" && method === "POST")
        return json(res, 200, await worlds.sleep(w.id));
      if (p[3] === "apply-latest" && method === "POST") {
        const branch = branchFor(w.project_id, w.branch),
          release = store.get("release", branch.playable_head);
        if (!release) throw fault(409, "No playable release");
        if (release.status !== "ready")
          throw fault(409, "Playable release is not healthy");
        const requested = await body(req);
        if (requested.release_id && requested.release_id !== release.id)
          throw fault(
            409,
            "Playable release changed during preparation; resolve again",
          );
        const runtimeChanged =
          release.runtime_hash !==
          store.get("release", w.release_id).runtime_hash;
        const result = runtimeChanged
          ? await worlds.upgrade(w.id, release)
          : await worlds.apply(w.id, release);
        if (!result.ok)
          throw fault(422, result.error ?? "Authority rejected update");
        for (const task of store
          .list("task")
          .filter(
            (t) =>
              t.project_id === w.project_id &&
              t.branch === w.branch &&
              t.status === "testing",
          )) {
          const base = store
              .get("revision", task.base_revision)
              ?.content.objects.find((o) => o.id === task.object_id),
            current = store
              .get("revision", release.revision)
              .content.objects.find((o) => o.id === task.object_id);
          if (digest(base ?? null) !== digest(current ?? null)) {
            task.status = "delivered";
            task.release_id = release.id;
            task.delivered_release_id = release.id;
            task.delivered_revision = release.revision;
            task.delivered_object_hash = digest(current ?? null);
            task.delivered_world_id = w.id;
            task.applied_sequence = result.sequence;
            taskEvent(store, task, {
              kind: "delivered",
              status: "delivered",
              actor: user.name,
              revision: release.revision,
              release_id: release.id,
              world_id: w.id,
              world_sequence: result.sequence,
              object_hash: task.delivered_object_hash,
            });
          }
        }
        for (const target of store
          .list("world")
          .filter(
            (target) =>
              target.project_id === w.project_id && target.branch === w.branch,
          ))
          worlds.tasks(target.id);
        store.event(w.project_id, {
          kind: "world_applied",
          title: `世界已应用 ${release.id}`,
          world_id: w.id,
          sequence: result.sequence,
        });
        return json(res, 200, {
          ok: true,
          world: store.get("world", w.id),
          sequence: result.sequence,
          requires_client_upgrade: !!result.requires_client_upgrade,
          upgrade: result.upgrade,
        });
      }
    }
    if (
      p[1] === "checkouts" &&
      p[2] &&
      p[3] === "prepare-join" &&
      method === "POST"
    ) {
      const c = store.get("checkout", p[2]);
      if (!c || c.user_id !== user.id) throw fault(404, "Checkout not found");
      projectFor(c.project_id, user);
      if (c.expires_at < Date.now()) throw fault(410, "Checkout expired");
      const w = store.get("world", c.world_id);
      if (!w || w.status !== "running")
        throw fault(409, "Target world not ready");
      if (w.release_id !== c.release_id)
        throw fault(
          409,
          "World updated during download; resolve a new checkout",
        );
      const ticket = randomBytes(32).toString("hex");
      store.put("ticket", {
        id: digest(ticket),
        user_id: user.id,
        project_id: c.project_id,
        world_id: w.id,
        release_id: c.release_id,
        expires_at: Date.now() + 120000,
        used: false,
      });
      const rel = store.get("release", c.release_id),
        server_url = publicAddress.websocket;
      return json(res, 200, {
        ticket,
        world_id: w.id,
        release_id: c.release_id,
        server_url,
        game_url: `/artifacts/${rel.runtime_hash}/web/index.html?server=${encodeURIComponent(server_url)}&ticket=${ticket}`,
      });
    }
    throw fault(404, "Route not found");
  } catch (e) {
    if (!res.headersSent)
      json(res, e.status ?? 400, {
        error: e.message,
        ...(e.details ? { details: e.details } : {}),
      });
    else res.end();
  }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 16_000_000 });
server.on("upgrade", (req, socket, head) => {
  if (!["/host", "/play"].includes(req.url)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.route = req.url;
    wss.emit("connection", ws, req);
  });
});
const send = (socket, msg) => {
  if (socket.readyState !== 1) return;
  // A stopped reader must not retain an unbounded queue of large content messages.
  if (socket.bufferedAmount > 16_000_000) {
    socket.close(1013, "Client too slow; reconnect for current baseline");
    return;
  }
  socket.send(JSON.stringify(msg));
};
function sendSnapshot(socket, w, { barrier = false } = {}) {
  if (socket.readyState !== 1 || !w.state || (socket.pending_load && !barrier))
    return;
  if (socket.runtime_hash !== store.get("release", w.release_id)?.runtime_hash)
    return;
  if (socket.snapshot_ack && socket.snapshot_in_flight && !barrier) return;
  // Legacy diagnostic clients get bounded transport buffering. Shipped clients
  // explicitly acknowledge consumption, including when their browser is paused.
  if (!socket.snapshot_ack && socket.bufferedAmount > 256_000) return;
  socket.snapshot_in_flight = {
    sequence: w.sequence,
    release_id: w.release_id,
    epoch: w.epoch,
  };
  send(socket, {
    type: "snapshot",
    epoch: w.epoch,
    release_id: w.release_id,
    state: w.state,
    sequence: w.sequence,
  });
}
function acknowledgeSnapshot(socket, msg) {
  if (!socket.snapshot_ack) return;
  const outstanding = socket.snapshot_in_flight;
  if (
    !outstanding ||
    msg.sequence !== outstanding.sequence ||
    msg.release_id !== outstanding.release_id ||
    msg.epoch !== outstanding.epoch
  )
    return;
  socket.snapshot_in_flight = null;
  const current = store.get("world", socket.world_id);
  if (current && current.sequence > outstanding.sequence)
    sendSnapshot(socket, current);
}
function releaseClient(socket, reason) {
  socket.active = false;
  socket.revoked = true;
  send(socket, { type: "revoked", reason });
}
function activate(socket, msg) {
  const key = socket.user.id;
  const pending = (activationChains.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => activateImpl(socket, msg));
  activationChains.set(key, pending);
  return pending;
}
async function activateImpl(socket, msg) {
  if (socket.revoked)
    throw Error("This connection was revoked; request a new ticket");
  if (socket.activating) return;
  if (!socket.pending_load) {
    if (socket.active)
      send(socket, {
        type: "active",
        world_id: socket.world_id,
        release_id: socket.release_id,
        epoch: store.get("world", socket.world_id).epoch,
        control_generation: socket.control_generation,
      });
    return;
  }
  const w = store.get("world", socket.world_id);
  if (msg.release_id !== w.release_id)
    throw Error("Client loaded incorrect release");
  projectFor(w.project_id, socket.user);
  socket.activating = true;
  const old = controls.get(socket.user.id);
  const transfer = {
    id: id("transfer"),
    user_id: socket.user.id,
    source_world: old?.world_id ?? null,
    target_world: w.id,
    release_id: w.release_id,
    status: "preparing",
    created_at: Date.now(),
  };
  store.put("transfer", transfer);
  let committed = false;
  try {
    if (old && old !== socket) {
      old.active = false;
      transfer.status = "fencing";
      store.put("transfer", transfer);
      const source = store.get("world", old.world_id);
      if (source.epoch !== old.world_epoch) {
        // A whole-world transition already closed this authority generation.
        // Do not send old-player commands into the restored, offline new host.
        const checkpoint = store
          .list("checkpoint")
          .filter(
            (c) =>
              c.world_id === source.id &&
              c.epoch === old.world_epoch &&
              c.release_id === old.release_id,
          )
          .sort((a, b) => b.sequence - a.sequence)[0];
        if (!checkpoint || digest(checkpoint.state) !== checkpoint.state_hash)
          throw Error("Previous authority fence checkpoint is unavailable");
        transfer.source_watermark = checkpoint.sequence;
        transfer.source_checkpoint = checkpoint.id;
        transfer.source_fence = "authority_epoch";
      } else if (source.status === "sleeping" && old.revoked) {
        transfer.source_watermark = source.durable_sequence;
        transfer.source_fence = "sleep_checkpoint";
      } else {
        const result = await worlds.command(old.world_id, old.user.id, "move", {
          x: 0,
          z: 0,
        });
        if (!result.ok) throw Error("Source control fence rejected");
        transfer.source_watermark = result.sequence;
        transfer.source_fence = "player_input";
      }
    }
    const current = store.get("world", socket.world_id);
    projectFor(current.project_id, socket.user);
    if (
      current.status !== "running" ||
      current.epoch !== w.epoch ||
      current.release_id !== msg.release_id ||
      socket.readyState !== 1
    )
      throw Error("Target changed during control transfer; prepare again");
    worlds.join(w.id, socket.user);
    const targetReady = await worlds.command(w.id, socket.user.id, "move", {
      x: 0,
      z: 0,
    });
    const readyWorld = store.get("world", w.id);
    if (
      !targetReady.ok ||
      readyWorld.epoch !== w.epoch ||
      readyWorld.release_id !== msg.release_id ||
      socket.readyState !== 1
    )
      throw Error("Target failed final state barrier");
    const control = store.get("control", socket.user.id) ?? {
      id: socket.user.id,
      generation: 0,
    };
    control.generation++;
    control.world_id = w.id;
    control.updated_at = Date.now();
    transfer.status = "active";
    transfer.control_generation = control.generation;
    transfer.target_watermark = targetReady.sequence;
    transfer.finished_at = Date.now();
    store.transaction(() => {
      store.put("control", control);
      store.put("transfer", transfer);
    });
    committed = true;
    socket.world_epoch = w.epoch;
    socket.control_generation = control.generation;
    socket.release_id = w.release_id;
    socket.active = true;
    socket.pending_load = false;
    socket.revoked = false;
    controls.set(socket.user.id, socket);
    sendSnapshot(socket, readyWorld, { barrier: true });
    if (old && old !== socket) {
      releaseClient(old, "Control transferred to another client");
      if (old.world_id !== w.id) worlds.leave(old.world_id, old.user.id);
    }
    send(socket, {
      type: "active",
      world_id: w.id,
      release_id: w.release_id,
      epoch: w.epoch,
      control_generation: control.generation,
      transfer_id: transfer.id,
    });
  } catch (error) {
    transfer.status = committed ? "recovery-required" : "failed";
    transfer.error = error.message;
    store.put("transfer", transfer);
    if (
      !committed &&
      old &&
      old !== socket &&
      controls.get(socket.user.id) === old &&
      !old.revoked &&
      old.readyState === 1 &&
      store.get("world", old.world_id)?.epoch === old.world_epoch
    ) {
      old.active = true;
      send(old, {
        type: "active",
        world_id: old.world_id,
        release_id: old.release_id,
        epoch: store.get("world", old.world_id).epoch,
        control_generation: old.control_generation,
      });
    }
    throw error;
  } finally {
    socket.activating = false;
  }
}

wss.on("connection", (socket) => {
  let authenticated = false;
  const timer = setTimeout(() => {
    if (!authenticated) socket.close(1008, "Handshake timeout");
  }, 5000);
  socket.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
      if (socket.route === "/host") {
        if (!authenticated) {
          if (msg.type !== "host_hello")
            throw Error("Authority hello required");
          worlds.attach(socket, msg);
          authenticated = !!socket.world_id;
          clearTimeout(timer);
        } else worlds.receive(socket, msg);
        return;
      }
      if (!authenticated) {
        if (msg.type !== "hello") throw Error("Client hello required");
        const ticket = store.get("ticket", digest(msg.ticket ?? ""));
        if (!ticket || ticket.used || ticket.expires_at < Date.now())
          throw Error("Invalid or expired join ticket");
        const user = store.get("user", ticket.user_id);
        projectFor(ticket.project_id, user);
        const w = store.get("world", ticket.world_id);
        if (w.status !== "running" || w.release_id !== ticket.release_id)
          throw Error("Target world version changed");
        ticket.used = true;
        store.put("ticket", ticket);
        Object.assign(socket, {
          world_id: w.id,
          user,
          release_id: w.release_id,
          active: false,
          revoked: false,
          pending_load: true,
          snapshot_ack: msg.snapshot_ack === true,
          snapshot_in_flight: null,
          runtime_hash: store.get("release", w.release_id).runtime_hash,
        });
        authenticated = true;
        clearTimeout(timer);
        clients.add(socket);
        const rel = store.get("release", w.release_id);
        send(socket, {
          type: "welcome",
          user_id: user.id,
          world_id: w.id,
          epoch: w.epoch,
          release_id: w.release_id,
          content: releaseContent(data, rel),
          state: w.state,
          control_generation: 0,
        });
        return;
      }
      if (msg.type === "snapshot_ack") {
        acknowledgeSnapshot(socket, msg);
        return;
      }
      if (msg.type === "loaded") {
        await activate(socket, msg);
        return;
      }
      if (msg.type === "content_rejected") {
        socket.active = false;
        socket.pending_load = false;
        const w = store.get("world", socket.world_id);
        store.event(w.project_id, {
          kind: "client_rejected",
          title: String(msg.error ?? "Client content preparation failed").slice(
            0,
            1000,
          ),
          world_id: w.id,
          actor: socket.user.name,
          release_id: msg.release_id,
        });
        send(socket, {
          type: "error",
          error: msg.error ?? "Client rejected content; previous view retained",
        });
        return;
      }
      if (msg.type !== "command") return;
      const w = store.get("world", socket.world_id);
      projectFor(w.project_id, socket.user);
      if (
        !socket.active ||
        socket.revoked ||
        controls.get(socket.user.id) !== socket ||
        msg.release_id !== w.release_id ||
        msg.epoch !== w.epoch ||
        msg.control_generation !== socket.control_generation
      )
        throw Error("Stale control or content version");
      if (typeof msg.request_id !== "string" || msg.request_id.length > 100)
        throw Error("Command request ID required");
      if (
        !["move", "attack", "dash", "interact", "select", "upgrade"].includes(
          msg.action,
        )
      )
        throw Error("Unknown gameplay action");
      const cacheKey = socket.user.id + ":" + msg.request_id,
        fingerprint = digest({
          world_id: w.id,
          action: msg.action,
          payload: msg.payload ?? {},
        }),
        previous = store.get("command", cacheKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw Error("Command ID reused for a different operation");
        send(socket, previous.response);
        return;
      }
      if (pendingCommands.has(cacheKey)) {
        const pending = pendingCommands.get(cacheKey);
        if (pending.fingerprint !== fingerprint)
          throw Error("Command ID reused for a different operation");
        send(socket, await pending.promise);
        return;
      }
      const now = Date.now();
      if (now - (socket.rate_time ?? 0) > 1000) {
        socket.rate_time = now;
        socket.rate_count = 0;
      }
      if (++socket.rate_count > 45) throw Error("Input rate exceeded");
      if ((socket.in_flight ?? 0) > 10) throw Error("Too many pending inputs");
      socket.in_flight = (socket.in_flight ?? 0) + 1;
      const operation = worlds
        .command(w.id, socket.user.id, msg.action, msg.payload ?? {}, () => {
          const actual = store.get("world", w.id);
          projectFor(actual.project_id, socket.user);
          if (
            actual.health === "recovering" ||
            actual.health === "degraded" ||
            !socket.active ||
            socket.revoked ||
            controls.get(socket.user.id) !== socket ||
            msg.release_id !== actual.release_id ||
            msg.epoch !== actual.epoch ||
            msg.control_generation !== socket.control_generation
          )
            throw Error(
              "Queued command fenced by content or control transition",
            );
        })
        .then((result) => {
          const response = {
            type: "ack",
            request_id: msg.request_id,
            ok: !!result.ok,
            error: result.error,
            sequence: result.sequence,
          };
          store.put("command", {
            id: cacheKey,
            fingerprint,
            response,
            created_at: Date.now(),
          });
          return response;
        });
      pendingCommands.set(cacheKey, { fingerprint, promise: operation });
      try {
        send(socket, await operation);
      } finally {
        pendingCommands.delete(cacheKey);
        socket.in_flight--;
      }
    } catch (e) {
      send(socket, {
        type: "error",
        error: e.message,
        ...(msg?.type === "command"
          ? { request_id: msg.request_id, recoverable: true }
          : {}),
      });
    }
  });
  socket.on("close", () => {
    clearTimeout(timer);
    clients.delete(socket);
    if (socket.user && controls.get(socket.user.id) === socket) {
      controls.delete(socket.user.id);
      worlds
        .command(socket.world_id, socket.user.id, "move", { x: 0, z: 0 })
        .then(() => {
          if (controls.get(socket.user.id)?.world_id !== socket.world_id)
            worlds.leave(socket.world_id, socket.user.id);
        })
        .catch(() => {});
    }
  });
});
worlds.on("snapshot", (w) => {
  for (const socket of clients)
    if (socket.world_id === w.id) sendSnapshot(socket, w);
});
worlds.on("content", (w) => {
  const rel = store.get("release", w.release_id);
  for (const socket of clients)
    if (socket.world_id === w.id) {
      socket.active = false;
      socket.pending_load = !socket.revoked;
      socket.snapshot_in_flight = null;
      send(socket, {
        type: "content",
        release_id: w.release_id,
        content: releaseContent(data, rel),
      });
    }
});
worlds.on("sleeping", (w) => {
  for (const socket of clients)
    if (socket.world_id === w.id)
      releaseClient(socket, "世界已保存并休眠；从项目重新进入即可接续");
});
worlds.on("upgrading", (w) => {
  for (const socket of clients)
    if (socket.world_id === w.id) {
      socket.active = false;
      socket.pending_load = false;
      socket.snapshot_in_flight = null;
      send(socket, {
        type: "runtime_upgrade",
        world_id: w.id,
        release_id: w.release_id,
        epoch: w.epoch,
        status: "preparing",
      });
    }
});
worlds.on("runtime_upgrade", (w) => {
  for (const socket of clients)
    if (socket.world_id === w.id) {
      socket.active = false;
      socket.pending_load = false;
      socket.snapshot_in_flight = null;
      send(socket, {
        type: "runtime_upgrade",
        world_id: w.id,
        release_id: w.release_id,
        epoch: w.epoch,
        status: "ready",
      });
    }
});
worlds.on("runtime_fault", (w) => {
  for (const socket of clients)
    if (socket.world_id === w.id)
      send(socket, {
        type: "runtime_fault",
        error: w.runtime_fault.error,
        world_id: w.id,
        release_id: w.release_id,
      });
});
worlds.on("failure", ({ world_id, error }) => {
  for (const socket of clients)
    if (socket.world_id === world_id) {
      socket.active = false;
      send(socket, { type: "error", error });
    }
});
server.listen(port, bindHost, () => {
  console.log(`World Atelier ready ${publicAddress.http} (bind ${bindHost}:${port})`);
  for (const w of store.list("world"))
    if (["running", "starting", "upgrading"].includes(w.status))
      worlds.recover(w).catch((e) => console.error(w.id, e.message));
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const s of clients) s.close(1001, "Server stopping");
  await worlds.stop();
  wss.close();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
