const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const speedText=n=>Number(n.toFixed(n<10?2:1)).toString();
export class ViewportNavigation{
  constructor({viewport,menu,preview,userId}){
    Object.assign(this,{viewport,menu,preview,userId});this.speed=6;this.multiplier=1;this.documentId=null;
    this.speedInput=menu.querySelector('#cameraMoveSpeed');this.slider=menu.querySelector('#cameraSpeedRange');this.sensitivity=menu.querySelector('#cameraSensitivity');this.response=menu.querySelector('#cameraResponse');
    this.hud=document.createElement('div');this.hud.className='navigation-hud';this.hud.hidden=true;this.hud.innerHTML='<div><span>漫游速度</span><strong></strong><small></small></div><div class="navigation-speed-track"><i></i></div><p>右键 + 滚轮调速 · Shift 加速 · Alt 精细</p>';viewport.append(this.hud);
    this.fps=document.createElement('span');this.fps.className='navigation-fps';this.fps.hidden=true;this.fps.setAttribute('aria-label','视口帧率');viewport.append(this.fps);
    this.speedInput.onchange=()=>{const speed=Number(this.speedInput.value);if(Number.isFinite(speed)){this.speed=clamp(speed,.1,1000);this.paint();this.save();this.post();this.show();}};
    this.slider.oninput=()=>{this.speed=.1*10**Number(this.slider.value);this.paint();this.save();this.post();this.show();};
    this.sensitivity.oninput=()=>{this.save();this.post();};this.response.onchange=()=>{this.save();this.post();};
  }
  key(){return 'wa-navigation-v2:'+this.userId();}
  loaded(){
    const p=this.preview();this.documentId=p?.sceneContext?.document_id;this.hud.hidden=true;this.fps.hidden=true;this.flying=false;this.multiplier=1;
    let saved={};try{saved=JSON.parse(localStorage.getItem(this.key())??'{}');this.speed=Number(saved.speed??localStorage.getItem('wa-camera-speed:'+this.userId())??6);}catch{this.speed=6;}
    this.speed=Number.isFinite(this.speed)?clamp(this.speed,.1,1000):6;this.sensitivity.value=String(clamp(Number(saved.sensitivity)||1,.2,3));this.response.value=saved.response==='direct'?'direct':'smooth';this.paint();this.post();
  }
  paint(){
    this.speedInput.value=speedText(this.speed);this.slider.value=String(Math.log10(this.speed/.1));
    this.menu.querySelector('[data-camera-speed]').textContent=speedText(this.speed)+' m/s';
    this.hud.querySelector('strong').textContent=speedText(this.speed*this.multiplier)+' m/s';
    this.hud.querySelector('small').textContent=this.multiplier===1?'':this.multiplier>1?'加速 ×3':'精细 ×0.2';
    this.hud.querySelector('i').style.width=clamp(Math.log10(this.speed/.1)/4*100,0,100)+'%';
  }
  show(){
    this.hud.hidden=false;clearTimeout(this.timer);this.timer=setTimeout(()=>{if(!this.flying)this.hud.hidden=true;},1500);
  }
  save(){
    try{localStorage.setItem(this.key(),JSON.stringify({speed:this.speed,sensitivity:Number(this.sensitivity.value),response:this.response.value}));}catch{}
  }
  post(){
    const p=this.preview();if(p?.ready&&!p.pending&&p.loadedSeq===p.seq)p.post({type:'navigation_settings',seq:p.seq,document_id:p.sceneContext.document_id,camera_speed:this.speed,sensitivity:Number(this.sensitivity.value)*.0025,response:this.response.value});
  }
  accept(event){
    if(event.document_id!==this.preview()?.sceneContext?.document_id)return;
    if(event.type==='viewport_performance'){
      this.fps.hidden=false;this.fps.textContent=Math.round(event.fps)+' FPS';this.fps.dataset.level=event.fps<35?'slow':event.fps<55?'medium':'fast';
      this.fps.title=`引擎实测 ${event.frame_ms.toFixed(1)} ms / 帧 · P95 ${event.p95_ms.toFixed(1)} ms`;return;
    }
    if(event.type!=='camera')return;
    if(event.dimension==='2d'){this.hud.hidden=true;this.flying=false;return;}
    if(!Number.isFinite(event.camera_speed))return;
    const changed=Math.abs(this.speed-event.camera_speed)>.00001;
    this.speed=event.camera_speed;this.multiplier=event.speed_multiplier??1;const wasFlying=this.flying;this.flying=event.navigation==='freelook';
    this.paint();if(changed){clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>this.save(),200);}
    if(changed||this.flying||wasFlying)this.show();
  }
}
