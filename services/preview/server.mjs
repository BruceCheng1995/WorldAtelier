import http from 'node:http';
import { workspaceNetwork } from './network.mjs';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { dirname, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectGLB, MAX_GLB_BYTES } from './glb.mjs';
import { createHash } from 'node:crypto';
import { CreationService } from '../creation/service.mjs';
import {adminPreviewBundle,adminModelBytes} from '../creation/admin-model-preview.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.env.WORLD_ATELIER_PREVIEW_PORT ?? 48910);
const network = workspaceNetwork(port);
const data = resolve(process.env.WORLD_ATELIER_PREVIEW_DATA ?? `${root}/.local/model-preview`);
if(existsSync(resolve(process.env.WORLD_ATELIER_CREATION_DATA??`${data}/creation`,'.native-migration.lock')))throw new Error('原生源稿迁移正在维护数据，暂不能启动工作台');
const build = resolve(process.env.WORLD_ATELIER_PREVIEW_BUILD ?? `${root}/.local/model-preview/build`);
const app = resolve(root, 'apps/creation-workspace');
mkdirSync(resolve(data, 'uploads'), { recursive: true });
function json(res, status, value) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); }
function file(res, path, immutable = false, privateFile = false, status = 200) {
  if (!existsSync(path) || !statSync(path).isFile()) return json(res, 404, {error:'文件不存在，请先构建模型预览运行时'});
  const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.wasm':'application/wasm','.pck':'application/octet-stream','.glb':'model/gltf-binary','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
  res.writeHead(status, {'Content-Type':types[extname(path)]??'application/octet-stream','Content-Length':statSync(path).size,'Cache-Control':privateFile?'private, no-store':immutable?'public,max-age=31536000,immutable':'no-cache','X-Content-Type-Options':'nosniff'});
  createReadStream(path).pipe(res);
}
function catalog() {
  const p = resolve(root, 'content/model-preview/manifest.json');
  if (!existsSync(p)) return {models:[]};
  const m = JSON.parse(readFileSync(p));
  return m;
}
async function body(req) {
  let size=0; const chunks=[];
  for await (const chunk of req) { size += chunk.length; if (size > MAX_GLB_BYTES) throw Object.assign(new Error('模型超过 20 MB 上限'),{status:413}); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const server = http.createServer(async(req,res)=>{
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  try {
    if(network.runtimeRequestOrigin(req)){
      if(creation.runtimeAccess.request(req,res))return;
      return json(res,403,{error:'运行地址不提供创作或管理接口'});
    }
    const origin = network.requestOrigin(req);
    if (!origin) return json(res,403,{error:'请使用当前工作台的本机或局域网地址'});
    const path = decodeURIComponent(new URL(req.url,origin).pathname);
    if (path.includes('\0') || path.split('/').includes('..') || path.includes('\\')) return json(res,400,{error:'无效路径'});
    if (await creation.request(req,res)) return;
    if (creation.builds.webRequest(req,res)) return;
    if (creation.assetRequest(req,res)) return;
    if (req.method==='GET' && path==='/preview-api/health') return json(res,200,{ok:true,runtime_ready:existsSync(resolve(build,'index.wasm')),service:'model-preview',lan_enabled:network.lan,listen_host:network.host,public_play:network.publicPlay,registration_open:true});
    if (req.method==='GET' && path==='/preview-api/catalog') return json(res,200,catalog());
    if (req.method==='POST' && path==='/preview-api/assets') {
      if (req.headers.origin !== origin) return json(res,403,{error:'模型导入需要来自当前工作台'});
      if(!creation.store.canCreateProject(creation.auth(req)))return json(res,403,{error:'模型导入需要创作授权'});
      const bytes=await body(req); const info=inspectGLB(bytes);
      if(creation.store.get('creator_asset',info.hash)?.quarantined_at)return json(res,403,{error:'该资产已被管理员隔离，不能重新上传使用'});
      const destination=resolve(data,'uploads',info.hash+'.glb');
      if (!existsSync(destination)) { const tmp=destination+'.tmp';writeFileSync(tmp,bytes);renameSync(tmp,destination); }
      let name='导入模型.glb'; try { name=decodeURIComponent(String(req.headers['x-model-name']??name)); } catch {}
      name=basename(name).slice(0,160);
      return json(res,201,{...info,id:info.hash,name,url:'/preview-assets/'+info.hash+'.glb'});
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res,405,{error:'Method not allowed'});
    if (path.startsWith('/admin')) {
      res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      if(path.startsWith('/admin-models/')){
        const bytes=adminModelBytes(creation,req,path);
        res.writeHead(200,{'Content-Type':'model/gltf-binary','Content-Length':bytes.length,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
        res.end(req.method==='HEAD'?undefined:bytes);return;
      }
      if(path==='/admin-assets/admin-model-preview.js'){
        creation.admin.cookieUser(req);const bytes=adminPreviewBundle(root);
        res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Content-Length':bytes.length,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
        res.end(req.method==='HEAD'?undefined:bytes);return;
      }
      if(['/admin-login.js','/admin-login.css'].includes(path))return file(res,resolve(app,path.slice(1)),false,true);
      if(['/admin','/admin/','/admin.html'].includes(path)){
        try{creation.admin.cookieUser(req);}catch(error){return file(res,resolve(app,'admin-login.html'),false,true,error.status??401);}
        return file(res,resolve(app,'admin.html'),false,true);
      }
      if(['/admin-assets/admin.js','/admin-assets/admin.css','/admin-assets/admin-resource-charts.js'].includes(path)){creation.admin.cookieUser(req);return file(res,resolve(app,basename(path)),false,true);}
      return json(res,404,{error:'页面不存在'});
    }
    if (['/viewport-navigation.js','/viewport-annotations.js','/viewport-annotations.css','/native-authoring.js','/native-preview.js','/control-layout-inspector.js'].includes(path)) return file(res,resolve(app,path.slice(1)));
    if (['/prefab-lab.js','/prefab-lab.css','/animation-timeline.js'].includes(path)) return file(res,resolve(app,path.slice(1)));
    if (path==='/prefab-preview.html') return file(res,resolve(app,'prefab-preview.html'));
    if(path==='/native-shared-play.js')return file(res,resolve(app,'native-shared-play.js'));
    if (path==='/game-play.js') return file(res,resolve(app,'game-play.js'));
    if(['/runtime-access.js','/runtime-storage.js'].includes(path))return file(res,resolve(app,path.slice(1)));
    if(['/play-context.js','/play-context-buffer.js','/play-context.css','/session-continuation.js'].includes(path))return file(res,resolve(app,path.slice(1)));
    if(['/native-merge-panel.js','/native-offline-panel.js'].includes(path))return file(res,resolve(app,path.slice(1)));
    if(path==='/market-model-preview.js'){const bytes=adminPreviewBundle(root);res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-cache'});res.end(bytes);return;}
    if(['/market','/market/'].includes(path)||/^\/market\/assets\/[\w-]+$/.test(path))return file(res,resolve(app,'asset-market.html'));
    if(['/asset-market.js','/asset-market.css','/asset-market-page.js'].includes(path))return file(res,resolve(app,path.slice(1)));
    if (path==='/' || path==='/creation-workspace.html') return file(res,resolve(app,'index.html'));
    if (['/image-attachments.js','/reference-components.js','/reference-components.css','/semantic-composer.js','/semantic-inspector.js','/semantic-workspace-context.js','/semantic-authoring.css','/collaboration-access.js','/collaboration-access.css','/client-platform.js','/auto-game-cover.js','/game-catalog.js','/game-catalog.css','/workspace.js','/workspace.css','/preview-bridge.js','/transform-history.js','/collaboration-client.js','/hierarchy-editor.js','/hierarchy-prefabs.js','/inbox.js','/inbox.css','/client-diagnostics.js','/release-builds.js','/release-builds.css'].includes(path)) return file(res,resolve(app,path.slice(1)));
    if (path==='/packages/contracts/viewport-annotations.mjs') return file(res,resolve(root,'packages/contracts/viewport-annotations.mjs'));
    if (path==='/packages/contracts/authoring-references.mjs') return file(res,resolve(root,'packages/contracts/authoring-references.mjs'));
    if(path==='/packages/contracts/play-context.mjs')return file(res,resolve(root,'packages/contracts/play-context.mjs'));
    if (path==='/packages/scene/transform.mjs') return file(res,resolve(root,'packages/scene/transform.mjs'));
    if (path.startsWith('/preview-runtime/')) {
      const relative=path.slice('/preview-runtime/'.length);
      if (!relative || relative.startsWith('/') || !/^[\w.\/-]+$/.test(relative)) return json(res,400,{error:'无效运行时路径'});
      return file(res,resolve(build,relative));
    }
    if (path.startsWith('/preview-builds/')) {
      const match=/^\/preview-builds\/([a-f0-9]{64})\/([\w.-]+)$/.exec(path);
      if(!match)return json(res,400,{error:'无效客户端版本地址'});
      const release=resolve(dirname(build),'releases',match[1]),manifestPath=resolve(release,'manifest.json');
      if(!existsSync(manifestPath))return json(res,404,{error:'客户端版本不存在，请重新构建'});
      const manifest=JSON.parse(readFileSync(manifestPath)),entry=manifest.files.find(f=>f.path===match[2]);
      if(manifest.build_id!==match[1]||(!entry&&match[2]!=='manifest.json'))return json(res,404,{error:'文件不在客户端清单中'});
      const destination=resolve(release,match[2]);
      if(entry&&(!existsSync(destination)||createHash('sha256').update(readFileSync(destination)).digest('hex')!==entry.sha256))return json(res,409,{error:'客户端文件校验失败，拒绝加载损坏版本'});
      return file(res,destination,true);
    }
    if (path.startsWith('/preview-assets/')) {
      const name=path.slice('/preview-assets/'.length);
      if (!/^[\w-]+\.glb$/.test(name)) return json(res,400,{error:'无效资产地址'});
      if (/^[a-f0-9]{64}\.glb$/.test(name)) return file(res,resolve(data,'uploads',name),true);
      return file(res,resolve(root,'content/model-preview',name));
    }
    return json(res,404,{error:'Not found'});
  } catch(error) { if (!res.headersSent) json(res,error.status??400,{error:error.message});else res.destroy(); }
});
const creation = new CreationService({server,root,data:resolve(process.env.WORLD_ATELIER_CREATION_DATA??`${data}/creation`),origin:`http://127.0.0.1:${port}`,runtimeBuild:build,publicPlay:network.publicPlay,requestOrigin:network.requestOrigin,workspaceUrls:network.urls,network});
server.listen(port,network.host,()=>console.log(`世界工坊已启动（${network.publicPlay?'注册即可试玩现有游戏':'项目按邀请访问'}）：\n${network.urls().join('\n')}`));
let shuttingDown=false;
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{
  if(shuttingDown)return;shuttingDown=true;
  await creation.close();server.close(()=>process.exit(0));
});
