import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {NativeSourceArchive} from '../../services/creation/native-source.mjs';
import {randomUUID,createHash} from 'node:crypto';
const exec=promisify(execFile),root=resolve(import.meta.dirname,'../..');

test('eight Kenney character packages run real movement, collision and animation in isolated source copies',{timeout:240000},async t=>{
  const packages=resolve(process.env.WORLD_ATELIER_OFFICIAL_ASSET_ROOT??join(root,'.local/asset-market/packages'));
  const metadata=JSON.parse(readFileSync(resolve(packages,'../package-metadata.json'),'utf8'));
  assert.ok(metadata.length>=26,'expanded official catalog is present');
  const regressionIds=new Set(['official-2d-maleAdventurer','official-2d-femaleAdventurer','official-2d-femalePerson','official-2d-zombie','official-2d-robot','official-3d-skaterMaleA','official-3d-skaterFemaleA','official-3d-cyborgFemaleA']);
  assert.equal(metadata.filter(item=>regressionIds.has(item.id)).length,8);
  const data=mkdtempSync(join(tmpdir(),'atelier-market-controllers-')),evidence=join(root,'.local/creation-verification/asset-market','controllers-'+randomUUID());mkdirSync(evidence,{recursive:true});
  const archive=new NativeSourceArchive(join(data,'objects')),report={scope:'Real headless Godot physics and animation on immutable copies of the official packages; no GPU/gameplay publication claim',packages:[],completed:false};
  t.after(()=>{writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');rmSync(data,{recursive:true,force:true});console.log('MARKET_CONTROLLERS_EVIDENCE '+evidence);});
  for(const item of metadata.filter(item=>regressionIds.has(item.id)).filter(item=>!process.env.WORLD_ATELIER_OFFICIAL_ASSET_IDS||process.env.WORLD_ATELIER_OFFICIAL_ASSET_IDS.split(',').includes(item.id))){
    const source=join(packages,item.id),files=archive.capture(source),project=join(data,item.id);archive.materialize(files,project);
    assert.equal(item.license,'CC0-1.0');assert.ok(files['cover.png']);assert.ok(files['character.tscn']);assert.ok(files['controller.gd']);
    const record={id:item.id,dimension:item.dimension,files};report.packages.push(record);
    writeFileSync(join(project,'project.godot'),'config_version=5\n[application]\nconfig/name="Official market independent controller check"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
    writeFileSync(join(project,'probe.gd'),readFileSync(join(import.meta.dirname,'asset-market-controller-probe.gd')));
    const home=join(data,item.id+'-home'),scratch=join(data,item.id+'-tmp');mkdirSync(home);mkdirSync(scratch);
    const env={...process.env,HOME:home,TMPDIR:scratch,XDG_CONFIG_HOME:join(home,'config'),XDG_DATA_HOME:join(home,'data'),XDG_CACHE_HOME:join(home,'cache')};
    const engine=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot',args=['--headless','--audio-driver','Dummy','--path',project];
    let log='';
    try {
      const imported=await exec(engine,[...args,'--editor','--import','--quit'],{env,timeout:30000,maxBuffer:8*1024*1024});log+=imported.stdout+imported.stderr;
      assert.doesNotMatch(log,/SCRIPT ERROR|Parse Error/);
      const resultPath=join(evidence,item.id+'.json');
      const result=await exec(engine,[...args,'--script','res://probe.gd','--','--dimension='+item.dimension,'--out='+resultPath],{env,timeout:30000,maxBuffer:8*1024*1024});log+=result.stdout+result.stderr;
      record.result=JSON.parse(readFileSync(resultPath,'utf8'));assert.equal(record.result.ok,true);assert.doesNotMatch(log,/SCRIPT ERROR|Parse Error|MARKET_CHECK_FAILED/);
      for(const [path,entry] of Object.entries(files)){
        assert.equal(createHash('sha256').update(readFileSync(join(source,path))).digest('hex'),entry.hash,'original package remains unchanged');
        assert.equal(createHash('sha256').update(readFileSync(join(project,path))).digest('hex'),entry.hash,'Godot preserves authored bytes of its copy');
      }
      console.log('MARKET_CONTROLLER_PASS '+item.id+' '+record.result.checks.length+' checks');
    }catch(error){log+=String(error.stdout??'')+String(error.stderr??'');record.error=error.message;throw error;}
    finally {writeFileSync(join(evidence,item.id+'.log'),log);}
  }
  report.completed=true;
});
