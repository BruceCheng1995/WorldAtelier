// Only editor Play installs these wrappers in the game's isolated iframe.
// Keep the host's bridge and inspection rendering on the native browser clock.
const timeout=window.setTimeout.bind(window),clearTimeoutNative=window.clearTimeout.bind(window);
export const hostFrame=window.requestAnimationFrame.bind(window),cancelHostFrame=window.cancelAnimationFrame.bind(window);

export function previewClock(activeOwner){
  const timers=new Map(),audio=new Map(),media=new Map(),retired=new Set();
  let retiredThrough=0;
  let held=false,serial=0,owner=null,started=0,pausedTime=0;
  let heldAnimations=[],heldMedia=[],heldAudio=[];
  const owned=(id,run)=>{
    const previous=owner;owner=id;
    try{return run();}finally{owner=previous;}
  };
  function arm(task){
    if(held)return;
    const fire=stamp=>{
      if(!timers.has(task.id))return;
      if(task.kind==='interval'){task.remaining=task.delay;arm(task);}
      else timers.delete(task.id);
      owned(task.owner,()=>{
        if(typeof task.callback==='function')task.callback.apply(window,task.kind==='frame'?[stamp-pausedTime]:task.args);
        else timeout(task.callback,0,...task.args); // Native CSP applies to string timers.
      });
    };
    task.due=performance.now()+task.remaining;
    task.native=task.kind==='frame'?hostFrame(fire):timeout(fire,task.remaining);
  }
  function schedule(kind,callback,delay=0,...args){
    if(kind==='frame'&&typeof callback!=='function')throw TypeError('requestAnimationFrame requires a callback');
    const ms=Math.max(0,Number(delay)|0),id=++serial;
    const task={id,kind,callback,delay:ms,remaining:ms,args,native:null,owner:owner??activeOwner()};
    if(!task.owner||task.owner>retiredThrough&&!retired.has(task.owner)){timers.set(id,task);arm(task);}
    return id;
  }
  function cancel(task){if(task.native!==null)(task.kind==='frame'?cancelHostFrame:clearTimeoutNative)(task.native);task.native=null;}
  function clear(id){const task=timers.get(Number(id));if(task){cancel(task);timers.delete(task.id);}}
  window.setTimeout=(fn,ms,...args)=>schedule('timeout',fn,ms,...args);
  window.setInterval=(fn,ms,...args)=>schedule('interval',fn,ms,...args);
  window.requestAnimationFrame=fn=>schedule('frame',fn);
  window.clearTimeout=window.clearInterval=window.cancelAnimationFrame=clear;
  for(const key of ['AudioContext','webkitAudioContext']){
    const Base=window[key];if(!Base)continue;
    window[key]=class extends Base{constructor(...args){super(...args);audio.set(this,owner??activeOwner());}};
  }
  const play=HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play=function(...args){
    media.set(this,owner??activeOwner());
    if(held){if(!heldMedia.includes(this))heldMedia.push(this);return Promise.resolve();}
    return play.apply(this,args);
  };
  function release(scene){
    if(scene>retiredThrough)retired.add(scene);
    while(retired.delete(retiredThrough+1))retiredThrough++;
    for(const task of timers.values())if(task.owner===scene){cancel(task);timers.delete(task.id);}
    for(const [el,id] of media)if(id===scene){el.pause();media.delete(el);}
    for(const [context,id] of audio)if(id===scene){if(context.state!=='closed')context.close().catch(()=>{});audio.delete(context);}
  }
  function pause(value){
    if(held===value)return;
    held=value;const now=performance.now();
    if(value){
      started=now;
      for(const task of timers.values()){task.remaining=Math.max(0,task.due-now);cancel(task);}
      heldMedia=[...new Set([...media.keys(),...document.querySelectorAll('video,audio')])].filter(el=>!el.paused);
      for(const el of heldMedia)el.pause();
      heldAudio=[...audio.keys()].filter(context=>context.state==='running');
      for(const context of heldAudio)context.suspend().catch(()=>{});
      heldAnimations=document.getAnimations().filter(animation=>animation.playState==='running');
      for(const animation of heldAnimations)animation.pause();
    }else{
      pausedTime+=now-started;
      for(const task of timers.values())arm(task);
      for(const animation of heldAnimations)if(animation.playState==='paused')animation.play();
      for(const context of heldAudio)if(context.state!=='closed')context.resume().catch(()=>{});
      for(const el of heldMedia)play.call(el).catch(()=>{});
      heldAnimations=[];heldAudio=[];heldMedia=[];
    }
  }
  return {owned,release,pause};
}

// New authors can explicitly own async work even after await or fetch returns
// after a scene switch. Existing games can continue to use the iframe clock.
export function sceneTimers(signal,preview,id){
  const pending=new Map();let serial=0;
  function clear(id){const cancel=pending.get(id);if(cancel){pending.delete(id);cancel();}}
  signal.addEventListener('abort',()=>{for(const handle of pending.keys())clear(handle);},{once:true});
  function start(schedule,cancel,repeating,callback,args){
    if(signal.aborted)return 0;
    const token=++serial;
    const fire=(...values)=>{
      if(!repeating)pending.delete(token);
      if(!signal.aborted)callback(...values);
    };
    const arm=()=>schedule.call(window,fire,...args);
    const handle=preview?preview.owned(id,arm):arm();
    pending.set(token,()=>cancel.call(window,handle));return token;
  }
  return {
    setTimeout:(fn,...args)=>start(window.setTimeout,window.clearTimeout,false,fn,args),
    setInterval:(fn,...args)=>start(window.setInterval,window.clearInterval,true,fn,args),
    requestAnimationFrame:fn=>start(window.requestAnimationFrame,window.cancelAnimationFrame,false,fn,[]),
    clearTimeout:clear,clearInterval:clear,cancelAnimationFrame:clear
  };
}
