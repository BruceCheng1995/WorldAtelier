/** Real SQLite/files for authorization and browser-origin tests only.
 * Web bytes are an explicitly synthetic HTML probe, not a Godot export. */
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeSourceArchive,nativeSourceIdentity} from '../../services/creation/native-source.mjs';
import {GAME_PROJECT_CONTRACT} from '../../services/creation/project-snapshot.mjs';
import {CANONICAL_WEB_POLICY} from '../../tools/canonical-game-web.mjs';
import {hash} from '../../services/creation/schema.mjs';

const syntheticHTML=`<!doctype html><html><head><meta charset="utf-8"><title>Independent runtime origin probe</title></head><body><canvas width="400" height="300"></canvas><script src="probe.js"></script></body></html>`;
const syntheticProbe=`(() => {
 const result=window.__nextWaveThinProbe={origin:location.origin,secure_context:isSecureContext};
 for(const [key,read] of [
  ['creator_dom',()=>top.document.body],
  ['creator_session',()=>top.sessionStorage.getItem('world-atelier-creator-token')],
  ['creator_local',()=>top.localStorage.getItem('next-wave-private-marker')],
  ['own_session',()=>sessionStorage.getItem('world-atelier-creator-token')]
 ]) { try {result[key]={readable:true,present:!!read()};} catch(error){result[key]={readable:false,error:error.name};} }
 let configuration;
 try{configuration=JSON.parse(parent.document.querySelector('#runtime-config').textContent);result.runtime_wrapper_readable=true;}catch(error){result.runtime_wrapper_readable=false;}
 const attempt=async(key,url)=>{try{const response=await fetch(url,{credentials:'include',cache:'no-store'});result[key]={readable:true,status:response.status,ok:response.ok};}catch(error){result[key]={readable:false,error:error.name};}};
 const creator=configuration?.parent_origin;
 const requests=[attempt('runtime_api',location.origin+'/creation-api/bootstrap'),attempt('runtime_admin',location.origin+'/creation-api/admin/overview')];
 if(creator&&new URL(creator).port==='48921')requests.push(attempt('creator_admin',creator+'/creation-api/admin/overview'));
 const canvas=document.querySelector('canvas'),context=canvas.getContext('2d');context.fillStyle='#274970';context.fillRect(0,0,400,300);context.fillStyle='white';context.fillText('ORIGIN PROBE - NOT GODOT',30,100);
 if(configuration){const script=parent.document.createElement('script');script.src=new URL('escalate.js',location.href).href;parent.document.body.append(script);}
 Promise.all(requests).then(()=>{result.completed=true;console.log('NEXT_WAVE_THIN_PROBE '+JSON.stringify(result));});
})();`;
const escalate=`(() => {
 const configuration=JSON.parse(document.querySelector('#runtime-config').textContent);
 window.__nextWaveWrapperCompromised=true;
 // The same-runtime inner author can execute in the wrapper. The creator-side
 // bridge, not this wrapper, must reject these forbidden commands.
 for(const type of ['history','transform','read_creator_secret','fetch'])parent.postMessage({source:'world-atelier-game',nonce:configuration.launch_nonce,type,action:'undo',url:'/creation-api/admin/overview',canonical_identity:configuration.canonical_identity},configuration.parent_origin);
})();`;

