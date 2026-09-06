import { digest } from "./content.mjs";

export const objectAt = (revision, id) =>
  revision?.content?.objects?.find((object) => object.id === id) ?? null;
export const objectHash = (revision, id) => digest(objectAt(revision, id));

export function reachableRevision(store, head, target) {
  const pending = [head],
    seen = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(store.get("revision", id)?.parents ?? []));
  }
  return false;
}

export function taskEvent(store, task, event) {
  const entry = { ...event, at: Date.now(), cycle: task.cycle ?? 1 };
  task.history = [...(task.history ?? []), entry].slice(-100);
  task.updated_at = entry.at;
  store.put("task", task);
  store.event(task.project_id, {
    ...entry,
    kind: "annotation_" + entry.kind,
    title: task.title,
    task_id: task.id,
    object_id: task.object_id,
    branch: task.branch,
    actor: entry.actor,
  });
  return task;
}

export function taskForWorld(store, task, world) {
  const result = { ...task };
  if (task.status === "delivered") {
    const revision = store.get(
      "revision",
      store.get("release", world.release_id)?.revision,
    );
    const expected =
      task.delivered_object_hash ??
      objectHash(
        store.get("revision", store.get("release", task.release_id)?.revision),
        task.object_id,
      );
    result.world_object_hash = objectHash(revision, task.object_id);
    result.delivery_status =
      result.world_object_hash === expected ? "applied" : "awaiting_world";
    if (result.delivery_status === "awaiting_world") result.status = "testing";
  }
  return result;
}

function changes(before, after) {
  if (before === null || after === null)
    return [{ path: "object", before, after }];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((key) => digest(before[key] ?? null) !== digest(after[key] ?? null))
    .map((key) => ({
      path: key,
      before: before[key] ?? null,
      after: after[key] ?? null,
    }));
}

export function objectHistory(store, project, branch, object_id, limit = 30) {
  const releases = store
    .list("release")
    .filter((r) => r.project_id === project.id);
  const describe = (revision) => ({
    revision: revision?.id ?? null,
    object_hash: objectHash(revision, object_id),
    object: objectAt(revision, object_id),
  });
  const source = store.get("revision", branch.source_head),
    playableRelease = store.get("release", branch.playable_head),
    versions = [];
  let current = source;
  const seen = new Set();
  while (current && !seen.has(current.id) && versions.length < limit) {
    seen.add(current.id);
    const parent = store.get("revision", current.parents[0]);
    const before = objectAt(parent, object_id),
      after = objectAt(current, object_id);
    if (digest(before) !== digest(after))
      versions.push({
        ...describe(current),
        parent_revision: parent?.id ?? null,
        author: current.author,
        created_at: current.created_at,
        message: current.message,
        changes: changes(before, after),
        releases: releases
          .filter((r) => r.revision === current.id)
          .map((r) => ({
            release_id: r.id,
            status: r.status,
            runtime_hash: r.runtime_hash,
          })),
      });
    current = parent;
  }
  const worlds = store
    .list("world")
    .filter((w) => w.project_id === project.id && w.branch === branch.name)
    .map((w) => {
      const release = store.get("release", w.release_id);
      return {
        world_id: w.id,
        name: w.name,
        release_id: w.release_id,
        ...describe(store.get("revision", release?.revision)),
        epoch: w.epoch,
        applied_sequence: w.release_applied_sequence ?? null,
        durable_sequence: w.durable_sequence,
        status: w.status,
      };
    });
  const tasks = store
    .list("task")
    .filter(
      (t) =>
        t.project_id === project.id &&
        t.branch === branch.name &&
        t.object_id === object_id,
    )
    .map((t) => ({
      ...t,
      base_object_hash:
        t.base_object_hash ??
        objectHash(store.get("revision", t.base_revision), object_id),
      worlds: worlds.map((w) => ({
        world_id: w.world_id,
        delivery_status:
          taskForWorld(store, t, { ...w, id: w.world_id }).delivery_status ??
          "pending",
      })),
    }));
  return {
    project_id: project.id,
    branch: branch.name,
    object_id,
    source: describe(source),
    playable: playableRelease
      ? {
          release_id: playableRelease.id,
          ...describe(store.get("revision", playableRelease.revision)),
        }
      : null,
    worlds,
    versions,
    tasks,
    has_more: !!current,
  };
}
