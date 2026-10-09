import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {setPriority} from 'node:os';
import {CreationStore} from './store.mjs';
import {CreationBuilds} from './export-builds.mjs';
import {NativeSourceArchive} from './native-source.mjs';

// This process is an executor, never a second product service. It does not run
// store migrations, queue recovery, Agents, worlds or database writes. WAL reads
// are individual statements so edits and permission revocations stay live.
const send=value=>{if(process.connected)process.send(value);};
// disconnect() can drop queued IPC messages under controller backpressure.
// Flush the terminal message (and all preceding progress) before disconnecting.
const finish=value=>new Promise((resolve,reject)=>{
  if(!process.connected){reject(Error('构建控制器连接已关闭'));return;}
  process.send(value,error=>error?reject(error):resolve());
});
let builds=null,stopping=false;
function stop(){
  if(stopping)return;stopping=true;
  if(builds){builds.closing=true;if(builds.child)try{process.kill(process.platform==='win32'?builds.child.pid:-builds.child.pid,'SIGKILL');}catch{}}
  // Also stop helper processes which inherit this worker's process group.
  if(process.platform!=='win32')try{process.kill(-process.pid,'SIGTERM');}catch{}
  process.exit(1);
}
process.on('SIGTERM',stop);process.on('disconnect',stop);
process.once('message',async config=>{
  let db;
  try{
    try{setPriority(10);}catch{} // Keep interactive services ahead of CPU work.
    db=new DatabaseSync(config.database,{readOnly:true});
    const store=Object.assign(Object.create(CreationStore.prototype),{db,read:db.prepare('SELECT body FROM documents WHERE kind=? AND id=?'),publicPlay:config.publicPlay,adminUserId:config.adminUserId});
    for(const method of ['put','remove','transaction','event'])store[method]=()=>{throw Error('构建执行器不能修改中央源数据库');};
    const service={root:config.root,data:config.data,store,native:{archive:new NativeSourceArchive(config.archive)}};
    builds=Object.assign(Object.create(CreationBuilds.prototype),{service,store,directory:join(config.data,'builds'),godot:config.godot,templates:config.templates,closing:false,child:null});
    builds.onChild=pid=>send({type:'engine',pid});
    builds.update=(job,patch)=>{
      Object.assign(job,patch,{updated_at:Date.now()});
      send({type:'update',job});return job;
    };
    builds.executionUser(config.job);
    builds.update(config.job,{executor:{kind:'process',pid:process.pid}});
    await builds.execute(config.job);
    await finish({type:'done'});
  }catch(error){try{await finish({type:'failed',error:builds?builds.cleanError(error.message):String(error.message)});}catch{process.exitCode=1;}}
  finally{db?.close();process.removeListener('disconnect',stop);if(process.connected)process.disconnect();}
});
