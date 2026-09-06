import {watch} from 'node:fs';
import {resolve,join} from 'node:path';
import {parseArgs} from './runtime.mjs';
import {checkoutWorkspace,pushWorkspace,resolveWorkspace,playOffline} from './workspace.mjs';
const [command,...values]=process.argv.slice(2),args=parseArgs(values),directory=resolve(args.dir??'.local/workspace');
const options={directory,server:args.server??'http://127.0.0.1:48900',token:process.env.WORLD_ATELIER_TOKEN,project:args.project,branch:args.branch??'main',message:args.message,world:args.world,build:!args['no-build'],runtimeHash:args['runtime-hash']};
try{
  if(command==='checkout'){if(!args.project)throw Error('--project=ID required');await checkoutWorkspace(options);}
  else if(command==='play'){await playOffline({file:join(directory,'workspace.json'),edited:!!args.edited,newSave:!!args['new-save'],options:args});}
  else if(command==='resolve'){if(!args['accept-current'])throw Error('Inspect local-conflicts.json, edit content.json, then use resolve --accept-current to accept your full resolution');await resolveWorkspace(directory);console.log('已记录人工冲突解决；尚未再次上传。');}
  else if(command==='push')await pushWorkspace(options);
  else if(command==='watch'){
    let busy=false,dirty=false,timer;
    const push=async()=>{if(busy){dirty=true;return;}busy=true;try{await pushWorkspace(options);}catch(error){console.error(error.message);}finally{busy=false;if(dirty){dirty=false;timer=setTimeout(push,450);}}};
    const watcher=watch(directory,(_,file)=>{if(file==='content.json'){clearTimeout(timer);timer=setTimeout(push,450);}});
    const stop=()=>{clearTimeout(timer);watcher.close();};process.on('SIGINT',stop);process.on('SIGTERM',stop);
    await push();console.log('正在监听源稿 content.json；真实构建/应用结果会单独报告。');
  }else throw Error('Usage: workspace.mjs checkout|push|watch|play|resolve --dir=PATH [--project=ID --branch=main --server=URL] [--edited --new-save]');
}catch(error){console.error(error.message);if(error.details)console.error(JSON.stringify(error.details));process.exitCode=1;}
