import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest,validateContent} from './content.mjs';

export class Builds {
  constructor({store,root,data,godot}) {Object.assign(this,{store,root,data,godot});this.running=new Map();}
  schedule(project,branch,user) {
    const id='build_'+randomUUID();
    branch.publish_generation=(branch.publish_generation??0)+1;this.store.put('branch',branch);
    const build={id,project_id:project.id,branch:branch.name,revision:branch.source_head,generation:branch.publish_generation,status:'queued',author:user.name,created_at:Date.now(),log:''};
    this.store.put('build',build);this.store.event(project.id,{kind:'build',title:`构建 ${branch.name}`,actor:user.name,build_id:id});
    const task=this.execute(build).catch(e=>{build.status='failed';build.error=e.message;build.finished_at=Date.now();this.store.put('build',build);this.store.event(project.id,{kind:'build_failed',title:e.message,build_id:id});}).finally(()=>this.running.delete(id));this.running.set(id,task);return build;
  }
  async execute(build) {
    build.status='running';this.store.put('build',build);
    const revision=this.store.get('revision',build.revision);validateContent(revision.content);
    const dir=join(this.data,'builds',build.id);mkdirSync(dir,{recursive:true});const source=join(dir,'content.json');writeFileSync(source,JSON.stringify(revision.content));
    const runtimeManifest=join(this.root,'.local/runtime-build/manifest.json');
    if(!existsSync(runtimeManifest))throw Error('Real desktop/Web exports are not built yet. Run npm run build:runtime.');
    const runtime=JSON.parse(readFileSync(runtimeManifest,'utf8'));
    for(const file of runtime.source_files)if(digest(readFileSync(join(this.root,'runtimes/godot',file.path)))!==file.sha256)throw Error('Runtime source changed; rebuild runtime exports before publishing');
    const binary=join(this.root,'.local/artifacts',runtime.hash,runtime.authority_binary);
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(binary,['--headless','--','--role=validate',`--content=${source}`],{stdio:['ignore','pipe','pipe']});
      let output='';const collect=b=>{output=(output+b.toString()).slice(-50000);};child.stdout.on('data',collect);child.stderr.on('data',collect);
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Godot validation timed out'));},30000);
      child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('exit',code=>{clearTimeout(timer);resolve({code,output});});
    });
    build.log=result.output;this.store.put('build',build);
    if(result.code!==0||!result.output.includes('CONTENT_VALIDATED')||/SCRIPT ERROR|Parse Error/.test(result.output))throw Error('Godot rejected candidate: '+result.output.slice(-1500));
    const content_hash=digest(readFileSync(source));const id='release_'+digest({revision:revision.id,runtime:runtime.hash}).slice(0,24);
    const artifactDir=join(this.data,'artifacts',content_hash);mkdirSync(artifactDir,{recursive:true});copyFileSync(source,join(artifactDir,'content.json'));
    const artifacts=runtime.artifacts.map(a=>({...a,url:`/artifacts/${runtime.hash}/${a.path}`}));
    const release={id,project_id:build.project_id,revision:revision.id,runtime_hash:runtime.hash,content_hash,authority_binary:runtime.authority_binary,artifacts,content_url:`/content/${content_hash}/content.json`,status:'ready',schema:1,engine:'4.6-stable',created_at:Date.now(),validation:{build_id:build.id,kind:'godot-headless-content',passed:true}};
    this.store.transaction(()=>{
      this.store.put('release',release);const branch=this.store.get('branch',`${build.project_id}:${build.branch}`);
      if(branch.publish_generation!==build.generation||branch.source_head!==build.revision){build.status='superseded';}
      else {branch.playable_head=id;this.store.put('branch',branch);build.status='passed';}
      build.release_id=id;build.finished_at=Date.now();this.store.put('build',build);this.store.event(build.project_id,{kind:'build_'+build.status,title:`${build.branch} · ${build.status}`,release_id:id});
    });
  }
}
