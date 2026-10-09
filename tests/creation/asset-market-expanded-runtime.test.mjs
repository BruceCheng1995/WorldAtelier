import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {NativeSourceArchive} from '../../services/creation/native-source.mjs';
const exec=promisify(execFile),root=resolve(import.meta.dirname,'../..');

test('expanded official action, vehicle and weapon packages execute real input, animation and combat',{timeout:300000},async t=>{
 const packages=resolve(process.env.WORLD_ATELIER_OFFICIAL_ASSET_ROOT??join(root,'.local/asset-market/packages')),metadata=JSON.parse(readFileSync(resolve(packages,'../package-metadata.json'),'utf8'));
 const candidates=metadata.map(item=>{const script=readFileSync(join(packages,item.id,'controller.gd'),'utf8');return {...item,test_kind:script.includes('func trigger_primary(')?'action':script.includes('func set_drive_input(')?'vehicle':script.includes('func fire(')?'weapon':null};}).filter(item=>item.test_kind&&(!process.env.WORLD_ATELIER_EXPANDED_ASSET_IDS||process.env.WORLD_ATELIER_EXPANDED_ASSET_IDS.split(',').includes(item.id)));
 assert.ok(candidates.length>0);const data=mkdtempSync(join(tmpdir(),'atelier-market-expanded-')),evidence=join(root,'.local/creation-verification/asset-market','expanded-runtime-'+randomUUID());mkdirSync(evidence,{recursive:true});
 const archive=new NativeSourceArchive(join(data,'objects')),report={scope:'Real headless Godot import, model, animation, movement, attack ray/damage/death and arcade driving using independent copies; not visual or canonical publication acceptance',packages:[],completed:false};
 t.after(()=>{writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');rmSync(data,{recursive:true,force:true});console.log('EXPANDED_MARKET_RUNTIME_EVIDENCE '+evidence);});
 for(const item of candidates){
  const files=archive.capture(join(packages,item.id)),project=join(data,item.id);archive.materialize(files,project);writeFileSync(join(project,'project.godot'),'config_version=5\n[application]\nconfig/name="Expanded market independent check"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');writeFileSync(join(project,'probe.gd'),readFileSync(join(import.meta.dirname,'asset-market-expanded-probe.gd')));
  const home=join(data,item.id+'-home'),scratch=join(data,item.id+'-tmp');mkdirSync(home);mkdirSync(scratch);
  const env={...process.env,HOME:home,TMPDIR:scratch,XDG_CONFIG_HOME:join(home,'config'),XDG_DATA_HOME:join(home,'data'),XDG_CACHE_HOME:join(home,'cache')},engine=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot',args=['--headless','--audio-driver','Dummy','--path',project];
  const record={id:item.id,role:item.role,kind:item.test_kind,files};report.packages.push(record);let log='';
  try{const imported=await exec(engine,[...args,'--editor','--import','--quit'],{env,timeout:40000,maxBuffer:8*1024*1024});log+=imported.stdout+imported.stderr;assert.doesNotMatch(log,/SCRIPT ERROR|Parse Error/);
   const output=join(evidence,item.id+'.json'),run=await exec(engine,[...args,'--script','res://probe.gd','--','--kind='+item.test_kind,'--entry='+item.entry_path,'--out='+output,...(['zombie','monster','skeleton'].includes(item.role)?['--enemy']:[])],{env,timeout:25000,maxBuffer:8*1024*1024});log+=run.stdout+run.stderr;record.result=JSON.parse(readFileSync(output,'utf8'));assert.equal(record.result.ok,true);assert.doesNotMatch(log,/SCRIPT ERROR|Parse Error|EXPANDED_MARKET_CHECK_FAILED/);console.log('EXPANDED_MARKET_PASS '+item.id+' '+record.result.checks.length+' checks');
  }catch(error){log+=String(error.stdout??'')+String(error.stderr??'');record.error=error.message;throw error;}finally{writeFileSync(join(evidence,item.id+'.log'),log);}
 }
 report.completed=true;
});
