// Local transform transactions. Each scene/prefab in each branch owns its own history.
export const vector = (value, fallback = 0) => Array.isArray(value)
  ? value.map(n => Number(Number(n).toFixed(5)))
  : [value ?? fallback, value ?? fallback, value ?? fallback];
export const transformOf = object => ({
  position: vector(object.position), rotation: vector(object.rotation), scale: vector(object.scale, 1),
});
export const sameTransform = (a, b) => ['position', 'rotation', 'scale'].every(key =>
  a[key].every((value, i) => Math.abs(value - b[key][i]) < 0.00002));
export class TransformHistory {
  constructor(limit = 80) { this.limit = limit; this.documents = new Map(); }
  state(documentId) {
    if (!this.documents.has(documentId)) this.documents.set(documentId, { undo: [], redo: [] });
    return this.documents.get(documentId);
  }
  record(documentId, objectId, before, after) {
    if (sameTransform(before, after)) return false;
    const state = this.state(documentId);
    state.undo.push(structuredClone({ objectId, before, after }));
    if (state.undo.length > this.limit) state.undo.shift();
    state.redo.length = 0;
    return true;
  }
  take(documentId, action) {
    if (action !== 'undo' && action !== 'redo') return null;
    const state = this.state(documentId), entry = state[action].pop();
    if (!entry) return null;
    state[action === 'undo' ? 'redo' : 'undo'].push(entry);
    return { objectId: entry.objectId, transform: structuredClone(entry[action === 'undo' ? 'before' : 'after']) };
  }
}
