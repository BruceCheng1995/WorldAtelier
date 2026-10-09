/** Reference-only Agent context regression: no listener, executor or Godot process. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,mkdirSync,writeFileSync,unlinkSync,realpathSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readNativeAgentSource,expandNativeWorkspaceApply} from '../../services/creation/native-agent-workspace.mjs';
import {assertAgentSourceOperations} from '../../services/creation/agent-text-context.mjs';
import {NativeSourceArchive,nativeSourceIdentity} from '../../services/creation/native-source.mjs';
import {attachmentReferences} from '../../services/creation/agent-attachment-references.mjs';
import {encodeAgentToolResult} from '../../services/creation/agent-tool-result.mjs';

function sourceFixture(path,bytes){
  const entry={hash:createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
  const service={native:{source(_user,_project,_branch,input){
    const fixed={revision:'fixed-revision',source_identity:'fixed-source'};
    return input.path?{...fixed,path,...entry,data_base64:bytes.toString('base64')}:{...fixed,files:{[path]:entry}};
  }}};
  return {entry,read:()=>readNativeAgentSource({service,user:{id:'owner'},project_id:'project',branch_id:'main',input:{source_path:path}})};
}
const workspace=t=>{const cwd=mkdtempSync(resolve(tmpdir(),'atelier-text-boundary-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));return cwd;};
const assetBytes=Buffer.from('PRIVATE_RAW_ASSET_BYTES_'.repeat(400)),assetBase64=assetBytes.toString('base64');
const embeddedAsset=()=>({$type:'Resource',class:'ImageTexture',path:'res://assets/icon.png',data_base64:assetBase64,properties:[{name:'data',type_name:'PackedByteArray',value:Array.from(assetBytes),version:'packed-property-v1'}]});
function noRawAsset(value){
  const text=JSON.stringify(value);
  assert.ok(!text.includes(assetBase64),'raw asset base64 must never enter Agent-readable JSON');
  assert.ok(!text.includes(JSON.stringify(Array.from(assetBytes))),'Packed asset bytes must be represented by a reference, not a numeric dump');
}

test('world_read text source returns UTF-8 text once, without a duplicate base64 representation',()=>{
  const text='extends Node\n@export var damage: int = 7\n',f=sourceFixture('game.gd',Buffer.from(text));
  const value=f.read();assert.equal(value.text,text);assert.equal(value.hash,f.entry.hash);assert.equal(value.revision,'fixed-revision');
  assert.equal('data_base64' in value,false,'the text-only tool must strip transport-level byte encoding');
});

test('world_read binary source returns identity and reference without original binary bytes',()=>{
  const bytes=Buffer.from([0x89,0x50,0x4e,0x47,0,0xff,0xfe,0xfd]),f=sourceFixture('assets/icon.png',bytes),value=f.read();
  assert.equal(value.path,'assets/icon.png');assert.equal(value.hash,f.entry.hash);assert.equal(value.revision,'fixed-revision');
  assert.equal('data_base64' in value,false);assert.equal('text' in value,false);
  assert.ok(!JSON.stringify(value).includes(bytes.toString('base64')));
});

test('large approved assets are referenced from metadata without reading or base64-encoding their bytes',()=>{
  let reads=0;const service={native:{source(_user,_project,_branch,input){
    reads++;assert.equal(input.path,undefined,'asset bytes must not be loaded for a source_path reference');
    return {revision:'fixed',source_identity:'source',files:{'assets/model.glb':{hash:'asset-hash',size:80*1024*1024}}};
  }}};
  const value=readNativeAgentSource({service,user:{id:'owner'},project_id:'project',branch_id:'main',input:{source_path:'assets/model.glb'}});
  assert.equal(reads,1);assert.equal(value.resource_path,'res://assets/model.glb');assert.equal(value.hash,'asset-hash');assert.equal(value.size,80*1024*1024);assert.equal(value.context_only,true);assert.equal(value.editable_via,'submit_native_workspace');assert.equal('read_only' in value,false);
});

test('attachment snapshot file projects assets to references while preserving the original capture',t=>{
  const cwd=workspace(t),attachment={id:'texture-reference',kind:'prefab',name:'宝箱',source_revision:'old-source',resource_id:'chest',snapshot:{id:'chest',version:'resource-v2',native_nodes:[{node_id:'chest-root',version:'node-v3',properties:[{name:'texture',version:'texture-property-v4',value:embeddedAsset()},{name:'raw_mesh_bytes',type_name:'PackedByteArray',version:'mesh-property-v5',value:Array.from(assetBytes)}]}]}};
  const original=structuredClone(attachment),[reference]=attachmentReferences({cwd,attachments:[attachment]});
  noRawAsset(reference);const archived=JSON.parse(readFileSync(reference.snapshot_file,'utf8'));noRawAsset(archived);
  assert.ok(JSON.stringify(archived).includes('res://assets/icon.png'));assert.ok(JSON.stringify(archived).includes('resource-v2'));
  assert.deepEqual(attachment,original,'historical captures must remain immutable in server memory and storage');
});

test('raw Packed property arrays become bounded metadata without dropping ordinary editable values and versions',t=>{
  const cwd=workspace(t),value={resource:{id:'scene',version:'resource-v8',native_nodes:[{node_id:'root',version:'node-v4',properties:[
    {name:'mesh_bytes',type_name:'PackedByteArray',version:'property-v3',value:Array.from(assetBytes),inherited_value:Array.from(assetBytes)},
    {name:'speed',type_name:'float',version:'property-v4',value:4.5,inherited_value:3},
    {name:'position',type_name:'Vector3',version:'property-v5',value:{$type:'Vector3',value:[1,2,3]}}
  ]}]}};
  const result=encodeAgentToolResult({cwd,value}),body=JSON.parse(result.contentItems[0].text),projected=body.result_file?JSON.parse(readFileSync(body.result_file,'utf8')):body;
  noRawAsset(projected);const properties=projected.resource.native_nodes[0].properties;
  assert.equal(properties.find(p=>p.name==='mesh_bytes').version,'property-v3');assert.equal(properties.find(p=>p.name==='speed').value,4.5);
  assert.deepEqual(properties.find(p=>p.name==='position').value,{$type:'Vector3',value:[1,2,3]});
});

test('generic tool results remove raw resource data both inline and in overflow files',t=>{
  const cwd=workspace(t);
  for(const overflow of [false,true]){
    const value={revision:'fixed-source',resource:{id:'chest',version:'resource-v2',texture:embeddedAsset()},...(overflow?{description:'Readable prose. '.repeat(30000)}:{})},original=structuredClone(value);
    const result=encodeAgentToolResult({cwd,value});assert.equal(result.success,true);noRawAsset(result);
    const body=JSON.parse(result.contentItems[0].text),projected=body.result_file?JSON.parse(readFileSync(body.result_file,'utf8')):body;
    noRawAsset(projected);assert.ok(JSON.stringify(projected).includes('res://assets/icon.png'));assert.deepEqual(value,original);
  }
});

test('direct Agent source operations accept text, resource references and guarded deletion but reject inline raw byte submission',()=>{
  assert.doesNotThrow(()=>assertAgentSourceOperations([
    {type:'put_source_file',path:'game.gd',text:'extends Node\n',expected_hash:null},
    {type:'put_source_file',path:'scene.tscn',text:'[gd_scene load_steps=2 format=3]\n[ext_resource type="Texture2D" path="res://assets/icon.png" id="1"]\n',expected_hash:null},
    {type:'set_native_property',resource_id:'scene',property:'texture',value:{$type:'Resource',class:'Texture2D',path:'res://assets/icon.png'}},
    {type:'delete_source_file',path:'assets/icon.png',expected_hash:'current-file-hash'}
  ]));
  for(const op of [
    {type:'put_source_file',path:'game.gd',data_base64:Buffer.from('extends Node\n').toString('base64')},
    {type:'put_source_file',path:'assets/icon.png',text:'apparently text'},
    {type:'put_source_file',path:'bad.gd',text:'contains\0binary'},
    {type:'import_native_project',files:[]},
    {type:'restore_source_file',path:'assets/icon.png',entry:{hash:'untrusted',size:10}}
  ])assert.throws(()=>assertAgentSourceOperations([op]),error=>error.status===422,op.type+':'+(op.path??''));
});

function editableFixture(t){
  const cwd=realpathSync(workspace(t)),directory=resolve(cwd,'work/game');mkdirSync(directory,{recursive:true});mkdirSync(resolve(directory,'assets'));
  const archive=new NativeSourceArchive(resolve(cwd,'archive')),contents={'game.gd':Buffer.from('extends Node\n'),'scene.tscn':Buffer.from('[gd_scene format=3]\n[node name="Root" type="Node"]\n'),'assets/icon.png':Buffer.from([0x89,0x50,0x4e,0x47,0,0xff]),'assets/opaque.dat':Buffer.from([0,1,2,0xff,0xfe])};
  const files=Object.fromEntries(Object.entries(contents).map(([path,bytes])=>{writeFileSync(resolve(directory,path),bytes);return[path,archive.put(bytes)];}));
  const identity=nativeSourceIdentity(files),session={id:'session',project_id:'project',branch_id:'main',owner_user_id:'owner'},run={id:'run',lease_generation:1};
  const prepared={id:'environment',session_id:'session',project_id:'project',branch_id:'main',user_id:'owner',run_id:'run',lease_generation:1,source_revision:'fixed',source_schema:'creation-native-1',native_source_identity:identity,native_source_files:files,native_workspace_files:files,project_directory:directory};
  const fixed={id:'fixed',project_id:'project',manifest:{schema:'creation-native-1',source_identity:identity,source_files:files}};
  const service={native:{archive,source(_user,_project,_branch,{path}){return{revision:fixed.id,path,...files[path],data_base64:archive.read(files[path]).toString('base64')};}},store:{get(kind,id){return kind==='creator_environment'&&id==='environment'?structuredClone(prepared):kind==='creator_revision'&&id==='fixed'?structuredClone(fixed):null;},sessionFor(){return session;},branchFor(){return{head:'fixed'};},ancestor(a,b){return a===b;}}};
  const input={base_revision:'fixed',ops:[{type:'submit_native_workspace',environment_id:'environment',path:'work/game'}]};
  return {cwd,directory,contents,files,prepared,run,input,service,expand:(extra={})=>expandNativeWorkspaceApply({service,user:{id:'owner'},session,run,cwd,input,...extra})};
}

test('editable Godot workspace text changes preserve original binary assets and their references',t=>{
  const f=editableFixture(t),text='extends Node\nvar texture = preload("res://assets/icon.png")\n';writeFileSync(resolve(f.directory,'game.gd'),text);
  const result=f.expand();assert.equal(result.input.ops.length,1);const op=result.input.ops[0];assert.equal(op.path,'game.gd');assert.equal(Buffer.from(op.data_base64,'base64').toString(),text);
  assert.equal(op.expected_hash,f.files['game.gd'].hash);assert.deepEqual(result.summary.changed_files.map(file=>file.path),['game.gd']);
  for(const path of ['assets/icon.png','assets/opaque.dat'])assert.deepEqual(readFileSync(resolve(f.directory,path)),f.contents[path]);
});

for(const action of ['add','modify','delete'])for(const suffix of ['png','dat'])test(`editable workspace captures ${action} of ${suffix} binary files with hashes and a byte-free receipt`,t=>{
  const f=editableFixture(t),name=action==='add'?'assets/new.'+suffix:suffix==='png'?'assets/icon.png':'assets/opaque.dat',path=resolve(f.directory,name);
  if(action==='delete')unlinkSync(path);else writeFileSync(path,assetBytes);
  const result=f.expand(),[op]=result.input.ops,[change]=result.summary.changed_files;
  assert.equal(result.input.ops.length,1);assert.equal(op.path,name);assert.equal(op.expected_hash,f.files[name]?.hash??null);
  assert.equal(change.path,name);assert.equal(change.kind,action);
  if(action==='delete'){assert.equal(op.type,'delete_source_file');assert.equal(change.after,null);}
  else{assert.equal(op.type,'put_source_file');assert.deepEqual(Buffer.from(op.data_base64,'base64'),assetBytes);assert.deepEqual(change.after,{hash:createHash('sha256').update(assetBytes).digest('hex'),size:assetBytes.length});}
  noRawAsset(result.summary);noRawAsset(encodeAgentToolResult({cwd:f.cwd,value:{workspace_submission:result.summary,committed_ops:result.input.ops}}));
});

test('an existing opaque binary asset can be replaced with UTF-8 through the complete file workspace',t=>{
  const f=editableFixture(t);writeFileSync(resolve(f.directory,'assets/opaque.dat'),'new plain text');
  const [op]=f.expand().input.ops;assert.equal(op.path,'assets/opaque.dat');assert.equal(op.expected_hash,f.files['assets/opaque.dat'].hash);assert.equal(Buffer.from(op.data_base64,'base64').toString(),'new plain text');
});

test('binary workspace submission still rejects foreign paths, symbolic links, invalid lease and changed baseline',t=>{
  for(const mode of ['outside','file-symlink','directory-symlink','lease','revision','baseline','permission','cancelled']){
    const f=editableFixture(t);writeFileSync(resolve(f.directory,'assets/new.png'),assetBytes);
    if(mode==='outside')f.input.ops[0].path='../another-session/game';
    if(mode==='file-symlink'){unlinkSync(resolve(f.directory,'assets/new.png'));symlinkSync(resolve(f.directory,'assets/icon.png'),resolve(f.directory,'assets/new.png'));}
    if(mode==='directory-symlink'){symlinkSync(f.directory,resolve(f.cwd,'work/alias'));f.input.ops[0].path='work/alias';}
    if(mode==='lease')f.run.lease_generation++;
    if(mode==='revision')f.input.base_revision='other-source';
    if(mode==='baseline')f.prepared.native_source_identity='forged-source';
    if(mode==='permission')f.service.store.sessionFor=()=>{throw Object.assign(new Error('permission revoked'),{status:403});};
    const controller=new AbortController();if(mode==='cancelled')controller.abort();
    assert.throws(()=>f.expand({signal:controller.signal}),error=>[403,409].includes(error.status),mode);
  }
});

test('asset collections over 100 changed files form one complete import with an exact source head guard',t=>{
  const f=editableFixture(t);
  for(let i=0;i<101;i++)writeFileSync(resolve(f.directory,'assets/new-'+i+'.bin'),assetBytes);
  const result=f.expand(),[op]=result.input.ops;
  assert.equal(result.input.ops.length,1);assert.equal(op.type,'import_native_project');assert.equal(result.input.expected_head,'fixed');
  assert.equal(result.summary.mode,'complete_native_import');assert.equal(result.summary.changed_files.length,101);
  const imports=Object.fromEntries(op.files.map(file=>[file.path,Buffer.from(file.data_base64,'base64')]));
  assert.equal(Object.keys(imports).length,Object.keys(f.files).length+101);
  for(const [path,bytes] of Object.entries(f.contents))assert.deepEqual(imports[path],bytes,'unchanged original must survive full import');
  assert.deepEqual(imports['assets/new-100.bin'],assetBytes);noRawAsset(encodeAgentToolResult({cwd:f.cwd,value:{committed_ops:result.input.ops,workspace_submission:result.summary}}));
  f.service.store.branchFor=()=>({head:'collaborator-change'});f.service.store.ancestor=()=>true;
  assert.throws(()=>f.expand(),error=>error.status===409,'large import cannot overwrite a moving collaborator head');
});
