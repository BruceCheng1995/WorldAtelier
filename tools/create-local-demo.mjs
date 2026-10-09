// Creates a fresh, resumable demonstration through the same authenticated APIs as clients.
// It never deletes existing projects. Credentials and receipts stay in ignored .local files.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApi,atomicWrite,pause} from '../apps/desktop-launcher/runtime.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(!process.env.WORLD_ATELIER_LEGACY_DEMO_URL||!process.env.WORLD_ATELIER_LEGACY_DEMO_DATA){
  console.error('中央门户演示已退役。请运行 npm start，在48910工作台创建游戏。历史测试须显式指定 WORLD_ATELIER_LEGACY_DEMO_URL 和 WORLD_ATELIER_LEGACY_DEMO_DATA。');
  process.exit(1);
}
const server=process.env.WORLD_ATELIER_LEGACY_DEMO_URL.replace(/\/$/,''),directory=resolve(process.env.WORLD_ATELIER_LEGACY_DEMO_DATA);
await mkdir(directory,{recursive:true,mode:0o700});
let record;try{record=JSON.parse(await readFile(join(directory,'setup.json'),'utf8'));}catch{record={accounts:[],steps:{},created_at:Date.now()};}
const save=async()=>{await writeFile(join(directory,'setup.json'),JSON.stringify(record,null,2),{mode:0o600});};
async function step(key,fn){if(Object.hasOwn(record.steps,key))return record.steps[key];const result=await fn();record.steps[key]=result;await save();return result;}
for(const [i,name] of ['工坊主人','场景设计师','协作测试员'].entries()){
  if(!record.accounts[i]){record.accounts[i]={name,password:randomBytes(12).toString('base64url')};await save();}
  const account=record.accounts[i];
  let response=await fetch(server+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(account)});
  if(response.status===401)response=await fetch(server+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(account)});
  const result=await response.json();if(!response.ok)throw Error(result.error);account.session=result;await save();
}
const apis=record.accounts.map((a,i)=>createApi({server,token:a.session.token,journalDir:join(directory,'operations-'+i)}));
const owner=apis[0],editor=apis[1];
const project=await step('project',async()=>(await owner('/api/projects',{name:'星屿远征 · 共享开发工程'})).project);
const path='/api/projects/'+project.id;
for(const [i,role] of [[1,'editor'],[2,'tester']])await step('member-'+i,()=>owner(path+'/members',{name:record.accounts[i].name,role}));
async function publish(branch,key,api=owner){
  const build=await step(key+'-build',async()=>(await api(`${path}/branches/${branch}/build`,{})).build);
  const end=Date.now()+180000;
  while(Date.now()<end){const current=(await owner(path)).builds.find(b=>b.id===build.id);if(current?.status==='passed')return current;if(['failed','superseded'].includes(current?.status))throw Error(current.error||current.log||current.status);await pause(250);}
  throw Error('Build did not complete: '+build.id);
}
await publish('main','baseline');
const world=await step('main-world',async()=>(await owner(path+'/worlds',{branch:'main',name:'主干 · 共享远征'})).world);
await step('model-task',async()=>owner(path+'/tasks',{branch:'main',object_id:'starheart',title:'Blender 星铸中继站：制作、导入与现场交付',origin:'live',observed_world_id:world.id,observed_release_id:world.release_id}));
const model=await step('model-asset',async()=>(await editor(path+'/assets',{name:'sunforge_relay.glb',mime:'model/gltf-binary',data_base64:(await readFile(join(root,'runtimes/godot/assets/source/live_pipeline/sunforge_relay.glb'))).toString('base64')})).asset);
await step('model-commit',async()=>{const source=await editor(path+'/branches/main/content');const object=source.content.objects.find(o=>o.id==='starheart');object.model_asset=model.hash;object.name='星铸中继站';return editor(path+'/branches/main/commit',{base_revision:source.revision,content:source.content,message:'发布 Blender 原创星铸中继站，保留对象稳定身份'});});
const modelBuild=await publish('main','model',editor);
await step('model-delivery',()=>owner('/api/worlds/'+world.id+'/apply-latest',{release_id:modelBuild.release_id}));
await step('next-task',()=>editor(path+'/tasks',{branch:'main',object_id:'forge_hub',title:'演示任务：下一轮锻造台造型设计（待编辑）',origin:'source'}));
await step('branch',()=>editor(path+'/branches',{name:'scene-lab',from_branch:'main'}));
await step('branch-commit',async()=>{const source=await editor(path+'/branches/scene-lab/content');const o=source.content.objects.find(o=>o.id==='forge_hub');o.color='#e9a24a';o.name='实验分支 · 金色锻造台';return editor(path+'/branches/scene-lab/commit',{base_revision:source.revision,content:source.content,message:'独立分支探索锻造台配色'});});
await publish('scene-lab','branch',editor);
const laboratory=await step('branch-world',async()=>(await editor(path+'/worlds',{branch:'scene-lab',name:'场景实验室 · 独立进度'})).world);
const details=await owner(path);record.project_id=project.id;record.world_id=world.id;record.branch_world_id=laboratory.id;record.latest_release=modelBuild.release_id;await save();
await writeFile(join(root,'.local/DEMO-ACCESS.md'),`# 本机世界工坊入口\n\n打开 ${server}，切换到登录后使用以下本机示例账号。\n\n${record.accounts.map((a,i)=>`- ${a.name}（${['拥有者','编辑者','测试者'][i]}）：密码 ${a.password}`).join('\n')}\n\n工程：${project.name}\n主干世界：${world.id}\n实验分支：scene-lab，独立世界 ${laboratory.id}\n\n两个世界进度独立。主干已完成 Blender 中继站的实际构建与交付；锻造台保留一个明确标注的待编辑演示任务，供继续开发。密码只保存在本机被 Git 忽略的目录中。\n`,{mode:0o600});
await atomicWrite(join(directory,'receipt.json'),{server,project_id:project.id,world_id:world.id,branch_world_id:laboratory.id,releases:details.releases.map(r=>({id:r.id,runtime_hash:r.runtime_hash,revision:r.revision})),asset:model,created_at:Date.now()});
console.log(JSON.stringify({ok:true,server,project:project.name,project_id:project.id,world_id:world.id,access_file:join(root,'.local/DEMO-ACCESS.md')}));
