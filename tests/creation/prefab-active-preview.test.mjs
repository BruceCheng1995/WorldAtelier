import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {checkActivePrefabWorkspace} from './prefab-lab-ui-checks.mjs';

// Run against an explicitly prepared isolated service. The ordinary suite does
// not create or control another product service when this fixture is absent.
const fixtureFile=process.env.PREFAB_ACTIVE_TEST_FIXTURE;
test('active prefab workspace separates intrinsic behavior from real external test effects',{skip:!fixtureFile,timeout:600000},async t=>{
 const fixture=JSON.parse(readFileSync(fixtureFile)),session=JSON.parse(readFileSync(join(fixture.data,'session.json'))),origin='http://127.0.0.1:48921';
 const directory=join(fixture.data,'active-ui-'+Date.now());mkdirSync(directory,{recursive:true});
 const report={ok:false,source_revision:fixture.revision,directory};
 t.after(()=>{writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('ACTIVE_PREFAB_EVIDENCE '+directory);});
 async function request(method,path,body){const response=await fetch(origin+'/creation-api'+path,{method,headers:{origin,authorization:'Bearer '+session.token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();assert.ok(response.ok,response.status+' '+JSON.stringify(value));return value;}
 report.ui_assets={};
 for(const path of ['/prefab-lab.js','/prefab-lab.css','/animation-timeline.js']){const response=await fetch(origin+path);assert.ok(response.ok);report.ui_assets[path]=createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');}
 let {job}=await request('POST',`/projects/${fixture.project_id}/branches/main/prefab-test-build`,{source_revision:fixture.revision,entry_scene_id:fixture.entry_scene_id,request_id:'active-independent-'+Date.now()});
 for(const deadline=Date.now()+360000;!['completed','failed','partial','interrupted'].includes(job.status);){assert.ok(Date.now()<deadline,'Real Web build timed out');await new Promise(yes=>setTimeout(yes,1000));({job}=await request('GET','/builds/'+job.id));}
 assert.equal(job.status,'completed',JSON.stringify(job));report.build_id=job.id;report.canonical_identity=job.canonical_identity;
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--use-angle=swiftshader']});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1512,height:1000}});
 await context.addInitScript(token=>sessionStorage.setItem('world-atelier-creator-token',token),session.token);
 const page=await context.newPage();
 try{Object.assign(report,await checkActivePrefabWorkspace({page,origin,projectId:fixture.project_id,revision:fixture.revision,evidenceDirectory:directory}));}
 catch(error){report.error=error.stack;await page.screenshot({path:join(directory,'failure.png')});writeFileSync(join(directory,'failure.html'),await page.content());throw error;}
});
