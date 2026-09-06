import http from 'node:http';
import {WebSocketServer} from 'ws';
import {randomUUID,randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {readFileSync,existsSync,createReadStream,statSync,mkdirSync} from 'node:fs';
import {resolve,join,extname,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Storage} from './storage.mjs';
import {validateContent,mergeContent,digest} from './content.mjs';
import {Builds} from './builds.mjs';
import {Worlds} from '../world-orchestrator/worlds.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const data=resolve(process.env.WORLD_ATELIER_DATA??join(root,'.local/server'));
const port=Number(process.env.WORLD_ATELIER_PORT??48900);
const godot=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot';
mkdirSync(data,{recursive:true});
const store=new Storage(join(data,'world-atelier.sqlite'));
const worlds=new Worlds({store,root,data,port,godot});
const builds=new Builds({store,root,data,godot});
const clients=new Set(),controls=new Map(),pendingCommands=new Map(),pendingHttp=new Map();
const id=prefix=>prefix+'_'+randomUUID();
const fault=(status,message,details)=>Object.assign(Error(message),{status,details});
const publicUser=u=>({id:u.id,name:u.name});
const slug=value=>{if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value))throw fault(400,'Use a branch name with letters, numbers, - or _');return value;};
const membership=(project,user,write=false)=>{if(!project)throw fault(404,'Project not found');const role=project.members[user.id];if(!role)throw fault(403,'Project membership required');if(write&&!['owner','editor'].includes(role))throw fault(403,'Editor permission required');return role;};
const auth=req=>{const token=(req.headers.authorization??'').replace(/^Bearer /,'');const session=store.get('session',digest(token));if(!session||session.expires_at<Date.now())throw fault(401,'Sign in required');const u=store.get('user',session.user_id);if(!u)throw fault(401,'Account missing');return u;};
const branchFor=(project_id,name)=>{const b=store.get('branch',project_id+':'+name);if(!b)throw fault(404,'Branch not found');return b;};
const projectFor=(project_id,user,write=false)=>{const p=store.get('project',project_id);membership(p,user,write);return p;};
function json(res,status,value) {
  if(res.operation){const operation={...res.operation,status:'complete',response_status:status,response:value,finished_at:Date.now()};store.put('operation',operation);pendingHttp.get(operation.id)?.resolve(operation);pendingHttp.delete(operation.id);res.setHeader('X-Operation-ID',operation.id);res.operation=null;}
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function body(req) {if(Object.hasOwn(req,'parsedBody'))return req.parsedBody;let text='';for await(const chunk of req){text+=chunk;if(text.length>5_000_000)throw fault(413,'Request too large');}try{req.parsedBody=text?JSON.parse(text):{};return req.parsedBody;}catch{throw fault(400,'Invalid JSON');}}
function session(user) {const token=randomBytes(32).toString('hex');store.put('session',{id:digest(token),user_id:user.id,expires_at:Date.now()+7*86400000});return {token,user:publicUser(user)};}
function revision(project_id,content,parents,author,message) {const item={id:'rev_'+digest({project_id,content,parents}).slice(0,24),project_id,content,parents,author,message,created_at:Date.now()};store.put('revision',item);return item;}
function commonAncestor(a,b) {const seen=new Set(),walk=[a];while(walk.length){const key=walk.pop();if(seen.has(key))continue;seen.add(key);walk.push(...(store.get('revision',key)?.parents??[]));}const remote=[b];while(remote.length){const key=remote.shift();if(seen.has(key))return store.get('revision',key);remote.push(...(store.get('revision',key)?.parents??[]));}throw fault(409,'Branches do not have a common base');}
function commitContent(project,branch,b,user,importing=false) {
  if(importing&&(b.project_id!==project.id||b.branch!==branch.name))throw fault(409,'Offline workspace belongs to another project or branch');
  validateContent(b.content);const base=store.get('revision',b.base_revision);
  if(!base||base.project_id!==project.id)throw fault(409,'Unknown workspace base revision');
  const remote=store.get('revision',branch.source_head),merged=mergeContent(base.content,b.content,remote.content);
  if(merged.conflicts.length)throw fault(409,'Content conflicts require resolution',{conflicts:merged.conflicts,remote_revision:remote.id});
  validateContent(merged.content);
  const rev=revision(project.id,merged.content,[remote.id],user.name,b.message??'场景编辑');branch.source_head=rev.id;store.put('branch',branch);
  store.event(project.id,{kind:'commit',title:b.message??'场景编辑',branch:branch.name,actor:user.name,revision:rev.id});return {revision:rev.id,content:rev.content,conflicts:[]};
}
async function createWorld(project,branch,name,checkpoint=null,origin=null) {
  if(!branch.playable_head)throw fault(409,'Build a playable release first');
  const w={id:id('world'),project_id:project.id,branch:branch.name,name:name??branch.name+' · 共享世界',release_id:branch.playable_head,epoch:0,sequence:0,durable_sequence:0,status:'starting',state:checkpoint?structuredClone(checkpoint):null,state_origin:origin,created_at:Date.now()};
  store.put('world',w);if(!branch.default_world){branch.default_world=w.id;store.put('branch',branch);}await worlds.start(w);return store.get('world',w.id);
}
function sanitizeWorld(w){if(!w)return null;return {...w,state:w.state??null};}
function staticFile(res,path,immutable=false) {
  if(!existsSync(path)||!statSync(path).isFile())throw fault(404,'File not found');
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.pck':'application/octet-stream','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.zip':'application/zip','.ico':'image/x-icon'};
  res.writeHead(200,{'Content-Type':types[extname(path)]??'application/octet-stream','Content-Length':statSync(path).size,'Cache-Control':immutable?'public,max-age=31536000,immutable':'no-cache'});createReadStream(path).pipe(res);
}
function inside(base,path){const value=resolve(base,path);if(value!==base&&!value.startsWith(base+'/'))throw fault(403,'Invalid path');return value;}
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');res.setHeader('X-Content-Type-Options','nosniff');
  try {
    const url=new URL(req.url,`http://127.0.0.1:${port}`),p=url.pathname.split('/').filter(Boolean).map(decodeURIComponent),method=req.method;
    if(url.pathname==='/health')return json(res,200,{ok:true,version:'0.1.0',worlds:worlds.hosts.size});
    if(p[0]==='artifacts') {
      if(!/^[a-f0-9]{64}$/.test(p[1]??''))throw fault(404,'Artifact not found');
      return staticFile(res,inside(join(root,'.local/artifacts'),p.slice(1).join('/')),true);
    }
    if(p[0]!=='api'&&p[0]!=='content') {
      const base=join(root,'apps/portal/dist'),file=inside(base,p.join('/'));
      if(existsSync(file)&&statSync(file).isFile())return staticFile(res,file);
      return staticFile(res,join(base,'index.html'));
    }
    if(p[1]==='auth'&&method==='POST') {
      const b=await body(req);if(typeof b.name!=='string'||b.name.trim().length<2||b.name.length>40||typeof b.password!=='string'||b.password.length<8||b.password.length>200)throw fault(400,'Name must be 2–40 characters; password at least 8 characters');
      const name=b.name.trim();let user=store.list('user').find(x=>x.name===name);
      if(p[2]==='register') {if(user)throw fault(409,'Name already registered');const salt=randomBytes(16).toString('hex');user={id:id('user'),name,salt,password_hash:scryptSync(b.password,salt,64).toString('hex')};store.put('user',user);return json(res,201,session(user));}
      if(p[2]==='login') {if(!user||!timingSafeEqual(Buffer.from(user.password_hash,'hex'),scryptSync(b.password,user.salt,64)))throw fault(401,'Incorrect name or password');return json(res,200,session(user));}
      throw fault(404,'Unknown authentication route');
    }
    const user=auth(req);
    if(method!=='GET')await body(req);
    if(method!=='GET'&&req.headers['idempotency-key']){
      const key=String(req.headers['idempotency-key']);if(key.length>100)throw fault(400,'Idempotency key too long');
      const fingerprint=digest({method,path:url.pathname,body:await body(req)}),operation_id=digest({user_id:user.id,key});
      const previous=store.get('operation',operation_id);
      if(previous){
        if(previous.fingerprint!==fingerprint)throw fault(409,'Idempotency key reused with different request');
        const result=previous.status==='complete'?previous:pendingHttp.has(operation_id)?await pendingHttp.get(operation_id).promise:null;
        if(!result)throw fault(409,'Operation outcome needs recovery; inspect original operation',{operation_id});
        return json(res,result.response_status,result.response);
      }
      res.operation={id:operation_id,user_id:user.id,fingerprint,status:'running',method,path:url.pathname,created_at:Date.now()};store.put('operation',res.operation);
      let finish;const promise=new Promise(resolve=>finish=resolve);pendingHttp.set(operation_id,{promise,resolve:finish});
    }
    if(p[1]==='operations'&&p[2]&&method==='GET'){const operation=store.get('operation',p[2]);if(!operation||operation.user_id!==user.id)throw fault(404,'Operation not found');return json(res,200,{operation});}

    if(p[0]==='content') {const rel=store.list('release').find(r=>r.content_hash===p[1]&&store.get('project',r.project_id)?.members[user.id]);if(!rel)throw fault(403,'Artifact permission required');return staticFile(res,join(data,'artifacts',rel.content_hash,'content.json'),true);}
    if(p[1]==='me')return json(res,200,{user:publicUser(user)});
    if(p[1]==='projects'&&p.length===2) {
      if(method==='GET')return json(res,200,{projects:store.list('project').filter(x=>x.members[user.id]).map(x=>({...x,role:x.members[user.id]}))});
      if(method==='POST') {const b=await body(req);if(typeof b.name!=='string'||!b.name.trim()||b.name.length>80)throw fault(400,'Project name required');const path=join(root,'content/world.json');if(!existsSync(path))throw fault(503,'Game content is not installed yet');const content=validateContent(JSON.parse(readFileSync(path,'utf8')));const project={id:id('project'),name:b.name,members:{[user.id]:'owner'},created_at:Date.now()};store.transaction(()=>{store.put('project',project);const rev=revision(project.id,content,[],user.name,'初始世界');store.put('branch',{id:project.id+':main',project_id:project.id,name:'main',source_head:rev.id,playable_head:null,publish_generation:0,default_world:null});store.event(project.id,{kind:'project',title:'建立世界工程',actor:user.name});});return json(res,201,{project});}
    }
    if(p[1]==='projects'&&p[2]) {
      const project=projectFor(p[2],user,method!=='GET'&&p[3]!=='checkouts');
      if(p.length===3&&method==='GET')return json(res,200,{project:{...project,role:project.members[user.id]},branches:store.list('branch').filter(x=>x.project_id===project.id),releases:store.list('release').filter(x=>x.project_id===project.id),worlds:store.list('world').filter(x=>x.project_id===project.id).map(w=>({...w,state:undefined})),tasks:store.list('task').filter(x=>x.project_id===project.id),builds:store.list('build').filter(x=>x.project_id===project.id),members:Object.entries(project.members).map(([uid,role])=>({...publicUser(store.get('user',uid)),role})),activity:store.activity(project.id)});
      if(p[3]==='members'&&method==='POST') {if(project.members[user.id]!=='owner')throw fault(403,'Owner permission required');const b=await body(req),member=store.list('user').find(u=>u.name===b.name);if(!member)throw fault(404,'Collaborator must register first');if(!['editor','tester','viewer'].includes(b.role)||project.members[member.id]==='owner')throw fault(400,'Invalid role change');project.members[member.id]=b.role;store.put('project',project);store.event(project.id,{kind:'member',title:`${member.name} · ${b.role}`,actor:user.name});return json(res,200,{member:{...publicUser(member),role:b.role}});}
      if(p[3]==='branches') {
        if(p.length===4&&method==='POST') {const b=await body(req),name=slug(b.name),from=branchFor(project.id,b.from_branch??'main');if(store.get('branch',project.id+':'+name))throw fault(409,'Branch exists');const branch={...from,id:project.id+':'+name,name,default_world:null,publish_generation:0,fork_revision:from.source_head};store.put('branch',branch);store.event(project.id,{kind:'branch',title:`创建分支 ${name}`,actor:user.name});return json(res,201,{branch});}
        const branch=branchFor(project.id,p[4]);
        if(p[5]==='content'&&method==='GET'){const rev=store.get('revision',branch.source_head);return json(res,200,{revision:rev.id,content:rev.content});}
        if(p[5]==='offline'&&method==='GET'){const rev=store.get('revision',branch.source_head),release=store.get('release',branch.playable_head),world=store.get('world',branch.default_world);return json(res,200,{format:1,user_id:user.id,project_id:project.id,branch:branch.name,base_revision:rev.id,content:rev.content,release_id:branch.playable_head,release,state_seed:world?.release_id===release?.id?world?.state:null,state_seed_release:world?.release_id===release?.id?release?.id:null,exported_at:Date.now()});}
        if(['commit','import'].includes(p[5])&&method==='POST'){const b=await body(req);return json(res,200,store.transaction(()=>commitContent(project,branch,b,user,p[5]==='import')));}
        if(p[5]==='build'&&method==='POST')return json(res,202,{build:builds.schedule(project,branch,user)});
        if(p[5]==='merge'&&method==='POST') {const b=await body(req),target=branchFor(project.id,b.target??'main');if(target.id===branch.id)throw fault(400,'Choose a different target branch');const base=commonAncestor(branch.source_head,target.source_head),local=store.get('revision',branch.source_head),remote=store.get('revision',target.source_head),merged=mergeContent(base.content,local.content,remote.content);if(merged.conflicts.length)throw fault(409,'Branch merge conflicts',{conflicts:merged.conflicts});validateContent(merged.content);const rev=revision(project.id,merged.content,[target.source_head,branch.source_head],user.name,`合并 ${branch.name}`);target.source_head=rev.id;store.put('branch',target);store.event(project.id,{kind:'merge',title:`${branch.name} → ${target.name}`,actor:user.name});return json(res,200,{revision:rev.id,branch:target});}
      }
      if(p[3]==='worlds'&&method==='POST'){const b=await body(req);let source=null;if(b.from_world){source=store.get('world',b.from_world);if(!source||source.project_id!==project.id)throw fault(403,'Checkpoint source is outside project');}return json(res,201,{world:await createWorld(project,branchFor(project.id,b.branch??'main'),b.name,source?.state,source?{world_id:source.id,release_id:source.release_id,sequence:source.sequence,epoch:source.epoch}:null)});}
      if(p[3]==='tasks'&&method==='POST'){const b=await body(req),branch=branchFor(project.id,b.branch??'main'),content=store.get('revision',branch.source_head).content;if(!content.objects.some(o=>o.id===b.object_id))throw fault(400,'Task object not found');if(typeof b.title!=='string'||!b.title.trim()||b.title.length>1000)throw fault(400,'Task description required');const task={id:id('task'),project_id:project.id,branch:branch.name,object_id:b.object_id,title:b.title,status:'editing',author:user.name,created_at:Date.now(),base_revision:branch.source_head};store.put('task',task);for(const w of store.list('world').filter(w=>w.project_id===project.id&&w.branch===branch.name))worlds.tasks(w.id);store.event(project.id,{kind:'task',title:b.title,actor:user.name,object_id:b.object_id});return json(res,201,{task});}
      if(p[3]==='checkouts'&&method==='POST') {
        const b=await body(req),branch=branchFor(project.id,b.branch??'main'),release=store.get('release',branch.playable_head);
        if(!release)throw fault(409,'No playable release yet');if(!['web','macos'].includes(b.platform)||!['join-live','preview-frozen','offline'].includes(b.mode))throw fault(400,'Invalid checkout mode/platform');
        if(!release.artifacts.some(a=>a.platform===b.platform))throw fault(409,'This platform has no verified export');
        let world=null;
        if(b.mode==='join-live'){world=store.get('world',b.world_id??branch.default_world);if(world&&(world.project_id!==project.id||world.branch!==branch.name))throw fault(403,'World does not belong to target branch');if(!world)world=await createWorld(project,branch);if(world.release_id!==release.id)throw fault(409,'Apply latest release to world before entering latest');if(world.status!=='running')world=await worlds.start(world);}
        if(b.mode==='preview-frozen'){const original=store.get('world',branch.default_world);world=await createWorld(project,branch,`${user.name} · 独立试玩`,original?.state,original?{world_id:original.id,release_id:original.release_id,sequence:original.sequence,epoch:original.epoch}:null);}
        const checkout={id:id('checkout'),project_id:project.id,user_id:user.id,branch:branch.name,release_id:release.id,world_id:world?.id??null,platform:b.platform,mode:b.mode,expires_at:Date.now()+30*60000};store.put('checkout',checkout);
        return json(res,201,{checkout,release,artifacts:release.artifacts,world:world?{...world,state:undefined}:null});
      }
    }
    if(p[1]==='tasks'&&p[2]&&method==='PATCH'){const task=store.get('task',p[2]);if(!task)throw fault(404,'Task not found');projectFor(task.project_id,user,true);const b=await body(req);if(!['editing','testing','failed'].includes(b.status))throw fault(400,'Delivered status requires a verified world application');task.status=b.status;task.updated_at=Date.now();store.put('task',task);for(const w of store.list('world').filter(w=>w.project_id===task.project_id&&w.branch===task.branch))worlds.tasks(w.id);return json(res,200,{task});}
    if(p[1]==='worlds'&&p[2]){const w=store.get('world',p[2]);if(!w)throw fault(404,'World not found');projectFor(w.project_id,user,method!=='GET');if(method==='GET')return json(res,200,{world:sanitizeWorld(w)});if(p[3]==='apply-latest'&&method==='POST'){const branch=branchFor(w.project_id,w.branch),release=store.get('release',branch.playable_head);if(!release)throw fault(409,'No playable release');if(release.runtime_hash!==store.get('release',w.release_id).runtime_hash)throw fault(409,'Runtime changed; prepare a new world/client transfer');const result=await worlds.apply(w.id,release);if(!result.ok)throw fault(422,result.error??'Authority rejected update');for(const task of store.list('task').filter(t=>t.project_id===w.project_id&&t.branch===w.branch&&t.status==='testing')){const base=store.get('revision',task.base_revision)?.content.objects.find(o=>o.id===task.object_id),current=store.get('revision',release.revision).content.objects.find(o=>o.id===task.object_id);if(digest(base??null)!==digest(current??null)){task.status='delivered';task.release_id=release.id;task.applied_sequence=result.sequence;store.put('task',task);}}worlds.tasks(w.id);store.event(w.project_id,{kind:'world_applied',title:`世界已应用 ${release.id}`,world_id:w.id,sequence:result.sequence});return json(res,200,{ok:true,world:store.get('world',w.id),sequence:result.sequence});}}
    if(p[1]==='checkouts'&&p[2]&&p[3]==='prepare-join'&&method==='POST') {
      const c=store.get('checkout',p[2]);if(!c||c.user_id!==user.id)throw fault(404,'Checkout not found');projectFor(c.project_id,user);if(c.expires_at<Date.now())throw fault(410,'Checkout expired');const w=store.get('world',c.world_id);if(!w||w.status!=='running')throw fault(409,'Target world not ready');if(w.release_id!==c.release_id)throw fault(409,'World updated during download; resolve a new checkout');const ticket=randomBytes(32).toString('hex');store.put('ticket',{id:digest(ticket),user_id:user.id,project_id:c.project_id,world_id:w.id,release_id:c.release_id,expires_at:Date.now()+120000,used:false});const rel=store.get('release',c.release_id),server_url=`ws://127.0.0.1:${port}`;return json(res,200,{ticket,world_id:w.id,release_id:c.release_id,server_url,game_url:`/artifacts/${rel.runtime_hash}/web/index.html?server=${encodeURIComponent(server_url)}&ticket=${ticket}`});
    }
    throw fault(404,'Route not found');
  }catch(e){if(!res.headersSent)json(res,e.status??400,{error:e.message,...(e.details?{details:e.details}:{})});else res.end();}
});
const wss=new WebSocketServer({noServer:true,maxPayload:5_000_000});
server.on('upgrade',(req,socket,head)=>{if(!['/host','/play'].includes(req.url)){socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>{ws.route=req.url;wss.emit('connection',ws,req);});});
const send=(socket,msg)=>{if(socket.readyState===1)socket.send(JSON.stringify(msg));};
function releaseClient(socket,reason) {socket.active=false;socket.revoked=true;send(socket,{type:'revoked',reason});}
async function activate(socket,msg) {
  if(socket.revoked)throw Error('This connection was revoked; request a new ticket');
  if(socket.activating)return;
  if(!socket.pending_load){if(socket.active)send(socket,{type:'active',world_id:socket.world_id,release_id:socket.release_id,epoch:store.get('world',socket.world_id).epoch,control_generation:socket.control_generation});return;}
  const w=store.get('world',socket.world_id);if(msg.release_id!==w.release_id)throw Error('Client loaded incorrect release');projectFor(w.project_id,socket.user);
  socket.activating=true;
  try {
    const old=controls.get(socket.user.id);
    if(old&&old!==socket){old.active=false;await worlds.command(old.world_id,old.user.id,'move',{x:0,z:0});releaseClient(old,'Control transferred to another client');}
    worlds.join(w.id,socket.user);
    const control=store.get('control',socket.user.id)??{id:socket.user.id,generation:0};control.generation++;control.world_id=w.id;control.updated_at=Date.now();store.put('control',control);
    socket.control_generation=control.generation;socket.release_id=w.release_id;socket.active=true;socket.pending_load=false;socket.revoked=false;controls.set(socket.user.id,socket);
    send(socket,{type:'active',world_id:w.id,release_id:w.release_id,epoch:w.epoch,control_generation:control.generation});
  }finally{socket.activating=false;}
}
wss.on('connection',socket=>{
  let authenticated=false;const timer=setTimeout(()=>{if(!authenticated)socket.close(1008,'Handshake timeout');},5000);
  socket.on('message',async raw=>{try {
    const msg=JSON.parse(raw.toString());
    if(socket.route==='/host'){if(!authenticated){if(msg.type!=='host_hello')throw Error('Authority hello required');worlds.attach(socket,msg);authenticated=!!socket.world_id;clearTimeout(timer);}else worlds.receive(socket,msg);return;}
    if(!authenticated){if(msg.type!=='hello')throw Error('Client hello required');const ticket=store.get('ticket',digest(msg.ticket??''));if(!ticket||ticket.used||ticket.expires_at<Date.now())throw Error('Invalid or expired join ticket');const user=store.get('user',ticket.user_id);projectFor(ticket.project_id,user);const w=store.get('world',ticket.world_id);if(w.status!=='running'||w.release_id!==ticket.release_id)throw Error('Target world version changed');ticket.used=true;store.put('ticket',ticket);Object.assign(socket,{world_id:w.id,user,release_id:w.release_id,active:false,revoked:false,pending_load:true});authenticated=true;clearTimeout(timer);clients.add(socket);const rel=store.get('release',w.release_id);send(socket,{type:'welcome',user_id:user.id,world_id:w.id,epoch:w.epoch,release_id:w.release_id,content:store.get('revision',rel.revision).content,state:w.state,control_generation:0});return;}
    if(msg.type==='loaded'){await activate(socket,msg);return;}
    if(msg.type!=='command')return;
    const w=store.get('world',socket.world_id);projectFor(w.project_id,socket.user);
    if(!socket.active||socket.revoked||controls.get(socket.user.id)!==socket||msg.release_id!==w.release_id||msg.epoch!==w.epoch||msg.control_generation!==socket.control_generation)throw Error('Stale control or content version');
    if(typeof msg.request_id!=='string'||msg.request_id.length>100)throw Error('Command request ID required');
    if(!['move','attack','dash','interact','select','upgrade'].includes(msg.action))throw Error('Unknown gameplay action');
    const cacheKey=socket.user.id+':'+msg.request_id,previous=store.get('command',cacheKey);
    if(previous){send(socket,previous.response);return;}
    if(pendingCommands.has(cacheKey)){send(socket,await pendingCommands.get(cacheKey));return;}
    const now=Date.now();if(now-(socket.rate_time??0)>1000){socket.rate_time=now;socket.rate_count=0;}if(++socket.rate_count>45)throw Error('Input rate exceeded');
    if((socket.in_flight??0)>10)throw Error('Too many pending inputs');socket.in_flight=(socket.in_flight??0)+1;
    const operation=worlds.command(w.id,socket.user.id,msg.action,msg.payload??{}).then(result=>{const response={type:'ack',request_id:msg.request_id,ok:!!result.ok,error:result.error,sequence:result.sequence};store.put('command',{id:cacheKey,response,created_at:Date.now()});return response;});pendingCommands.set(cacheKey,operation);
    try {send(socket,await operation);}finally{pendingCommands.delete(cacheKey);socket.in_flight--;}
  }catch(e){send(socket,{type:'error',error:e.message});}});
  socket.on('close',()=>{clearTimeout(timer);clients.delete(socket);if(socket.user&&controls.get(socket.user.id)===socket){controls.delete(socket.user.id);worlds.command(socket.world_id,socket.user.id,'move',{x:0,z:0}).catch(()=>{});}});
});
worlds.on('snapshot',w=>{for(const socket of clients)if(socket.world_id===w.id)send(socket,{type:'snapshot',epoch:w.epoch,release_id:w.release_id,state:w.state,sequence:w.sequence});});
worlds.on('content',w=>{const rel=store.get('release',w.release_id);for(const socket of clients)if(socket.world_id===w.id){socket.active=false;socket.pending_load=!socket.revoked;send(socket,{type:'content',release_id:w.release_id,content:store.get('revision',rel.revision).content});}});
worlds.on('failure',({world_id,error})=>{for(const socket of clients)if(socket.world_id===world_id){socket.active=false;send(socket,{type:'error',error});}});
server.listen(port,'127.0.0.1',()=>{console.log(`World Atelier ready http://127.0.0.1:${port}`);for(const w of store.list('world'))if(['running','starting'].includes(w.status))worlds.start(w).catch(e=>console.error(w.id,e.message));});
let shuttingDown=false;
async function shutdown(){if(shuttingDown)return;shuttingDown=true;for(const s of clients)s.close(1001,'Server stopping');await worlds.stop();wss.close();server.close(()=>{store.close();process.exit(0);});setTimeout(()=>process.exit(0),2500).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
