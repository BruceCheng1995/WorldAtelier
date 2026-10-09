import {fail, hash, clone} from './schema.mjs';

/** Read-only adapter for the host's capture ingestion boundary.
 * Records in creator_goal_review_artifact must be created only by the trusted
 * capture/observation service after it pins the actual runtime observation.
 * Never expose Storage.put for these records as a user/Agent tool or HTTP route.
 * readBytes(storageKey) reads from the host's immutable object store; the key
 * comes from a stored record, not a user path/URL. This module does not fetch URLs.
 */
export function createGoalReviewEvidenceResolver({store, readBytes}) {
  if (typeof readBytes !== 'function') throw new TypeError('immutable evidence readBytes is required');
  return ({user, goal, review, reference}) => {
    store.sessionFor(user, review.session_id);
    const record = store.get('creator_goal_review_artifact', reference);
    if (!record || record.project_id !== review.project_id || record.session_id !== review.session_id || record.pin?.goal_id !== goal.id || record.capture_status !== 'retained') fail(404, '没有可读取的固定体验证据');
    const bytes = readBytes(record.storage_key);
    if (!(bytes instanceof Uint8Array) || hash(Buffer.from(bytes)) !== record.sha256) fail(409, '体验证据字节缺失或哈希不匹配');
    return {ref: record.id, sha256: record.sha256, kind: record.kind, pin: clone(record.pin)};
  };
}
