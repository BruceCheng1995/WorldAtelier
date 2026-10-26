/** Actual workspace skill projection, with temporary service storage and no model or Godot execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,readdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,relative} from 'node:path';
import {createServer} from 'node:http';
import {CreationService} from '../../services/creation/service.mjs';
import {projectCreatorSkills,projectGameAssetSkill} from '../../services/creation/agent-skills.mjs';
import {CREATOR_SKILLS} from '../../services/creation/agent-skill-catalog.mjs';

function inventory(directory,prefix=''){
 return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?inventory(join(directory,entry.name),prefix+entry.name+'/'):entry.isFile()?[prefix+entry.name]:[]);
}

test('existing session refresh installs all packaged skills and preserves authored files and other skills',async t=>{
 const data=mkdtempSync(join(tmpdir(),'atelier-agent-skills-')),server=createServer(),service=new CreationService({server,root:process.cwd(),data,origin:'http://127.0.0.1:48921'});
 t.after(async()=>{await service.close();server.close();rmSync(data,{recursive:true,force:true});});
 const user=service.store.register({name:'skill-author',password:'isolated-skill-password'}).user;
 const project=service.store.createProject(user,{name:'Skill projection'},{schema:'creation-flat-1',entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',name:'Scene',objects:[]}}}).project.id;
 const session=service.store.createSession(user,project,'main',{title:'Existing author task'}),cwd=service.agent.workspace(session),head=service.store.branchView(user,project,'main').head;
 const authored=join(cwd,'work/game/assets/unfinished.dat'),personal=join(cwd,'.agents/skills/other/SKILL.md'),taskRecord=join(cwd,'outputs/tasks/existing/requirements.md'),bytes=Buffer.from([0,128,254,65,0,255]);
 mkdirSync(dirname(authored),{recursive:true});writeFileSync(authored,bytes);mkdirSync(dirname(personal),{recursive:true});writeFileSync(personal,'Unrelated authored skill\n');
 mkdirSync(dirname(taskRecord),{recursive:true});writeFileSync(taskRecord,'Existing task requirements\n');
 for(const skill of CREATOR_SKILLS)writeFileSync(resolve(cwd,skill.path),'Historical skill guidance\n');
 writeFileSync(join(cwd,'AGENTS.md'),'Historical text_files_only instruction\n');
 assert.equal(service.agent.workspace(service.store.get('creator_session',session.id)),cwd,'refresh preserves the persistent session cwd');
 assert.deepEqual(readFileSync(authored),bytes);assert.equal(readFileSync(personal,'utf8'),'Unrelated authored skill\n');assert.equal(readFileSync(taskRecord,'utf8'),'Existing task requirements\n');
 const manifest=JSON.parse(readFileSync(join(cwd,'workspace.json'),'utf8'));
 assert.deepEqual(manifest.skills.map(skill=>skill.name),['game-create','game-change','game-assets']);
 for(const skill of manifest.skills){
   const packaged=resolve('skills',skill.name),projected=dirname(skill.path);
   assert.equal(projected,join(cwd,'.agents/skills',skill.name));
   for(const file of inventory(packaged).filter(file=>!file.includes('__pycache__')&&!file.endsWith('.pyc')))assert.deepEqual(readFileSync(join(projected,file)),readFileSync(join(packaged,file)),file+' must remain executable/readable after projection');
   const body=readFileSync(skill.path,'utf8');
   for(const match of body.matchAll(/\]\((references\/[^)]+|scripts\/[^)]+|\.\.\/[^)]+)\)/g))assert.ok(readFileSync(resolve(projected,match[1])).length,'skill and progressive disclosure links resolve in the session');
   for(const name of ['AGENTS.md','WORLD-API.md'])assert.ok(readFileSync(join(cwd,name),'utf8').includes(relative(cwd,skill.path)),'current creator entry '+name+' exposes the installed skill');
 }
 assert.equal(service.store.branchView(user,project,'main').head,head,'projection does not mutate source');
 assert.equal(service.store.list('creator_verification').length,0);assert.equal(service.store.list('creator_build').length,0);
});

test('skill projection cannot follow a session skills symlink into another directory',t=>{
 const cwd=mkdtempSync(join(tmpdir(),'atelier-skill-scope-')),foreign=mkdtempSync(join(tmpdir(),'atelier-skill-foreign-'));
 t.after(()=>{rmSync(cwd,{recursive:true,force:true});rmSync(foreign,{recursive:true,force:true});});
 writeFileSync(join(foreign,'sentinel'),'untouched');symlinkSync(foreign,join(cwd,'.agents'));
 assert.throws(()=>projectCreatorSkills(cwd),error=>error.status===403);
 assert.throws(()=>projectGameAssetSkill(cwd),error=>error.status===403);assert.deepEqual(readdirSync(foreign),['sentinel']);
});

test('a nested workflow skill symlink cannot redirect packaged templates outside the session',t=>{
 const cwd=mkdtempSync(join(tmpdir(),'atelier-workflow-scope-')),foreign=mkdtempSync(join(tmpdir(),'atelier-workflow-foreign-'));
 t.after(()=>{rmSync(cwd,{recursive:true,force:true});rmSync(foreign,{recursive:true,force:true});});
 mkdirSync(join(cwd,'.agents/skills/game-create'),{recursive:true});writeFileSync(join(foreign,'sentinel'),'untouched');
 symlinkSync(foreign,join(cwd,'.agents/skills/game-create/references'));
 assert.throws(()=>projectCreatorSkills(cwd),error=>error.status===403);assert.deepEqual(readdirSync(foreign),['sentinel']);
});
