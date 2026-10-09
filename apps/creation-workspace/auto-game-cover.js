export const AUTO_COVER_DELAY=10000;
export const AUTO_COVER_INTERVAL=60000;
export const autoCoverEnabled=p=>p?.auto_update??!p?.images?.length;

/** A visible client's current frame supplies artwork; source/world authority is untouched. */
export class AutoGameCover {
  constructor({getState,capture,save,refresh,onStatus,clock=Date.now,delay=AUTO_COVER_DELAY,interval=AUTO_COVER_INTERVAL}){
    Object.assign(this,{getState,capture,save,refresh,onStatus,clock,delay,interval});this.key=null;this.due=0;this.busy=false;this.disposed=false;
  }
  start(){this.timer=setInterval(()=>this.tick(),1000);this.tick();}
  stop(){this.disposed=true;clearInterval(this.timer);this.key=null;}
  identity(state){return state?JSON.stringify([state.user_id,state.project_id,state.branch_id,state.resource_id,state.source_revision,state.mode]):null;}
  enabled(state){return state&&(autoCoverEnabled(state.presentation)||state.branch_id==='main'&&autoCoverEnabled(state.project_presentation));}
  tick(){
    if(this.disposed)return;const state=this.getState(),key=this.identity(state),now=this.clock();
    if(key!==this.key){this.key=key;this.due=now+this.delay;}
    if(!state){this.onStatus({hidden:true});return;}
    if(!this.enabled(state)){this.wasManual=true;this.onStatus({text:'封面 · 手动',manual:true});return;}
    if(this.wasManual){this.wasManual=false;this.due=now+this.delay;}
    if(!state.ready){this.due=now+this.delay;this.onStatus({text:state.wait_reason??'封面 · 等待游戏画面'});return;}
    if(this.busy){this.onStatus({text:'正在更新游戏封面…'});return;}
    if(now<this.due){this.onStatus({text:`封面 · ${Math.ceil((this.due-now)/1000)} 秒后更新`,seconds:Math.ceil((this.due-now)/1000)});return;}
    void this.run(state,key);
  }
  async run(state,key){
    this.busy=true;this.onStatus({text:'正在更新游戏封面…'});
    try{
      const image=await this.capture();const current=this.getState();
      if(this.disposed||key!==this.identity(current)||!current?.ready||!this.enabled(current))return;
      if(image.document_id!==`${state.project_id}/${state.branch_id}/${state.resource_id}`||image.source_revision!==state.source_revision)throw Error('游戏画面已切换，等待下一次截图');
      await this.save(state,{...image,name:'当前游戏画面'});
      if(!this.disposed&&key===this.identity(this.getState())){this.due=this.clock()+this.interval;this.onStatus({text:'封面已自动更新',updated:true});}
    }catch(error){
      if(this.disposed||key!==this.identity(this.getState()))return;
      if([409,403,429].includes(error.status))try{await this.refresh();}catch{}
      this.due=this.clock()+this.interval;this.onStatus({text:'封面 · 等待下次更新',error:error.message});
    }finally{this.busy=false;}
  }
}
