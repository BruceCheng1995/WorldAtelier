// One continuation per user-started run chain. Reconcile first; never replay
// turn/start or tool calls whose outcome is unknown.
export class AutomaticSessionResume {
  constructor(manager,{delays=[3000,10000,30000]}={}) {
    this.manager=manager;this.store=manager.store;this.delays=delays;this.timers=new Map();this.active=new Map();
  }
  capture(run,reason) {
    if(this.manager.closing||this.manager.cancelled(run)||run.auto_resume_blocked_reason||run.awaiting_user||run.ai_limit_reason||(run.auto_resume_count??0)>=1)return;
    if(!['starting','running','uncertain'].includes(run.status))return;
    if(!run.auto_resume||run.auto_resume.status==='settled')run.auto_resume={status:'pending',reason,attempts:0,created_at:Date.now()};
  }
  schedule(runId) {
    const run=this.store.get('creator_run',runId);
    if(this.manager.closing||run?.auto_resume?.status!=='pending'||this.timers.has(runId)||this.active.has(runId))return;
    const delay=this.delays[run.auto_resume.attempts];
    if(delay===undefined){this.finish(runId,'stopped','recovery_attempts_exhausted');return;}
    const timer=setTimeout(()=>{this.timers.delete(runId);void this.resume(runId);},delay);timer.unref();this.timers.set(runId,timer);
  }
  finish(runId,status,reason) {
    const run=this.store.get('creator_run',runId);if(!run?.auto_resume)return;
    run.auto_resume={...run.auto_resume,status,detail:reason,updated_at:Date.now()};this.store.put('creator_run',run);
    this.manager.service.sessionEvent(run.session_id,{kind:'run_state',run});
  }
  cancel(runId,reason) {
    const run=this.store.get('creator_run',runId);if(!run)return;
    run.auto_resume_blocked_reason=reason;this.store.put('creator_run',run);
    clearTimeout(this.timers.get(runId));this.timers.delete(runId);
    if(run.auto_resume?.status==='pending')this.finish(runId,'stopped',reason);
  }
  assertCurrent(runId) {
    const m=this.manager,run=this.store.get('creator_run',runId);
    if(m.closing||!run||m.runForSession(run.session_id)?.id!==runId||run.auto_resume?.status!=='pending'||run.auto_resume_blocked_reason||run.awaiting_user||run.ai_limit_reason||(run.auto_resume_count??0)>=1)throw Error('automatic_resume_no_longer_applicable');
    m.store.sessionFor({id:run.owner_user_id},run.session_id,true);
    return run;
  }
  resume(runId) {
    if(this.active.has(runId))return this.active.get(runId);
    const pending=this.resumeOnce(runId).catch(error=>{
      if(this.manager.closing)return;
      const run=this.store.get('creator_run',runId);if(run?.auto_resume?.status!=='pending')return;
      this.finish(runId,(error.status===403||error.status===429||error.message==='automatic_resume_no_longer_applicable')?'stopped':'pending',error.message);
    }).finally(()=>{this.active.delete(runId);this.schedule(runId);});
    this.active.set(runId,pending);return pending;
  }
  async resumeOnce(runId) {
    const m=this.manager;let run=this.assertCurrent(runId);
    if(m.sending.has(run.session_id))return;
    if(run.auto_resume.attempts>=this.delays.length){this.finish(runId,'stopped','recovery_attempts_exhausted');return;}
    run.auto_resume.attempts++;this.store.put('creator_run',run);
    const user={id:run.owner_user_id},result=await m.reconcile(user,run.session_id);
    run=this.assertCurrent(runId);
    if(run.status==='completed'||run.status==='failed'){this.finish(runId,'settled',run.status);return;}
    if(run.status==='running'){this.finish(runId,'settled','original_turn_still_running');return;}
    if(run.status!=='interrupted'||result.reconciliation.matchedTurnId!==run.turn_id||!result.reconciliation.canSend||result.reconciliation.uncertain||m.cleanupBlocked(run.session_id).length)throw Error('original_turn_not_confirmed_stopped');
    const goal=this.store.get('creator_goal',run.goal_id);
    if(!goal?.objective){this.finish(runId,'stopped','original_objective_missing');return;}
    const text=`上次执行因服务器或执行器连接中断而停止，请继续完成原任务。先读取最新源稿和已有提交，保留工作区中未提交的工作，只继续未完成部分，不要重放已经成功的修改。若任务已完成，只汇报已有结果。\n\n原任务：${goal.objective}`;
    await m.send(user,run.session_id,{text,client_user_message_id:`auto-resume-${run.id}`,goal_id:goal.id,expected_run_id:run.id,model:run.model,effort:run.effort??null,access_mode:run.access_mode??'workspace-write',execution_mode:run.execution_mode??'default'},{autoResumeFrom:run.id});
  }
  async close() {
    for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();
    await Promise.allSettled([...this.active.values()]);
  }
}
