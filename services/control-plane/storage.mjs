import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class Storage {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS documents (kind TEXT, id TEXT, body TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_project ON events(project_id,sequence);`);
    this.read = this.db.prepare(
      "SELECT body FROM documents WHERE kind=? AND id=?",
    );
    this.write = this.db.prepare(
      "INSERT INTO documents(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
    );
  }
  get(kind, id) {
    if (id === null || id === undefined) return null;
    const row = this.read.get(kind, id);
    return row ? JSON.parse(row.body) : null;
  }
  put(kind, item) {
    this.write.run(kind, item.id, JSON.stringify(item));
    return item;
  }
  list(kind) {
    return this.db
      .prepare("SELECT body FROM documents WHERE kind=?")
      .all(kind)
      .map((r) => JSON.parse(r.body));
  }
  remove(kind, id) {
    this.db
      .prepare("DELETE FROM documents WHERE kind=? AND id=?")
      .run(kind, id);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  event(project_id, body) {
    this.db
      .prepare("INSERT INTO events(project_id,body) VALUES(?,?)")
      .run(project_id, JSON.stringify({ ...body, at: Date.now() }));
  }
  activity(project_id) {
    return this.db
      .prepare(
        "SELECT sequence,body FROM events WHERE project_id=? ORDER BY sequence DESC LIMIT 100",
      )
      .all(project_id)
      .map((r) => {
        const body = JSON.parse(r.body);
        if (body.world_id && body.sequence !== undefined) {
          body.world_sequence = body.sequence;
          delete body.sequence;
        }
        return { ...body, activity_sequence: r.sequence };
      });
  }
  close() {
    this.db.close();
  }
}
