// Rechecking a completed goal against later collaborative edits creates new
// evidence. It never changes which source revisions the Agent authored.
export function goalSourceValidation(store, run, revision, execution) {
  const own = [run.input_revision, ...(run.changes ?? [])];
  const basis = own.at(-1);
  const result = {revision, basis_revision: basis, revalidation: !own.includes(revision)};
  if (!result.revalidation) return {...result, allowed: true};
  if (!execution?.ended || !['completed', 'failed', 'cancelled'].includes(execution.status)) {
    return {...result, allowed: false, reason: '请先等待此目标执行结束并核对取消清理，再验证当前协作版本'};
  }
  const target = store.get('creator_revision', revision);
  const source = store.get('creator_revision', basis);
  if (!source || !target || source.project_id !== run.project_id || target.project_id !== run.project_id || !store.ancestor(basis, revision)) {
    return {...result, allowed: false, reason: '当前源版本不是此目标产出的后继版本，请先核对或续修目标'};
  }
  return {...result, allowed: true};
}

export function isGoalRevalidation(report, goal, run, source) {
  const origin = report?.origin;
  return Boolean(source.allowed && report?.revision === source.revision &&
    origin?.kind === 'goal_revalidation' && origin.goal_id === goal.id &&
    origin.run_id === run.id && origin.session_id === run.session_id &&
    origin.basis_revision === source.basis_revision);
}
