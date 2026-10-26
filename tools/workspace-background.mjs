import {mkdir,readFile,writeFile,unlink,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const label='com.worldatelier.workspace';
const domain=`gui/${process.getuid?.()}`;
const target=`${domain}/${label}`;
const plist=resolve(homedir(),'Library/LaunchAgents',`${label}.plist`);
const logs=resolve(root,'.local/background');
const xml=value=>String(value).replace(/[<>&"']/g,char=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[char]));
const command=process.argv[2]??'status';
function launchctl(...args){return spawnSync('/bin/launchctl',args,{encoding:'utf8'});}
function checked(result){if(result.error)throw result.error;if(result.status!==0)throw Error(result.stderr||result.stdout||`launchctl exited ${result.status}`);return result;}
async function main(){
  if(process.platform!=='darwin')throw Error('后台服务管理目前仅支持 macOS。');
  if(command==='status'){
    const state=launchctl('print',target);
    console.log(state.status===0?state.stdout:'世界工坊后台守护尚未加载。');
    console.log(`日志：${logs}`);
    const response=await fetch('http://127.0.0.1:48910/preview-api/health',{signal:AbortSignal.timeout(3000)}).catch(()=>null);
    console.log('工作台健康：',response?.ok?await response.json():'不可达');
    return;
  }
  if(command==='uninstall'){
    if(launchctl('print',target).status===0)checked(launchctl('bootout',target));
    await unlink(plist).catch(error=>{if(error.code!=='ENOENT')throw error;});
    console.log('已移除后台守护；其托管的服务会停止，外部已运行服务不会被停止。');return;
  }
  if(command!=='install')throw Error('用法：node tools/workspace-background.mjs install|status|uninstall');
  // Pin this canonical service and data. Never inherit a test server identity.
  for(const name of ['WORLD_ATELIER_PREVIEW_PORT','WORLD_ATELIER_PREVIEW_DATA','WORLD_ATELIER_CREATION_DATA']){
    if(process.env[name]!==undefined)throw Error(`安装前请移除 ${name}；后台守护仅管理正式 48910 和默认数据。`);
  }
  const env={HOME:homedir(),PATH:process.env.PATH??'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',WORLD_ATELIER_PREVIEW_PORT:'48910',WORLD_ATELIER_PREVIEW_DATA:resolve(root,'.local/model-preview'),WORLD_ATELIER_CREATION_DATA:resolve(root,'.local/model-preview/creation')};
  let node=process.execPath;
  for(const candidate of ['/opt/homebrew/bin/node','/usr/local/bin/node'])if(await realpath(candidate).catch(()=>null)===await realpath(process.execPath)){node=candidate;break;}
  // Explicit non-secret runtime configuration only; authentication stays in the
  // existing user's credential store, never copied into a plist or log.
  for(const key of ['CODEX_HOME','CODEX_BIN','GODOT_BIN','LANG','LC_ALL','WORLD_ATELIER_LAN','WORLD_ATELIER_PUBLIC_PLAY'])if(process.env[key]!==undefined)env[key]=process.env[key];
  const source=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(resolve(root,'tools/start-workspace.mjs'))}</string><string>--background</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key,value])=>`<key>${key}</key><string>${xml(value)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>15</integer>
<key>ExitTimeOut</key><integer>60</integer>
<key>StandardOutPath</key><string>${xml(resolve(logs,'stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(resolve(logs,'stderr.log'))}</string>
</dict></plist>
`;
  await mkdir(dirname(plist),{recursive:true});await mkdir(logs,{recursive:true});
  const old=await readFile(plist,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(launchctl('print',target).status===0){
    if(old!==source)throw Error('后台守护已加载但配置不同；请先在任务空闲时 uninstall，再 install。');
    console.log('后台守护已加载，无需重启。');return;
  }
  if(old!==null&&old!==source)throw Error(`已有不同的 ${plist}，请先核对后移除；不会覆盖。`);
  await writeFile(plist,source,{mode:0o600});
  checked(spawnSync('/usr/bin/plutil',['-lint',plist],{encoding:'utf8'}));
  checked(launchctl('bootstrap',domain,plist));
  console.log(`已启用登录后后台守护：${target}\n已有服务继续运行；退出后自动由守护接管。\n日志：${logs}`);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
