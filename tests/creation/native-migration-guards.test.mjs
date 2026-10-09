// Offline maintenance guards; no engine execution or gameplay is claimed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {createCreationBackup} from '../../tools/backup-creation.mjs';
import {migrateNativeCreation} from '../../tools/migrate-native-creation.mjs';
const root=resolve(import.meta.dirname,'../..');
function fixture(t){
  const parent=join(root,'.local/creation-verification/native-framework');mkdirSync(parent,{recursive:true});
  const base=mkdtempSync(join(parent,'migration-guards-')),data=join(base,'data'),store=new CreationStore(join(data,'creation.sqlite'));
  const owner={id:'owner',name:'Migration test owner'};store.put('creator_user',owner);
  const game=store.createProject(owner,{name:'Migration guard fixture'},{schema:'creation-flat-1',entry_scene_id:'main',resources:{main:{id:'main',kind:'scene',name:'Main',objects:[]}}});
  const backup=join(base,'backup'),out=join(base,'report');t.after(()=>{store.close();rmSync(base,{recursive:true,force:true});});
  return {base,data,store,owner,game,backup,out,args:{root,data,backup,out}};
}
test('migration rejects new session data even when every source head matches the backup',async t=>{
  const f=fixture(t);await createCreationBackup({data:f.data,out:f.backup});
  f.store.put('creator_session',{id:'after-backup-session',project_id:f.game.project.id,owner_user_id:f.owner.id,draft:'new work'});
  await assert.rejects(migrateNativeCreation(f.args),/数据库与备份不一致/);
  assert.equal(f.store.get('creator_branch',f.game.project.id+':main').head,f.game.branch.head);
  assert.ok(f.store.get('creator_session','after-backup-session'));assert.equal(existsSync(join(f.data,'.native-migration.lock')),false);
});
test('migration refuses cancelling and unconfirmed command cleanup before opening native candidates',async t=>{
  for(const run of [{status:'cancelling'},{status:'interrupted',cleanup_status:'pending'},{status:'failed',cleanup_status:'uncertain'}])await t.test(JSON.stringify(run),async t=>{
    const f=fixture(t);f.store.put('creator_run',{id:'pending-run',...run});await createCreationBackup({data:f.data,out:f.backup});
    await assert.rejects(migrateNativeCreation(f.args),e=>e.status===409&&e.details.runs.includes('pending-run'));
    assert.equal(existsSync(join(f.data,'native-source')),false);assert.equal(existsSync(join(f.data,'.native-migration.lock')),false);
  });
});
test('migration never treats its fixed backup as a mutable working database or report directory',async t=>{
  const f=fixture(t);await createCreationBackup({data:f.data,out:f.backup});
  await assert.rejects(migrateNativeCreation({...f.args,data:join(f.backup,'data')}),/不能覆盖固定备份/);
  await assert.rejects(migrateNativeCreation({...f.args,out:join(f.backup,'report')}),/不能覆盖固定备份/);
  assert.equal(existsSync(join(f.backup,'data','.native-migration.lock')),false);
});