export function seedRuntimeFixture(creationData,{name='runtime-boundary'}={}) {
  mkdirSync(creationData,{recursive:true});
  const store=new CreationStore(join(creationData,'creation.sqlite'));
  try {
    const accounts={};
    for(const role of ['owner','editor','viewer','player']){
      const credentials={name:`${name}-${role}-${randomUUID().slice(0,6)}`,password:randomUUID()+randomUUID()};
      accounts[role]={...store.register(credentials),credentials};
    }
    const archive=new NativeSourceArchive(join(creationData,'native-source/objects'));
    const config='config_version=5\n[application]\nconfig/name="Independent origin fixture"\nrun/main_scene="res://scene.tscn"\n';
    const source_files={'project.godot':archive.put(config),'scene.tscn':archive.put('[gd_scene format=3]\n[node name="World" type="Node2D"]\nmetadata/wa_node_id="world"\n')};
    const identity=nativeSourceIdentity(source_files),manifest={schema:'creation-native-1',source_files,source_identity:identity,index_source_identity:identity,entry_scene_id:'entry',resources:{entry:{id:'entry',kind:'scene',name:'Synthetic authorization fixture',path:'scene.tscn',native_nodes:[]}}};
    const created=store.createProject(accounts.owner.user,{name:'Independent runtime boundary'},manifest),p=created.project.id,project=store.get('creator_project',p);
    project.members[accounts.editor.user.id]='editor';project.members[accounts.viewer.user.id]='viewer';store.put('creator_project',project);
    const id='build-'+randomUUID(),directory=join(creationData,'builds',id);mkdirSync(join(directory,'web'),{recursive:true});mkdirSync(join(directory,'project'),{recursive:true});
    writeFileSync(join(directory,'project/project.godot'),config);
    const contents={'index.html':syntheticHTML,'probe.js':syntheticProbe,'escalate.js':escalate,'index.wasm':'SYNTHETIC AUTHORIZATION BYTES NOT WASM','index.pck':'SYNTHETIC AUTHORIZATION BYTES NOT PCK'};
    const web_files=Object.entries(contents).map(([path,value])=>{const bytes=Buffer.from(value);writeFileSync(join(directory,'web',path),bytes);return{path,sha256:hash(bytes),size:bytes.length};});
    const zip=Buffer.from('SYNTHETIC ZIP FOR AUTHORIZATION ONLY');writeFileSync(join(directory,'web.zip'),zip);
    const runtime_sources=[{path:'standalone.gd',sha256:hash('fixture-only'),size:12}],runtime_source_hash=hash(runtime_sources);
    const gameIdentity={format:1,contract:GAME_PROJECT_CONTRACT,project_id:p,branch_id:'main',source_revision:created.branch.head,entry_scene_id:'entry',runtime_source_hash};
    const content_key=hash(gameIdentity);
    const job={id,kind:'application',purpose:'play',project_id:p,project_name:project.name,branch_id:'main',source_revision:created.branch.head,entry_scene_id:'entry',targets:['web'],actor_id:accounts.owner.user.id,status:'completed',created_at:Date.now(),game_project_contract:GAME_PROJECT_CONTRACT,game_identity:{...gameIdentity,content_key},content_key,canonical_identity:content_key,runtime_sources,runtime_source_hash,
      storage:{namespace:'independent-origin-save-domain'},
      source_files:[{path:'project.godot',sha256:hash(config),size:Buffer.byteLength(config)},...['atelier_runtime/standalone.gd','atelier_runtime/standalone.tscn','atelier_runtime/release.json','atelier_runtime/source-manifest.json'].map(path=>({path,sha256:hash(path),size:path.length}))],
      web_files,artifacts:[{id:'web',target:'web',filename:'web.zip',sha256:hash(zip),size:zip.length}],target_results:[{target:'web',status:'completed'}],canonical_web:{policy:CANONICAL_WEB_POLICY,content_key,adapted_html_sha256:web_files.find(file=>file.path==='index.html').sha256},web_compatibility:{policy:'world-atelier-single-thread-local-http-v1'}};
    store.put('creator_build',job);
    // This simulates an already-issued historical access cookie so the public
    // legacy URL path can be tested; it is never counted as a new login.
    const legacyToken=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
    store.put('creator_build_access',{id:hash(legacyToken),job_id:id,user_id:accounts.owner.user.id,expires_at:Date.now()+3600000});
    return{accounts,project_id:p,branch_id:'main',job,legacyToken,manifest,projectConfig:config,creationData};
  } finally {store.close();}
}
