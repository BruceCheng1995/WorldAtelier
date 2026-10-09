/** Actual workspace skill projection, with temporary service storage and no model or Godot execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,readdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,relative} from 'node:path';
import {createServer} from 'node:http';
import {CreationService} from '../../services/creation/service.mjs';
import {projectGameAssetSkill} from '../../services/creation/agent-skills.mjs';

function inventory(directory,prefix=''){
 return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?inventory(join(directory,entry.name),prefix+entry.name+'/'):entry.isFile()?[prefix+entry.name]:[]);
}

test('existing session refresh installs a complete usable asset skill and preserves authored binary files and other skills',async t=>{
 const data=mkdtempSync(join(tmpdir(),'atelier-agent-skills-')),server=createServer(),service=new CreationService({server,root:process.cwd(),data,origin:'http://127.0.0.1:48921'});
 t.after(async()=>{await service.close();server.close();rmSync(data,{recursive:true,force:true});});
 const user=service.store.register({name:'skill-author',password:'isolated-skill-password'}).user;
 const project=service.store.createProject(user,{name:'Skill projection'},{schema:'creation-flat-1',entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',name:'Scene',objects:[]}}}).project.id;
 const session=service.store.createSession(user,project,'main',{title:'Existing author task'}),cwd=service.agent.workspace(session),packaged=resolve('skills/game-assets'),projected=join(cwd,'.agents/skills/game-assets');
 const authored=join(cwd,'work/game/assets/unfinished.dat'),personal=join(cwd,'.agents/skills/other/SKILL.md'),bytes=Buffer.from([0,128,254,65,0,255]);
 mkdirSync(dirname(authored),{recursive:true});writeFileSync(authored,bytes);mkdirSync(dirname(personal),{recursive:true});writeFileSync(personal,'Unrelated authored skill\n');
 writeFileSync(join(projected,'SKILL.md'),'Historical unavailable asset import instruction\n');writeFileSync(join(cwd,'AGENTS.md'),'Historical text_files_only instruction\n');
 assert.equal(service.agent.workspace(service.store.get('creator_session',session.id)),cwd,'refresh preserves the persistent session cwd');
 assert.deepEqual(readFileSync(authored),bytes);assert.equal(readFileSync(personal,'utf8'),'Unrelated authored skill\n');
 for(const file of inventory(packaged).filter(file=>!file.includes('__pycache__')&&!file.endsWith('.pyc')))assert.deepEqual(readFileSync(join(projected,file)),readFileSync(join(packaged,file)),file+' must remain executable/readable after projection');
 const skill=readFileSync(join(projected,'SKILL.md'),'utf8');
 for(const match of skill.matchAll(/\]\((references\/[^)]+|scripts\/[^)]+)\)/g))assert.ok(readFileSync(resolve(projected,match[1])).length,'progressive disclosure links resolve in the session');
 for(const name of ['AGENTS.md','WORLD-API.md'])assert.ok(readFileSync(join(cwd,name),'utf8').includes(relative(cwd,join(projected,'SKILL.md'))),'current creator entry '+name+' exposes the installed skill');
});

test('skill projection cannot follow a session skills symlink into another directory',t=>{
 const cwd=mkdtempSync(join(tmpdir(),'atelier-skill-scope-')),foreign=mkdtempSync(join(tmpdir(),'atelier-skill-foreign-'));
 t.after(()=>{rmSync(cwd,{recursive:true,force:true});rmSync(foreign,{recursive:true,force:true});});
 writeFileSync(join(foreign,'sentinel'),'untouched');symlinkSync(foreign,join(cwd,'.agents'));
 assert.throws(()=>projectGameAssetSkill(cwd),error=>error.status===403);assert.deepEqual(readdirSync(foreign),['sentinel']);
});
