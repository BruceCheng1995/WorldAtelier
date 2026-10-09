import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CreationService} from '../../services/creation/service.mjs';
import {snapshotProjectRuntime,assembleProject} from '../../services/creation/project-snapshot.mjs';
const exec=promisify(execFile),root=resolve(import.meta.dirname,'../..');

test('real official 2D and 3D market packages import through central transactions and boot canonical GameRuntime',{timeout:240000},async t=>{
 const data=mkdtempSync(join(tmpdir(),'atelier-market-canonical-')),evidence=join(root,'.local/creation-verification/asset-market','canonical-'+randomUUID());mkdirSync(evidence,{recursive:true});
 const report={scope:'Real official packages, central native commits, indexed prefab copies and canonical GameRuntime startup/movement; no browser publication claim',imports:[],completed:false};
 const keys=['WORLD_ATELIER_DISABLE_AGENT','WORLD_ATELIER_DISABLE_WORLDS'],saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));for(const key of keys)process.env[key]='1';
 let service;try{service=new CreationService({server:createServer(),root,data,origin:'http://127.0.0.1:48921'});}finally{for(const key of keys)if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
 t.after(async()=>{await service.close();writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');rmSync(data,{recursive:true,force:true});console.log('MARKET_CANONICAL_EVIDENCE '+evidence);});
 const user=service.store.register({name:'Official import independent tester',password:'Independent-canonical-test'}).user,created=await service.createProject(user,{name:'Canonical official import',template:'empty'}),projectId=created.project.id;
 const metadata=JSON.parse(readFileSync(join(root,'.local/asset-market/package-metadata.json'),'utf8'));
 const samples=['official-2d-maleAdventurer','official-3d-skaterMaleA'];
 for(const assetId of samples){const item=metadata.find(item=>item.id===assetId),files=service.market.archive.capture(join(root,'.local/asset-market/packages',assetId));const {asset}=service.market.installOfficial({...item,files});
  const before=service.store.branchView(user,projectId,'main'),result=await service.market.importToProject(user,projectId,'main',{asset_id:asset.id,version:asset.version,transaction_id:'canonical-'+assetId,base_revision:before.head});
  const after=service.store.branchView(user,projectId,'main'),prefab=after.manifest.resources[result.import.resource_id];assert.notEqual(before.head,after.head);assert.equal(prefab.kind,'prefab');assert.ok(prefab.native_nodes.some(node=>node.type===(item.dimension==='2d'?'CharacterBody2D':'CharacterBody3D')||node.native_type===(item.dimension==='2d'?'CharacterBody2D':'CharacterBody3D')),'real native controller is indexed');
  assert.ok(after.manifest.source_files[result.import.directory+'/controller.gd']);assert.deepEqual(after.manifest.source_files['project.godot'],before.manifest.source_files['project.godot']);
  report.imports.push({asset_id:asset.id,version:asset.version,revision:after.head,resource_id:prefab.id,directory:result.import.directory,native_nodes:prefab.native_nodes.length,dimension:item.dimension});
 }
 const fixed=service.store.branchView(user,projectId,'main');
 for(const record of report.imports){
  const directory=join(data,record.asset_id),snapshot=snapshotProjectRuntime(root,directory);await assembleProject({service,user,project_id:projectId,branch_id:'main',revision:fixed.head,entry_scene_id:record.resource_id,allowPrefab:true,directory,runtime_source_hash:snapshot.hash});
  const config=readFileSync(join(directory,'project.godot'),'utf8');assert.match(config,/GameRuntime="\*res:\/\/atelier_runtime\/standalone.gd"/);
  const probe=`extends Node\nfunc _ready():\n\tprocess_mode = Node.PROCESS_MODE_ALWAYS\n\tvar runtime = get_tree().root.get_node("GameRuntime")\n\tfor i in range(400):\n\t\tawait get_tree().process_frame\n\t\tif runtime.running: break\n\tif not runtime.running:\n\t\tpush_error("OFFICIAL_CANONICAL_FAILED runtime not ready")\n\t\tget_tree().quit(1)\n\t\treturn\n\tvar actor = get_tree().current_scene\n\tif actor.scene_file_path != ${JSON.stringify('res://'+record.directory+'/character.tscn')}:\n\t\tpush_error("OFFICIAL_CANONICAL_FAILED wrong scene " + actor.scene_file_path)\n\t\tget_tree().quit(1)\n\t\treturn\n\tactor.keyboard_enabled = false\n\tactor.camera_enabled = false\n\tvar start_x: float = actor.position.x\n\tactor.set_move_input(Vector2.RIGHT)\n\tfor i in range(25): await get_tree().physics_frame\n\tif actor.position.x <= start_x + ${record.dimension==='2d'?'20.0':'0.5'}:\n\t\tpush_error("OFFICIAL_CANONICAL_FAILED no movement")\n\t\tget_tree().quit(1)\n\t\treturn\n\tprint("OFFICIAL_CANONICAL_OK " + JSON.stringify({"scene":actor.scene_file_path,"revision":runtime.release.revision,"delta_x":actor.position.x-start_x}))\n\tget_tree().quit(0)\n`;
  writeFileSync(join(directory,'market_probe.gd'),probe);writeFileSync(join(directory,'project.godot'),config.replace('[autoload]','[autoload]\nMarketProbe="*res://market_probe.gd"'));
  const home=join(data,record.asset_id+'-home');mkdirSync(home);const env={...process.env,HOME:home,XDG_CONFIG_HOME:join(home,'config'),XDG_DATA_HOME:join(home,'data'),XDG_CACHE_HOME:join(home,'cache')},godot=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot',args=['--headless','--audio-driver','Dummy','--path',directory];let log='';
  try{const imported=await exec(godot,[...args,'--editor','--import','--quit'],{env,timeout:45000,maxBuffer:8*1024*1024});log+=imported.stdout+imported.stderr;const played=await exec(godot,args,{env,timeout:45000,maxBuffer:8*1024*1024});log+=played.stdout+played.stderr;assert.doesNotMatch(log,/SCRIPT ERROR|Parse Error|OFFICIAL_CANONICAL_FAILED/);assert.match(log,/OFFICIAL_CANONICAL_OK/);record.canonical_runtime=true;console.log('MARKET_CANONICAL_PASS '+record.asset_id);}
  catch(error){log+=String(error.stdout??'')+String(error.stderr??'');throw error;}finally{writeFileSync(join(evidence,record.asset_id+'.log'),log);}
 }
 report.completed=true;
});
