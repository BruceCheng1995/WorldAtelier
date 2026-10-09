import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,statSync,utimesSync,symlinkSync} from 'node:fs';
import vm from 'node:vm';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationRealtime} from '../../services/creation/realtime.mjs';
import {CreationBuilds} from '../../services/creation/export-builds.mjs';
import {hash} from '../../services/creation/schema.mjs';

class Socket extends EventEmitter{
 constructor(){super();this.readyState=1;this.packets=[];}
 send(bytes){this.packets.push(JSON.parse(bytes));}
 receive(value){this.emit('message',Buffer.from(JSON.stringify(value)));}
 close(){this.readyState=3;this.emit('close');}
}
test('same-head scoped baseline omits content but changed head, access and resource checks remain',t=>{
 const dir=mkdtempSync(join(tmpdir(),'wa-sync-performance-')),store=new CreationStore(join(dir,'db'));
 const realtime=new CreationRealtime({server:new EventEmitter(),store});
 t.after(()=>{realtime.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const owner={id:'owner',name:'Owner'},viewer={id:'viewer',name:'Viewer'};for(const u of [owner,viewer])store.put('creator_user',u);
 const {project,branch}=store.createProject(owner,{name:'Scope baseline'},{entry_scene_id:'a',resources:{a:{id:'a',name:'A',kind:'scene',objects:[]},b:{id:'b',name:'B',kind:'scene',objects:[]}}});
 store.setMember(owner,project.id,viewer.id,'viewer');
 const ws=new Socket();realtime.connect(ws,'http://test');ws.receive({type:'auth',token:store.issueLogin(viewer).token});
 const subscribe=(generation,extra={})=>ws.receive({type:'subscribe',project_id:project.id,branch_id:'main',resource_id:'a',generation,...extra});
 subscribe(1);assert.equal(ws.packets.findLast(p=>p.type==='baseline').branch.manifest.entry_scene_id,'a');
 subscribe(2,{known_head:branch.head,resource_id:'b'});let packet=ws.packets.findLast(p=>p.type==='baseline');
 assert.equal(packet.resource_id,'b');assert.equal(packet.generation,2);assert.equal(packet.branch.head,branch.head);assert.equal(packet.branch.manifest,undefined);assert.equal(packet.branch.manifest_unchanged,true);
 const next=store.writeRevision(project.id,[branch.head],branch.manifest,owner.id);const current=store.branchFor(owner,project.id,'main');current.head=next.id;store.put('creator_branch',current);
 subscribe(3,{known_head:branch.head});packet=ws.packets.findLast(p=>p.type==='baseline');assert.equal(packet.branch.head,next.id);assert.ok(packet.branch.manifest);
 subscribe(4,{known_head:next.id,resource_id:'missing'});assert.equal(ws.packets.at(-1).status,404);
 store.setMember(owner,project.id,viewer.id,null);subscribe(5,{known_head:next.id});assert.equal(ws.packets.at(-1).status,403);
});

test('repeated build reads retain digest guards after same-size tampering and reject symlinks',t=>{
 const dir=mkdtempSync(join(tmpdir(),'wa-stream-performance-')),path=join(dir,'artifact.zip');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const original=Buffer.from('original bytes'),entry={size:original.length,sha256:hash(original)};writeFileSync(path,original);
 const builds=Object.create(CreationBuilds.prototype),response=()=>({status:null,writeHead(status){this.status=status;},end(){this.ended=true;}});
 for(let i=0;i<2;i++){const res=response();builds.stream({method:'HEAD'},res,path,entry,'application/zip');assert.equal(res.status,200);assert.equal(res.ended,true);}
 const stat=statSync(path);writeFileSync(path,Buffer.alloc(original.length,120));utimesSync(path,stat.atime,stat.mtime);
 assert.throws(()=>builds.stream({method:'HEAD'},response(),path,entry,'application/zip'),error=>error.status===409);
 writeFileSync(path,original);const alias=join(dir,'alias.zip');symlinkSync(path,alias);
 assert.throws(()=>builds.stream({method:'HEAD'},response(),alias,entry,'application/zip'),error=>error.status===409);
 assert.throws(()=>builds.stream({method:'HEAD'},response(),path,{...entry,sha256:'bad'},'application/zip'),error=>error.status===409);
});

test('workspace reuses same-head immutable content and requests a full baseline on mismatch',()=>{
 const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8'),start=source.indexOf('function acceptBranch('),end=source.indexOf('function renderHeader(',start);
 const manifest={entry_scene_id:'a',resources:{a:{objects:[]}}},requests=[];
 const s={branch:{project_id:'p',branch_id:'main',head:'r1',manifest,doc_sequences:{a:1}},project:{id:'p',branches:[]},resourceId:'a',openResources:['a'],mode:'edit',copy:structuredClone,api:{subscribe:x=>requests.push(x)},prefabPlacement:null,doc:()=>({}),isHierarchy:()=>true,isNative:()=>false,resolvedDocument:()=>({}),short:String,$:()=>({textContent:''}),renderHeader(){},renderExplorer(){},renderStage(){},renderInspector(){},localEdit:null,scheduleIssues(){}};
 vm.createContext(s);vm.runInContext(source.slice(start,end),s);
 s.acceptBranch({project_id:'p',branch_id:'main',head:'r1',manifest_unchanged:true,doc_sequences:{a:1}});assert.equal(s.branch.manifest,manifest);
 s.acceptBranch({project_id:'p',branch_id:'main',head:'r2',manifest_unchanged:true,doc_sequences:{a:2}});assert.equal(s.branch.head,'r1');assert.equal(requests.length,1);assert.equal(requests[0].known_head,undefined);
 const next={...manifest,version:'new'};s.acceptBranch({project_id:'p',branch_id:'main',head:'r2',manifest:next,doc_sequences:{a:2}});assert.equal(s.branch.manifest,next);assert.equal(manifest.version,undefined);
 s.acceptBranch({project_id:'p',branch_id:'main',head:'r1',manifest,doc_sequences:{a:1}});assert.equal(s.branch.head,'r2');
});
