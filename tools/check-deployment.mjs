import {accessSync,constants,existsSync,readFileSync} from 'node:fs';
import {resolve,join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {executionCapabilities} from '../services/creation/execution-environment.mjs';

export const EXPECTED_GODOT='4.6.stable.official.89cea1439';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const executable=path=>{try{accessSync(path,constants.X_OK);return true;}catch{return false;}};
function command(binary,args,env,cwd){
  const result=spawnSync(binary,args,{env,cwd,encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
  if(result.error||result.status!==0)throw Error((result.error?.message||result.stderr||result.stdout||`${binary} exited ${result.status}`).trim().slice(0,800));
  return result.stdout.trim();
}

/** Deployment prerequisites only. No package installation, account creation,
 * source writes, Godot window, Agent execution or server startup occurs here. */
export async function checkDeployment({directory=root,env=process.env,platform=process.platform,nodeVersion=process.versions.node,userHome=homedir(),browser=false,probeService=true}={}){
  const run=(binary,args)=>command(binary,args,env,directory);
  const checks=[],add=(id,status,detail,fix=null)=>checks.push({id,status,detail,...(fix?{fix}:{})});
  const check=(id,action,fix)=>{try{add(id,'pass',action());return true;}catch(error){add(id,'fail',error.message,fix);return false;}};
  const checkAsync=async(id,action,fix)=>{try{add(id,'pass',await action());return true;}catch(error){add(id,'fail',error.message,fix);return false;}};
  check('host',()=>{if(platform!=='darwin')throw Error(`当前服务器执行后端不支持 ${platform}，完整部署需要 macOS`);return 'macOS';},'使用 macOS 主机；不要关闭执行隔离或把 Node 服务启动当作游戏已可运行。');
  check('node',()=>{if(Number(nodeVersion.split('.')[0])<24)throw Error(`当前 Node.js ${nodeVersion}，需要 24+`);return `Node.js ${nodeVersion}`;},'安装 Node.js 24+，确认 node --version 后重跑预检。');
  await checkAsync('sqlite',async()=>{const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(':memory:');try{db.prepare('SELECT 1').get();return 'node:sqlite 可用，无需另装数据库服务';}finally{db.close();}},'使用包含 node:sqlite 的 Node.js 24+ 官方发行版。');
  for(const [id,args,fix]of [
    ['npm',['--version'],'安装 Node.js 随附的 npm。'],
    ['git',['--version'],'安装 Git，然后重新克隆完整仓库。'],
    ['python3',['--version'],'安装 Python 3；模板安装和模板完整性检查需要它。'],
    ['curl',['--version'],'安装 curl；官方工具链下载需要它。'],
    ['zip',['-v'],'安装 zip；实际 Web 构建需要它压缩导出包。'],
  ])check(id,()=>{const version=run(id,args).split('\n')[0];if(id==='python3'&&!/^Python 3\./.test(version))throw Error(`需要 Python 3，实际为 ${version}`);return version;},fix);
  if(platform==='darwin')check('execution_isolation',()=>{
    if(!executionCapabilities().available)throw Error('缺少 /usr/bin/sandbox-exec');
    run('/usr/bin/sandbox-exec',['-p','(version 1)(deny default)(allow process-exec sysctl-read mach-lookup file-read* file-map-executable)','/usr/bin/true']);
    return 'macOS 执行隔离可用（实际执行无写入探针）';
  },'使用支持 sandbox-exec 的 macOS 执行环境；若外层 Agent 环境禁止启动它，请在支持的主机终端执行，不移除项目隔离检查。');

  const godot=env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot';
  check('godot',()=>{
    if(!isAbsolute(godot)||!executable(godot))throw Error(`Godot 需要绝对可执行路径：${godot}`);
    const version=run(godot,['--version']);if(version!==EXPECTED_GODOT)throw Error(`Godot 版本为 ${version}，必须为 ${EXPECTED_GODOT}`);
    return {path:godot,version};
  },'按 docs/AGENT-DEPLOYMENT.md 安装官方 4.6-stable 标准版；构建、预检和启动时使用同一 GODOT_BIN。');
  const standardTemplates=join(userHome,platform==='darwin'?'Library/Application Support/Godot/export_templates/4.6.stable':'.local/share/godot/export_templates/4.6.stable');
  const customTemplates=env.WORLD_ATELIER_EXPORT_TEMPLATES;
  if(customTemplates!==undefined)check('export_template_path',()=>{if(!customTemplates||!isAbsolute(customTemplates))throw Error('WORLD_ATELIER_EXPORT_TEMPLATES 必须是非空绝对路径');return customTemplates;},'不使用自定义模板时移除这个变量；使用时填写模板目录的绝对路径。');
  const templateDirectories=[...new Set([standardTemplates,...(customTemplates&&isAbsolute(customTemplates)?[customTemplates]:[])])];
  for(const [index,path]of templateDirectories.entries())check(index?'play_web_template':'preview_web_template',()=>{
    const version=readFileSync(join(path,'version.txt'),'utf8').trim();if(version!=='4.6.stable')throw Error(`模板版本不匹配：${version}`);
    const template=join(path,'web_nothreads_release.zip');
    run('python3',['-c',
      'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n missing=set(["godot.js","godot.wasm","godot.html"])-set(z.namelist())\n if missing: raise ValueError("Missing Web template entries: "+str(missing))\n bad=z.testzip()\n if bad: raise ValueError("Corrupt Web template entry: "+bad)\n',template]);
    return {directory:path,version,zip_crc:'passed'};
  },'运行 python3 tools/install-release-templates.py web。build:preview 使用标准用户模板目录；Play 还需检查 WORLD_ATELIER_EXPORT_TEMPLATES 指定的目录。已有损坏文件需先备份移走再重装，安装器会跳过已有文件。');

  const lockPath=join(directory,'package-lock.json');
  let lock;
  check('dependency_lock',()=>{lock=JSON.parse(readFileSync(lockPath,'utf8'));return '使用仓库 package-lock.json';},'重新获取完整仓库；不要生成另一份锁文件替代缺失文件。');
  const require=createRequire(join(directory,'package.json'));
  check('dependencies',()=>{
    const pkg=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));
    for(const name of Object.keys(pkg.dependencies??{})){
      const installed=JSON.parse(readFileSync(join(directory,'node_modules',name,'package.json'),'utf8'));
      if(installed.version!==lock?.packages?.[`node_modules/${name}`]?.version)throw Error(`${name} 与锁定版本不一致`);
      require.resolve(name);
    }
    return '运行依赖均已安装且与锁文件版本一致';
  },'在当前 clone 根目录执行 npm ci。');
  check('esbuild_binary',()=>{require('esbuild').transformSync('export const ready = true;',{loader:'js'});return 'esbuild 本机二进制可执行';},'先执行 npm ci；若 npm 明确阻止 esbuild 安装脚本，再按 npm 的提示批准该包并重试。');
  await checkAsync('default_projects',async()=>{
    const {DefaultProjectBundle}=await import('../services/creation/default-projects.mjs');
    const bundle=new DefaultProjectBundle(join(directory,'content/default-projects'));
    const sizes=new Map();for(const key of Object.keys(bundle.catalog.objects))sizes.set(key,bundle.readObject(key).length);
    for(const project of bundle.catalog.projects){
      bundle.cover(project.cover);
      for(const branch of project.branches){
        const manifest=bundle.snapshot(branch);bundle.cover(branch.cover);
        for(const [path,entry]of Object.entries(manifest.source_files))if(sizes.get(entry.hash)!==entry.size)throw Error(`默认工程源文件引用缺失或大小错误：${project.name}/${branch.id}/${path}`);
      }
    }
    return {projects:bundle.catalog.projects.length,branches:bundle.catalog.projects.reduce((n,p)=>n+p.branches.length,0),objects:Object.keys(bundle.catalog.objects).length,version:bundle.catalog.version};
  },'重新拉取 content/default-projects 的完整内容；不要只复制应用代码或重新生成空 demo。');
  const port=Number(env.WORLD_ATELIER_PREVIEW_PORT??48910),validPort=Number.isInteger(port)&&port>=1&&port<=65535;
  if(!validPort)add('service_port','fail','工作台端口配置无效','日常部署使用 48910。');
  // Match the actual server/launcher semantics: an explicitly set value is
  // enabled only by "1"; alternate test ports do not implicitly expose samples.
  const defaultsEnabled=env.WORLD_ATELIER_DEFAULT_PROJECTS===undefined?port===48910:env.WORLD_ATELIER_DEFAULT_PROJECTS==='1';
  const publicPlay=env.WORLD_ATELIER_PUBLIC_PLAY===undefined?port===48910:env.WORLD_ATELIER_PUBLIC_PLAY==='1';
  if(!defaultsEnabled)add('default_projects_enabled','fail','当前有效配置关闭了默认工程安装','以 WORLD_ATELIER_DEFAULT_PROJECTS=1 启动；不要使用 true/false 字符串。');
  if(!publicPlay)add('public_examples','fail','当前有效配置关闭了注册用户对默认工程的访问','如需其他人查看案例，以 WORLD_ATELIER_PUBLIC_PLAY=1 启动；不要使用 true/false 字符串。');
  if(validPort&&port!==48910)check('isolated_test_data',()=>{
    if(!env.WORLD_ATELIER_PREVIEW_DATA||!env.WORLD_ATELIER_CREATION_DATA||resolve(directory,env.WORLD_ATELIER_PREVIEW_DATA)===resolve(directory,env.WORLD_ATELIER_CREATION_DATA))throw Error('其他端口仅用于隔离测试，必须显式设置不同的 PREVIEW_DATA 与 CREATION_DATA');
    return '测试数据路径已显式指定；启动器还会核对真实路径与正式目录是否重叠';
  },'日常部署使用默认 48910；隔离测试按 docs/LOCAL-DEVELOPMENT.md 设置独立目录。');
  if(browser){
    check('browser_test_dependency',()=>{const installed=JSON.parse(readFileSync(join(directory,'node_modules/@playwright/test/package.json'),'utf8'));if(installed.version!==lock?.packages?.['node_modules/@playwright/test']?.version)throw Error('@playwright/test 与锁定版本不一致');require.resolve('@playwright/test');return '@playwright/test 已安装';},'执行 npm ci（不要使用 --omit=dev）。');
    check('chrome',()=>{const path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';if(!executable(path))throw Error('自动浏览器检查需要 Google Chrome');return path;},'安装 Google Chrome 后执行 npm run test:defaults:browser；仅安装 Playwright Chromium 不满足 channel: chrome。');
  }
  if(probeService){
    if(validPort){
      try{
        const response=await fetch(`http://127.0.0.1:${port}/preview-api/health`,{signal:AbortSignal.timeout(2000)}),health=await response.json();
        if(!response.ok||!health.ok||health.service!=='model-preview')throw Error('监听者不是已确认的世界工坊服务');
        add('service','info',{port,existing_workspace:true,runtime_ready:health.runtime_ready,default_projects:health.default_projects,public_play:health.public_play});
      }catch(error){
        if(error.cause?.code==='ECONNREFUSED')add('service','info',{port,existing_workspace:false,next:'环境通过后执行 build:preview 和 npm start'});
        else add('service','fail',`无法确认 ${port} 端口的服务：${error.message}`,`用 lsof -nP -iTCP:${port} -sTCP:LISTEN 核对；不杀其他进程、不自动换产品端口。`);
      }
    }
  }
  return {schema:'world-atelier-deployment-check-1',ok:!checks.some(check=>check.status==='fail'),scope:'环境与分发字节预检；不代表视口构建、登录或游戏运行已经通过',root:directory,expected_godot:EXPECTED_GODOT,checks,next:'docs/AGENT-DEPLOYMENT.md'};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.includes('--help'))console.log('用法：node tools/check-deployment.mjs [--json] [--browser]\n只检查环境；--browser 额外检查自动浏览器验证的依赖。');
  else if(args.some(arg=>!['--json','--browser'].includes(arg))){console.error('未知参数。使用 --help 查看用法。');process.exitCode=2;}
  else{
    const report=await checkDeployment({browser:args.includes('--browser')});
    if(args.includes('--json'))console.log(JSON.stringify(report,null,2));
    else{
      console.log('世界工坊 · 部署环境预检');
      for(const check of report.checks)console.log(`[${check.status.toUpperCase()}] ${check.id}: ${typeof check.detail==='string'?check.detail:JSON.stringify(check.detail)}${check.fix?'\n  修复：'+check.fix:''}`);
      console.log(`\n${report.ok?'环境预检通过。':'请先解决 FAIL 项。'} ${report.scope}\n下一步：${report.next}`);
    }
    process.exitCode=report.ok?0:1;
  }
}
