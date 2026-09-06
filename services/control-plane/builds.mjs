import { objectHash, taskEvent } from "./object-history.mjs";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { materializeContent } from "./assets.mjs";
import { digest, validateContent } from "./content.mjs";

export class Builds {
  constructor({
    store,
    root,
    data,
    godot,
    runtimeRoot = join(root, ".local/artifacts"),
    onTasks = () => {},
  }) {
    Object.assign(this, { store, root, data, godot, runtimeRoot, onTasks });
    this.running = new Map();
    for (const build of store.list("build"))
      if (["queued", "running"].includes(build.status)) {
        build.status = "failed";
        build.error =
          "Build interrupted by service restart; previous playable release retained";
        build.finished_at = Date.now();
        store.put("build", build);
        this.updateTasks(build, "failed", build.error);
      }
  }
  schedule(project, branch, user, options = {}) {
    if (
      options.runtime_hash &&
      (!/^[a-f0-9]{64}$/.test(options.runtime_hash) ||
        !existsSync(
          join(this.runtimeRoot, options.runtime_hash, "manifest.json"),
        ))
    )
      throw Error("Unknown exported runtime");
    const id = "build_" + randomUUID();
    branch.publish_generation = (branch.publish_generation ?? 0) + 1;
    this.store.put("branch", branch);
    const build = {
      id,
      project_id: project.id,
      branch: branch.name,
      revision: branch.source_head,
      generation: branch.publish_generation,
      status: "queued",
      author: user.name,
      created_at: Date.now(),
      log: "",
      runtime_hash: options.runtime_hash ?? null,
    };
    this.store.put("build", build);
    const candidate = this.store.get("revision", build.revision);
    for (const task of this.store
      .list("task")
      .filter(
        (t) =>
          t.project_id === project.id &&
          t.branch === branch.name &&
          ["editing", "testing", "failed"].includes(t.status),
      )) {
      if (
        objectHash(candidate, task.object_id) ===
        objectHash(
          this.store.get("revision", task.base_revision),
          task.object_id,
        )
      )
        continue;
      task.status = "testing";
      task.candidate_revision = build.revision;
      task.candidate_build_id = build.id;
      delete task.error;
      taskEvent(this.store, task, {
        kind: "build_started",
        status: "testing",
        actor: user.name,
        revision: build.revision,
        build_id: build.id,
        object_hash: objectHash(candidate, task.object_id),
      });
    }
    this.onTasks(project.id, branch.name);
    this.store.event(project.id, {
      kind: "build",
      title: `构建 ${branch.name}`,
      actor: user.name,
      build_id: id,
    });
    const task = this.execute(build)
      .catch((e) => {
        build.status = "failed";
        build.error = e.message;
        build.finished_at = Date.now();
        this.store.put("build", build);
        this.updateTasks(build, "failed", e.message);
        this.store.event(project.id, {
          kind: "build_failed",
          title: e.message,
          build_id: id,
        });
      })
      .finally(() => this.running.delete(id));
    this.running.set(id, task);
    return build;
  }
  updateTasks(build, status, error) {
    for (const task of this.store
      .list("task")
      .filter((t) => t.candidate_build_id === build.id)) {
      if (status === "failed") {
        task.status = "failed";
        task.error = error;
      }
      if (status === "superseded" && task.status === "testing")
        task.status = "editing";
      if (status === "passed") task.candidate_release_id = build.release_id;
      taskEvent(this.store, task, {
        kind: "build_" + status,
        status: task.status,
        revision: build.revision,
        build_id: build.id,
        release_id: build.release_id,
        error,
      });
    }
    this.onTasks(build.project_id, build.branch);
  }
  async execute(build) {
    build.status = "running";
    this.store.put("build", build);
    const revision = this.store.get("revision", build.revision);
    validateContent(revision.content);
    const dir = join(this.data, "builds", build.id);
    mkdirSync(dir, { recursive: true });
    const source = join(dir, "content.json");
    writeFileSync(
      source,
      JSON.stringify(
        materializeContent(
          this.store,
          this.data,
          build.project_id,
          revision.content,
        ),
      ),
    );
    const runtimeManifest = build.runtime_hash
      ? join(this.runtimeRoot, build.runtime_hash, "manifest.json")
      : join(this.root, ".local/runtime-build/manifest.json");
    if (!existsSync(runtimeManifest))
      throw Error(
        "Real desktop/Web exports are not built yet. Run npm run build:runtime.",
      );
    const runtime = JSON.parse(readFileSync(runtimeManifest, "utf8"));
    const gameRoot = join(this.root, "runtimes/godot");
    const files = (directory) =>
      readdirSync(directory, { withFileTypes: true })
        .filter((e) => ![".godot", ".git", "build", "exports"].includes(e.name))
        .flatMap((e) =>
          e.isDirectory()
            ? files(join(directory, e.name))
            : [join(directory, e.name)],
        );
    const sourceHash = digest(
      files(gameRoot)
        .filter((f) => !f.endsWith("/README.md"))
        .sort()
        .map((f) => ({
          path: f.slice(gameRoot.length + 1),
          sha256: digest(readFileSync(f)),
        })),
    );
    if (build.runtime_hash && runtime.hash !== build.runtime_hash)
      throw Error("Pinned runtime manifest identity mismatch");
    for (const artifact of runtime.artifacts) {
      const bytes = readFileSync(
        join(this.runtimeRoot, runtime.hash, artifact.path),
      );
      if (bytes.length !== artifact.bytes || digest(bytes) !== artifact.sha256)
        throw Error("Exported runtime artifact integrity failure");
    }
    if (!build.runtime_hash && sourceHash !== runtime.source_hash)
      throw Error(
        "Runtime source changed; rebuild runtime exports before publishing",
      );
    const binary = join(
      this.runtimeRoot,
      runtime.hash,
      runtime.authority_binary,
    );
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        binary,
        ["--headless", "--", "--role=validate", `--content=${source}`],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      const collect = (b) => {
        output = (output + b.toString()).slice(-50000);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(Error("Godot validation timed out"));
      }, 30000);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
    build.log = result.output;
    this.store.put("build", build);
    if (
      result.code !== 0 ||
      !result.output.includes("CONTENT_VALIDATED") ||
      /SCRIPT ERROR|Parse Error/.test(result.output)
    )
      throw Error("Godot rejected candidate: " + result.output.slice(-1500));
    const content_hash = digest(readFileSync(source));
    const id =
      "release_" +
      digest({ revision: revision.id, runtime: runtime.hash }).slice(0, 24);
    if (this.store.get("release", id)?.status === "quarantined")
      throw Error(
        "This exact release has a recorded runtime failure; change the source before republishing",
      );
    const artifactDir = join(this.data, "artifacts", content_hash);
    mkdirSync(artifactDir, { recursive: true });
    copyFileSync(source, join(artifactDir, "content.json"));
    const artifacts = runtime.artifacts.map((a) => ({
      ...a,
      url: `/artifacts/${runtime.hash}/${a.path}`,
    }));
    const release = {
      id,
      project_id: build.project_id,
      revision: revision.id,
      runtime_hash: runtime.hash,
      content_hash,
      authority_binary: runtime.authority_binary,
      artifacts,
      content_url: `/content/${content_hash}/content.json`,
      status: "ready",
      schema: 1,
      engine: "4.6-stable",
      created_at: Date.now(),
      validation: {
        build_id: build.id,
        kind: "godot-headless-content",
        passed: true,
      },
    };
    this.store.transaction(() => {
      this.store.put("release", release);
      const branch = this.store.get(
        "branch",
        `${build.project_id}:${build.branch}`,
      );
      if (
        branch.publish_generation !== build.generation ||
        branch.source_head !== build.revision
      ) {
        build.status = "superseded";
      } else {
        branch.playable_head = id;
        this.store.put("branch", branch);
        build.status = "passed";
      }
      build.release_id = id;
      build.finished_at = Date.now();
      this.store.put("build", build);
      this.store.event(build.project_id, {
        kind: "build_" + build.status,
        title: `${build.branch} · ${build.status}`,
        release_id: id,
      });
    });
    this.updateTasks(build, build.status);
  }
}
