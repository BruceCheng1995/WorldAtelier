import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { hash } from './schema.mjs';

// One entry per real file, with bounded LRU eviction. A Godot .app alone has
// more than 40 files; clearing the whole map mid-inventory defeats every hit.
export function createFileIdentityCache({ capacity = 256, readFile = readFileSync } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw Error('Invalid file identity cache capacity');
  const entries = new Map();
  return function fileIdentity(path) {
    if (!existsSync(path)) return { missing: true };
    const actual = realpathSync(path), stat = statSync(actual, { bigint: true });
    const signature = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    let entry = entries.get(actual);
    if (!entry || entry.signature !== signature) {
      entry = { signature, sha256: hash(readFile(actual)), size: Number(stat.size) };
    }
    entries.delete(actual);
    entries.set(actual, entry);
    if (entries.size > capacity) entries.delete(entries.keys().next().value);
    return { sha256: entry.sha256, size: entry.size };
  };
}
