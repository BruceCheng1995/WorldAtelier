import {importSaveDomain} from './storage.js';

const config=JSON.parse(document.querySelector('#runtime-config').textContent);
const status=document.querySelector('#status'),params=new URLSearchParams(location.search);
const embedded=parent!==window&&params.get('launch')==='editor'&&params.get('wa_embedded')==='1';
const storageBridge=parent!==window&&params.get('wa_storage_bridge')==='1';
const nonce=config.launch_nonce;
const outbound=new Set(['ready','loaded','world_state','camera','selected','error','runtime_error','native_shared','shared_ready','prefab_test_state','prefab_test_result','play_context','captured_frame']);
const inbound=new Set(['start','select','camera','world','native_shared','prefab_test','context_request']);
let frame=null,latest=null,disposed=false,capturing=false;
const notify=message=>{if(parent!==window)parent.postMessage({source:'world-atelier-game',nonce,...message},config.parent_origin);};
const identity={source_revision:config.source_revision,canonical_identity:config.canonical_identity,runtime_source_hash:config.runtime_source_hash};
function failure(message){status.textContent=message;notify({type:'runtime_error',message,...identity});}
async function capture(request){
  if(capturing||!frame||!latest)return;capturing=true;
  const fixed={...latest};
  try{
    if(request.scene_generation!==undefined&&request.scene_generation!==fixed.scene_generation||request.document_id&&request.document_id!==fixed.document_id)throw Error('截图目标已切换');
    await new Promise(resolve=>frame.contentWindow.requestAnimationFrame(resolve));
    if(latest.scene_generation!==fixed.scene_generation||latest.document_id!==fixed.document_id)throw Error('截图期间场景已切换');
    const canvas=frame.contentDocument?.querySelector('canvas');if(!canvas?.width||!canvas.height)throw Error('游戏画面尚未就绪');
    const image=document.createElement('canvas'),scale=Math.min(1,1280/canvas.width,720/canvas.height);image.width=Math.max(1,Math.round(canvas.width*scale));image.height=Math.max(1,Math.round(canvas.height*scale));
    image.getContext('2d').drawImage(canvas,0,0,image.width,image.height);
    notify({type:'captured_frame',request_id:request.request_id,seq:request.seq,document_id:fixed.document_id,scene_generation:fixed.scene_generation,...identity,captured_at:Date.now(),width:image.width,height:image.height,data_url:image.toDataURL('image/png')});
  }catch(error){notify({type:'captured_frame',request_id:request.request_id,seq:request.seq,...identity,error:error.message});}
  finally{capturing=false;}
}
addEventListener('message',async event=>{
  if(disposed)return;
  if(event.source===parent&&parent!==window&&event.origin===config.parent_origin){
    const packet=event.data;
    if(packet?.source!=='world-atelier-workspace'||packet.nonce!==nonce)return;
    if(storageBridge){
      if(packet.type!=='storage_import'||typeof packet.request_id!=='string')return;
      try{const result=await importSaveDomain(config.storage,packet.packet);notify({type:'storage_imported',request_id:packet.request_id,...result});}
      catch(error){notify({type:'storage_imported',request_id:packet.request_id,error:error.message});}
      return;
    }
    if(!embedded)return;
    if(packet.type==='capture_frame'){void capture(packet);return;}
    if(inbound.has(packet.type))frame?.contentWindow.postMessage(packet,location.origin);
    return;
  }
  if(!frame||event.source!==frame.contentWindow||event.origin!==location.origin)return;
  const packet=event.data;
  if(packet?.source!=='world-atelier-game'||packet.nonce!==nonce||!outbound.has(packet.type))return;
  if(packet.source_revision&&packet.source_revision!==config.source_revision||packet.canonical_identity&&packet.canonical_identity!==config.canonical_identity)return;
  if(['loaded','world_state'].includes(packet.type)&&packet.document_id)latest={document_id:packet.document_id,scene_generation:packet.scene_generation,seq:packet.seq};
  if(['loaded','world_state','shared_ready'].includes(packet.type))status.textContent='';
  if(embedded)notify(packet);
});
if(storageBridge){status.textContent='正在准备存档迁移…';notify({type:'storage_ready',storage:config.storage});}
else{
  frame=document.createElement('iframe');frame.id='game';frame.title='Godot 游戏';frame.allow='fullscreen; autoplay';frame.referrerPolicy='no-referrer';frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-pointer-lock');
  const url=new URL('web/index.html',location.href);
  if(embedded){url.searchParams.set('launch','editor');url.searchParams.set('wa_embedded','1');url.searchParams.set('nonce',nonce);url.searchParams.set('wa_parent_origin',location.origin);}
  frame.src=url.href;document.body.prepend(frame);
  if(!embedded)frame.addEventListener('load',()=>{status.textContent='';},{once:true});
}
const renewal=setInterval(async()=>{
  try{const response=await fetch(new URL('renew',location.href),{method:'POST',credentials:'omit'});if(!response.ok)throw Error('试玩授权已失效；已加载的游戏保留，请从工作台重新打开后继续加载资源。');}
  catch(error){failure(error.message);clearInterval(renewal);}
},4*60*1000);
addEventListener('pagehide',()=>{disposed=true;clearInterval(renewal);},{once:true});
