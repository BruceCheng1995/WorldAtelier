/** Real artifact/access verification for the owned LAN fixture service.
 * Browser rendering is separately exercised through CUA, never faked here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const out=process.env.WORLD_ATELIER_WEB_REGRESSION_DIR;
const policy='world-atelier-single-thread-local-http-v1';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
test('actual LAN Web build records adaptation before hashing, zipping and authenticated serving',{skip:!out},async()=>{
 const access=JSON.parse(await readFile(resolve(out,'access.private.json'))),origin=access.lanOrigin,owner=access.users[0];
 assert.match(origin,/^http:\/\/(?:10\.|192\.168\.|172\.)/,'a LAN URL, not localhost, is required');
 const headers={origin,authorization:'Bearer '+owner.token};
 const jobResponse=await fetch(origin+'/creation-api/builds/'+access.job_id,{headers});assert.equal(jobResponse.status,200);
 const {job}=await jobResponse.json();assert.equal(job.status,'completed');assert.equal(job.web_compatibility_policy,policy);assert.equal(job.web_compatibility.policy,policy);
 const directory=resolve(access.data,'creation/builds',job.id),web=resolve(directory,'web');
 const [metadataBytes,html,js,presets]=await Promise.all([readFile(resolve(web,'web-compatibility.json')),readFile(resolve(web,'index.html')),readFile(resolve(web,'index.js')),readFile(resolve(directory,'export-project/export_presets.cfg'),'utf8')]);
 const metadata=JSON.parse(metadataBytes);
 assert.deepEqual(metadata,job.web_compatibility);assert.equal(metadata.adapted_javascript_sha256,digest(js));assert.equal(metadata.adapted_html_sha256,digest(html));
 assert.equal(metadata.single_threaded,true);assert.equal(metadata.wasm_memory.length,1);assert.equal(metadata.wasm_memory[0].shared,false);assert.equal(metadata.engine,'4.6.stable.official.89cea1439');
 for(const option of ['variant/thread_support=false','variant/extensions_support=false','progressive_web_app/enabled=false'])assert.ok(presets.includes(option));
 assert.ok(html.includes('wa-http-audio-note'));assert.ok(html.includes('--audio-driver'));assert.ok(js.includes('Secure Context - Check web server configuration (use HTTPS)'),'secure-context rejection remains outside the LAN exception');
 const artifact=job.artifacts.find(a=>a.target==='web');assert.ok(artifact);
 const download=await fetch(origin+artifact.download_url,{headers});assert.equal(download.status,200);const bytes=Buffer.from(await download.arrayBuffer());assert.equal(bytes.length,artifact.size);assert.equal(digest(bytes),artifact.sha256);
 const zip=resolve(out,'verified-web.zip');await writeFile(zip,bytes);
 for(const [name,expected] of [['web-compatibility.json',metadataBytes],['index.html',html],['index.js',js]])assert.deepEqual(execFileSync('unzip',['-p',zip,name],{maxBuffer:2000000}),expected,'ZIP has the actual adapted '+name);
 const denied=await fetch(origin+artifact.web_url);assert.equal(denied.status,403,'LAN compatibility does not waive authentication');
 const grant=await fetch(origin+'/creation-api/builds/'+job.id+'/access',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'});assert.equal(grant.status,200);
 const cookie=grant.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);const granted=await grant.json();assert.equal(granted.web_url,artifact.web_url);
 for(const [name,expected] of [['web-compatibility.json',metadataBytes],['index.html',html],['index.js',js]]){
  const response=await fetch(origin+artifact.web_url.replace('index.html',name),{headers:{cookie}});assert.equal(response.status,200);assert.equal(digest(Buffer.from(await response.arrayBuffer())),digest(expected),'served adapted '+name+' remains immutable');
 }
 const catalog=await fetch(origin+`/creation-api/projects/${access.project_id}/branches/main/builds`,{headers});assert.equal(catalog.status,200);const listing=await catalog.json();assert.equal(listing.jobs.length,1,'clicking the compatible package did not enqueue a duplicate');assert.equal(listing.targets.find(t=>t.id==='web').web_compatibility_policy,policy);
 await writeFile(resolve(out,'artifact-checks.json'),JSON.stringify({ok:true,job_id:job.id,origin,policy,artifact_sha256:artifact.sha256,metadata_sha256:digest(metadataBytes),adapted_javascript_sha256:digest(js),adapted_html_sha256:digest(html),authenticated_serving:true,unauthenticated_status:denied.status,job_count:listing.jobs.length,scope:'real export/ZIP/LAN HTTP artifact checks; browser rendering verified separately via CUA'},null,2));
});
