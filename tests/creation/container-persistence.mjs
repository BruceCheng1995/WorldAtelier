// Runs only against the owned, isolated Compose deployment used by the browser
// test. A real login verifies persisted account/source identities after restart.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const phase=process.argv[2],origin='http://127.0.0.1:48921';
assert.ok(['snapshot','check'].includes(phase),'Expected snapshot or check');
const path=resolve(import.meta.dirname,'../../.local/creation-verification/container-ci/persistence.json');
const loginResponse=await fetch(origin+'/creation-api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({name:'默认工程部署检查',password:'default-project-isolated-password'})});
const login=await loginResponse.json();assert.equal(loginResponse.status,200,JSON.stringify(login));
const response=await fetch(origin+'/creation-api/bootstrap',{headers:{authorization:'Bearer '+login.token}}),bootstrap=await response.json();assert.equal(response.status,200);
const observed={user_id:bootstrap.user.id,projects:bootstrap.projects.map(project=>({id:project.id,name:project.name,role:project.role,bundle:project.default_project?.bundle_version,cover:project.presentation?.cover_id,branches:project.branches.map(branch=>({id:branch.branch_id,head:branch.head})).sort((a,b)=>a.id.localeCompare(b.id))})).sort((a,b)=>a.id.localeCompare(b.id))};
assert.equal(observed.projects.length,9);assert.equal(observed.projects.reduce((n,p)=>n+p.branches.length,0),11);
mkdirSync(dirname(path),{recursive:true});
if(phase==='snapshot')writeFileSync(path,JSON.stringify({before:observed},null,2)+'\n');
else{const saved=JSON.parse(readFileSync(path));assert.deepEqual(observed,saved.before);writeFileSync(path,JSON.stringify({...saved,after:observed,passed:true},null,2)+'\n');}
console.log(`Container persistence ${phase}: real account, 9 projects and 11 fixed branches verified`);
