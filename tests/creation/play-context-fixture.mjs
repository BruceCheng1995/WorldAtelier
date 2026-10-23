// Real SQLite and observation service, explicit build/source fixtures. These
// prove storage and authorization boundaries, not Godot or paid Agent behavior.
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {SessionImages} from '../../services/creation/session-images.mjs';
import {PlayObservations} from '../../services/creation/play-observations.mjs';
import {SessionContinuations} from '../../services/creation/session-continuations.mjs';
import {PLAY_CONTEXT_PROTOCOL} from '../../packages/contracts/play-context.mjs';
import {nativeObjects} from '../../services/creation/native-reference.mjs';
import {nativeSourceIdentity} from '../../services/creation/native-source.mjs';

export const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
export function contextFixture(t,{liveTimeout=100,now=()=>Date.now()}={}){
  const data=mkdtempSync(join(tmpdir(),'wa-play-context-')),store=new CreationStore(join(data,'creation.sqlite'));
  const owner={id:'owner',name:'Owner'},other={id:'other',name:'Other'},viewer={id:'viewer',name:'Viewer'};
  for(const user of [owner,other,viewer])store.put('creator_user',user);
  const node={addressable:true,node_id:'door',instance_ids:[],path:'.',type:'Node3D',name:'Door',metadata:{},properties:[],version:'door-v1',key:'door',
    local_transform:{$type:'Transform3D',basis:[[1,0,0],[0,1,0],[0,0,1]],origin:[0,0,0]},world_transform:{$type:'Transform3D',basis:[[1,0,0],[0,1,0],[0,0,1]],origin:[0,0,0]}};
  const manifest={schema:'creation-native-1',source_identity:'fixed-source',index_source_identity:'fixed-source',entry_scene_id:'room',
    source_files:{'door.tscn':{hash:'a'.repeat(64),size:1}},resources:{room:{id:'room',name:'Room',kind:'scene',path:'room.tscn',version:'room-v1',native_nodes:[node]},
      door:{id:'door',name:'Door prefab',kind:'prefab',path:'door.tscn',version:'prefab-v1',native_nodes:[node]}}};
  manifest.source_identity=manifest.index_source_identity=nativeSourceIdentity(manifest.source_files);
  const project=store.createProject(owner,{name:'Observation fixture'},manifest).project,p=project.id;
  store.setMember(owner,p,other.id,'editor');store.setMember(owner,p,viewer.id,'viewer');
  const revision=store.get('creator_revision',store.branchFor(owner,p,'main').head);
  const session=store.createSession(owner,p,'main',{title:'Private play',visibility:'private'});
  const build={id:'build-fixed',project_id:p,branch_id:'main',source_revision:revision.id,entry_scene_id:'room',canonical_identity:'b'.repeat(64),status:'completed'};
  const service={store,data,builds:{forUser(user,id){store.branchFor(user,p,'main');if(id!==build.id)throw Object.assign(Error('build missing'),{status:404});return build;}}};
  service.sessionImages=new SessionImages({store,data});service.observations=new PlayObservations({service,now,liveTimeout});service.continuations=new SessionContinuations({service});
  t.after(()=>{service.observations.close();store.close();rmSync(data,{recursive:true,force:true});});
  const scope={project_id:p,branch_id:'main',source_revision:revision.id,build_id:build.id,runtime_instance_id:'play-run-one',resource_id:'room',scene_generation:1,canonical_identity:build.canonical_identity,session_kind:'local_preview'};
  const row=nativeObjects(revision.manifest,{project_id:p,branch_id:'main',resource_id:'room'})[0];
  let serial=0;
  const capture=(patch={})=>({protocol:PLAY_CONTEXT_PROTOCOL,request_id:`capture-${++serial}`,scope:{...scope},captured_at:Date.now(),window:{requested_seconds:60,start_ms:1000,end_ms:61000},
    events:[{id:'e1',at_ms:5000,kind:'pointer_down',source:'user_input',resource_id:'room',scene_generation:1,payload:{button:1,position:[.4,.5]}}],
    snapshot:{objects:[{runtime_id:'node-one',name:'Door',position:[3,0,0],source:{address:row.address,object_version:row.version}}],tick:120,scene_generation:1,resource_id:'room'},
    frames:[{id:'frame-one',at_ms:60000,captured_at:Date.now(),data_url:pixel,resource_id:'room',scene_generation:1}],focus:{kind:'screen_region',rect:[.2,.2,.2,.2],runtime_ids:['node-one']},gaps:[],...patch});
  return {data,store,owner,other,viewer,p,revision,session,scope,build,row,service,capture};
}
