import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {independentPreviewBehavior,independentPreviewBehaviorHash,independentPreviewObject} from './independent-preview-fixture.mjs';

const root=resolve(import.meta.dirname,'../..'),hash=bytes=>createHash('sha256').update(bytes).digest('hex');

test('real Godot independent editor previews, restart and inspect UI/free camera',{timeout:120000},async t=>{
 const expected=process.env.WORLD_ATELIER_EXPECT_RUNTIME_BUILD;
 const sourceOnly=process.env.WORLD_ATELIER_PREVIEW_SOURCE_ONLY==='1';
 if(!sourceOnly)assert.match(expected??'',/^[a-f0-9]{64}$/,'Set the explicitly built runtime ID before running this engine acceptance');
 const build=resolve(process.env.WORLD_ATELIER_PREVIEW_BUILD??resolve(root,'.local/model-preview/build'));
 const manifest=JSON.parse(await readFile(resolve(build,'manifest.json'),'utf8'));
 if(!sourceOnly)assert.equal(manifest.build_id,expected);
 const data=await mkdtemp(resolve(tmpdir(),'atelier-independent-preview-'));
 const out=resolve(root,'.local/creation-verification/independent-preview',new Date().toISOString().replaceAll(':','-'));
 const runtime=resolve(data,'runtime');await mkdir(out,{recursive:true});
 await cp(resolve(root,'runtimes/model-preview'),runtime,{recursive:true,filter:source=>!source.split('/').includes('.godot')});
 const verified=[];
 for(const file of manifest.sources){const actualHash=hash(await readFile(resolve(runtime,file.path)));if(!sourceOnly)assert.equal(actualHash,file.sha256,`Current source must match built runtime: ${file.path}`);verified.push({...file,sha256:actualHash});}
 await writeFile(resolve(out,'runtime-source-manifest.json'),JSON.stringify({scope:sourceOnly?'source-development-only':'matches-built-runtime',build_id:sourceOnly?null:expected,sources:verified},null,2));
 await cp(resolve(import.meta.dirname,'independent-preview-probe.gd'),resolve(runtime,'tests/independent_preview_probe.gd'));
 const godot=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot';
 const importLog=execFileSync(godot,['--headless','--editor','--path',runtime,'--import'],{timeout:30000,encoding:'utf8'});
 await writeFile(resolve(out,'import.log'),importLog);
 const origin='http://127.0.0.1:48923',requests=[];
 const server=http.createServer((request,response)=>{
  requests.push({url:request.url,at:Date.now()});
  if(request.url===`/preview-assets/${independentPreviewBehaviorHash}.gd`)setTimeout(()=>{response.writeHead(200,{'content-type':'text/plain'});response.end(independentPreviewBehavior);},120);
  else{response.writeHead(404);response.end();}
 });
 await new Promise((yes,no)=>{server.once('error',no);server.listen(48923,'127.0.0.1',yes);});
 t.after(()=>new Promise(yes=>server.close(yes)));
 const asset={id:independentPreviewBehaviorHash,url:`/preview-assets/${independentPreviewBehaviorHash}.gd`};
 const fixture={document_id:'independent-project/main/scene',branch_id:'main',scene_revision:'independent-fixed-v1',objects:[independentPreviewObject(asset)],spawn_position:[0,.2,3],editable:true};
 const fixturePath=resolve(data,'scene.json'),reportPath=resolve(out,'result.json');await writeFile(fixturePath,JSON.stringify(fixture));await writeFile(resolve(out,'fixture.gd'),independentPreviewBehavior);
 const args=['--headless','--path',runtime,'--script','res://tests/independent_preview_probe.gd','--',`--fixture=${fixturePath}`,`--origin=${origin}`,`--report=${reportPath}`];
 let log='';const child=spawn(godot,args,{stdio:['ignore','pipe','pipe']});child.stdout.on('data',part=>log+=part);child.stderr.on('data',part=>log+=part);
 t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM');});
 const exit=await new Promise((yes,no)=>{child.once('error',no);child.once('exit',(code,signal)=>yes({code,signal}));});
 await writeFile(resolve(out,'godot.log'),log);await writeFile(resolve(out,'run.json'),JSON.stringify({data,runtime,scope:sourceOnly?'source-development-only':'matches-built-runtime',build_id:sourceOnly?null:expected,args,exit,requests},null,2));
 console.log('Independent preview evidence: '+out);
 assert.ok(log.includes('INDEPENDENT_PREVIEW_COMPLETE'),log);
 const report=JSON.parse(await readFile(reportPath,'utf8'));
 assert.ok(!/SCRIPT ERROR|Parse Error|^ERROR:/m.test(log),log);
 assert.equal(exit.code,0,JSON.stringify(report.checks.filter(row=>!row.ok),null,2));assert.equal(report.completed,true);assert.equal(report.ok,true);
});
