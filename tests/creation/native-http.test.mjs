import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {WebSocket} from 'ws';
import {CreationService} from '../../services/creation/service.mjs';
import {hash} from '../../services/creation/schema.mjs';

test('native framework real HTTP/WS: two authors, guarded properties and native source bytes',{timeout:180000},async t=>{
  const root=resolve(import.meta.dirname,'../..'),port=48921,origin=`http://127.0.0.1:${port}`,data=mkdtempSync(join(tmpdir(),'atelier-native-http-'));
  const evidence=join(root,'.local/creation-verification/native-framework','http-'+crypto.randomUUID());mkdirSync(evidence,{recursive:true});
  const report={scope:'Real authenticated HTTP/WS + Godot editor + SQLite; no browser UI, gameplay or Agent execution',port,data,cases:[],source_hashes:{},completed:false};
  for(const path of ['services/creation/native-source.mjs','services/creation/native-transactions.mjs','services/creation/native-project.mjs','services/creation/service.mjs','tools/native-scene/adapter.gd','tools/native-scene/invoke.mjs'])report.source_hashes[path]=hash(readFileSync(join(root,path)));
  let service;const server=createServer((req,res)=>service.request(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}}));
  await new Promise((yes,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',yes);});
  const saved={agent:process.env.WORLD_ATELIER_DISABLE_AGENT,worlds:process.env.WORLD_ATELIER_DISABLE_WORLDS};
  process.env.WORLD_ATELIER_DISABLE_AGENT='1';process.env.WORLD_ATELIER_DISABLE_WORLDS='1';
  try{service=new CreationService({server,root,data,origin});}finally{for(const [key,value]of [['WORLD_ATELIER_DISABLE_AGENT',saved.agent],['WORLD_ATELIER_DISABLE_WORLDS',saved.worlds]])if(value===undefined)delete process.env[key];else process.env[key]=value;}
  const peers=[];
  t.after(async()=>{for(const peer of peers)peer.ws.close();await service.close();await new Promise(yes=>server.close(yes));report.finished_at=new Date().toISOString();writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');rmSync(data,{recursive:true,force:true});});
  async function request(method,path,user,payload,expected=200){
    const response=await fetch(origin+'/creation-api'+path,{method,headers:{origin,...(user?{authorization:'Bearer '+user.token}:{}),'content-type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{})});
    const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result;
  }
  const a=await request('POST','/auth/register',null,{name:'Native author A',password:'independent-test-password'},201),b=await request('POST','/auth/register',null,{name:'Native author B',password:'independent-test-password'},201);
  const project=await request('POST','/projects',a,{name:'Native HTTP integration',template:'empty'},201),p=project.project.id,route=`/projects/${p}/branches/main`;
  const invite=await request('POST',`/projects/${p}/invites`,a,{role:'editor'},201);await request('POST','/invites/join',b,{code:invite.code});
  async function connect(user){
    const ws=new WebSocket(origin.replace('http:','ws:')+'/ws/creation',{headers:{origin}}),messages=[];
    ws.on('message',bytes=>messages.push(JSON.parse(bytes)));await new Promise((yes,no)=>{ws.once('open',yes);ws.once('error',no);});
    const peer={ws,messages};peers.push(peer);ws.send(JSON.stringify({type:'auth',token:user.token}));await wait(peer,'authenticated');
    ws.send(JSON.stringify({type:'subscribe',project_id:p,branch_id:'main',resource_id:'scene-harbor',generation:1}));await wait(peer,'baseline');return peer;
  }
  async function wait(peer,type,transaction){for(let i=0;i<100;i++){const match=peer.messages.find(message=>message.type===type&&(!transaction||message.transaction_id===transaction));if(match)return match;await new Promise(yes=>setTimeout(yes,30));}throw Error('Missing real WS '+type);}
  const peerA=await connect(a),peerB=await connect(b);
  const texts={
    'project.godot':'config_version=5\n[application]\nconfig/name="Native HTTP"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    '.atelier/catalog.json':JSON.stringify({format:1,entry_scene_id:'scene-harbor',resources:{'scene-harbor':{id:'scene-harbor',kind:'scene',name:'Native scene',path:'scene.tscn'}}}),
    'scene.gd':'extends Node3D\n@export var attack: float = 10.0\n@export var speed: float = 5.0\n',
    'scene.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scene.gd" id="1"]\n[node name="Root" type="Node3D"]\nscript=ExtResource("1")\nmetadata/wa_node_id="root"\n',
  };
  const imported=await request('POST',route+'/transactions',a,{transaction_id:'native-import',base_revision:project.branch.head,expected_head:project.branch.head,ops:[{type:'import_native_project',files:Object.entries(texts).map(([path,text])=>({path,text}))}]});
  assert.equal(imported.branch.manifest.schema,'creation-native-1');
  assert.equal((await wait(peerB,'committed','native-import')).revision,imported.revision);
  report.cases.push({name:'native import committed and broadcast to both authenticated authors',revision:imported.revision});
  const property=(manifest,name)=>manifest.resources['scene-harbor'].native_nodes.find(node=>node.node_id==='root').properties.find(property=>property.name===name);
  const operation=(name,value)=>({type:'set_native_property',resource_id:'scene-harbor',target:{node_id:'root',instance_ids:[]},property:name,value,expected_property_version:property(imported.branch.manifest,name).version});
  const [attack,speed]=await Promise.all([
    request('POST',route+'/transactions',a,{transaction_id:'attack',base_revision:imported.revision,ops:[operation('attack',20)]}),
    request('POST',route+'/transactions',b,{transaction_id:'speed',base_revision:imported.revision,ops:[operation('speed',8)]}),
  ]);
  const latest=await request('GET',route,a);assert.equal(property(latest.manifest,'attack').value,20);assert.equal(property(latest.manifest,'speed').value,8);
  await wait(peerA,'committed','speed');await wait(peerB,'committed','attack');report.cases.push({name:'different attributes of one native node merge from same source baseline',revision:latest.head});
  await request('POST',route+'/transactions',b,{transaction_id:'stale',base_revision:imported.revision,ops:[operation('attack',99)]},409);
  const undo=await request('POST',route+'/transactions',a,{transaction_id:'undo-attack',base_revision:latest.head,ops:attack.inverse});
  assert.equal(property(undo.branch.manifest,'attack').value,10);assert.equal(property(undo.branch.manifest,'speed').value,8);report.cases.push({name:'property undo retains another author independent modification',revision:undo.revision});
  const source=await request('GET',route+'/native-source?path=scene.tscn',a);assert.match(Buffer.from(source.data_base64,'base64').toString(),/speed = 8/);assert.doesNotMatch(Buffer.from(source.data_base64,'base64').toString(),/attack = 20/);
  const script=undo.branch.manifest.source_files['scene.gd'];
  await request('POST',route+'/transactions',a,{transaction_id:'invalid-script',base_revision:undo.revision,ops:[{type:'put_source_file',path:'scene.gd',expected_hash:script.hash,text:'extends TotallyMissingNativeType\n'}]},422);
  assert.equal((await request('GET',route,a)).head,undo.revision);report.cases.push({name:'Godot import failure preserves published source head',revision:undo.revision});
  report.completed=true;report.final_source_identity=undo.branch.manifest.source_identity;console.log('NATIVE_HTTP_EVIDENCE '+evidence);
});
