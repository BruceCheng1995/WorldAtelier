import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const LINUX_EXECUTION_POLICY='wa-linux-landlock-seccomp-1';
export const linuxSandboxPath=()=>resolve(process.env.WORLD_ATELIER_LINUX_SANDBOX??fileURLToPath(new URL('../../.local/toolchains/wa-linux-sandbox',import.meta.url)));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function linuxExecutionCapabilities(){
  const helper=linuxSandboxPath();let reason=null,probe=null;
  if(!existsSync(helper))reason='Linux 隔离 helper 尚未安装；请使用仓库的 Docker 镜像。';
  else{
    const result=spawnSync(helper,['--probe'],{encoding:'utf8',timeout:5000,maxBuffer:16384});
    try{probe=JSON.parse(result.stdout);}catch{}
    if(result.status!==0||probe?.policy!==LINUX_EXECUTION_POLICY||probe.abi<3||!probe.filesystem||!probe.seccomp)reason=(result.error?.message||result.stderr||'Linux 内核没有可用的 Landlock + seccomp').trim().slice(0,1200);
    else if(probe.source_sha256!==hash(readFileSync(new URL('../../tools/linux-sandbox.c',import.meta.url))))reason='Linux 隔离 helper 与当前策略源码不匹配；请重建镜像或 helper。';
  }
  return {version:1,available:!reason,provider:reason?'unsupported':'linux-landlock-seccomp',policy:LINUX_EXECUTION_POLICY,landlock_abi:probe?.abi??null,file_reads:reason?'unavailable':'system_and_explicit_paths',file_writes:reason?'unavailable':'explicit_paths_and_private_import_parents',safe_save:'private_parent_directories_with_post_import_hash_checks',network:'denied',socket_construction:'unconnected_tcp_only',private_user_data:!reason,inherited_host_environment:false,host_file_metadata_readable:true,resource_limits:false,multi_tenant_isolation:false,subprocesses:'denied',...(reason?{reason}:{})};
}
export function linuxExecutionIdentity(){
  const helper=linuxSandboxPath(),source=new URL('../../tools/linux-sandbox.c',import.meta.url);
  return {policy:LINUX_EXECUTION_POLICY,helper_sha256:hash(readFileSync(helper)),source_sha256:hash(readFileSync(source))};
}
export function linuxInvocation({binary,args,root,env,reads,writes,saves,projectPath}){
  const policy=new Map();
  // /proc/self is intentionally resolved by the helper, whose PID survives
  // exec. Resolving it in Node would accidentally allow the service's /proc.
  const system=['/usr/lib','/usr/lib64','/lib','/lib64','/usr/local/lib','/usr/share','/etc/ld.so.cache','/etc/fonts','/etc/ssl/certs','/etc/localtime','/etc/passwd','/etc/group','/etc/nsswitch.conf','/proc/self','/proc/cpuinfo','/proc/meminfo','/proc/sys/vm/overcommit_memory','/sys/devices/system/cpu','/sys/devices/system/node','/var/cache/fontconfig','/dev/urandom','/dev/random'];
  for(const path of [...system,...reads,...(projectPath?[projectPath]:[])])if(existsSync(path))policy.set(path,'--read');
  // Godot's atomic .import safe-save creates a random sibling. Landlock cannot
  // express filename regexes: only the explicit private import parent is RW.
  // Existing import/export callers verify fixed source bytes after the run.
  for(const path of [...writes,...saves.map(dirname),'/dev/null'])if(existsSync(path))policy.set(path,'--write');
  return {command:realpathSync(linuxSandboxPath()),args:[...policy].flatMap(([path,mode])=>[mode,path]).concat(['--',binary,...args]),options:{cwd:root,env:{...env,PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'}}};
}
