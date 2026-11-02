// Capture only the authored HUD in this game surface. Copy paint/layout styles
// into an inert image. No author scripts, selectors, form values, URLs or
// nested browsing contexts are serialized into the SVG.
const privateSelector='input,textarea,select,[contenteditable]:not([contenteditable="false"]),iframe,video,audio,object,embed';
const semanticSelector='button,label,output,[role],[data-wa-native-path],h1,h2,h3,h4,p,span';
const svgNs='http://www.w3.org/2000/svg';
const maxNodes=4096;

function visible(element){
  const style=getComputedStyle(element);
  return style.display!=='none'&&style.visibility==='visible'&&style.opacity!=='0'&&element.getClientRects().length>0&&
    (!element.checkVisibility||element.checkVisibility({opacityProperty:true,visibilityProperty:true}));
}
function screenBounds(element,frame){
  const rect=element.getBoundingClientRect(),left=Math.max(frame.left,rect.left),right=Math.min(frame.right,rect.right);
  const top=Math.max(frame.top,rect.top),bottom=Math.min(frame.bottom,rect.bottom);
  if(right<=left||bottom<=top)return null;
  return [(left-frame.left)/frame.width,(top-frame.top)/frame.height,(right-left)/frame.width,(bottom-top)/frame.height];
}
function ownText(element){
  const parts=[];let length=0;
  const visit=node=>{
    if(length>=160)return;
    if(node.nodeType===Node.TEXT_NODE){const value=node.data.slice(0,160-length);parts.push(value);length+=value.length;}
    else if(node.nodeType===Node.ELEMENT_NODE&&!node.matches(privateSelector+',style,script')&&visible(node)){
      for(const child of node.childNodes)visit(child);
    }
  };
  visit(element);
  return parts.join(' ').replace(/\s+/g,' ').trim().slice(0,160);
}
export class HudObservation{
  constructor(ui,generation){this.ui=ui;this.generation=generation;this.ids=new WeakMap();this.serial=0;}
  snapshot(canvas,observations){
    const objects=[],regions=[],frame=canvas.getBoundingClientRect(),bindings=new Map();
    const nodes=this.ui.querySelectorAll(semanticSelector+','+privateSelector);
    for(const el of this.ui.querySelectorAll('[data-wa-native-path]')){
      const path=el.dataset.waNativePath;bindings.set(path,bindings.has(path)?null:el);
    }
    for(const el of nodes){
      if(el.closest(privateSelector)!==null&&!el.matches(privateSelector)||!visible(el))continue;
      const rect=screenBounds(el,frame);if(!rect)continue;
      const masked=el.matches(privateSelector);
      if(masked)regions.push(rect);
      if(objects.length>=128)continue;
      const path=el.dataset.waNativePath;
      const definition=!masked&&bindings.get(path)===el&&observations.definitions.get(path);
      const row=definition?.control_layout?definition:null;
      if(!this.ids.has(el))this.ids.set(el,'hud-'+this.generation+'-'+(++this.serial));
      const type=masked?'PrivateControl':el.getAttribute('role')||el.localName;
      const text=masked?'':ownText(el)||(el.getAttribute('aria-label')??'').slice(0,160);
      if(!text&&!masked&&!row&&!el.matches('button,[role]'))continue;
      objects.push({runtime_id:this.ids.get(el),native_type:'HTML/'+type,name:text||type,visible:true,dimension:'2d',screen_bounds:rect,
        control:{disabled:el.matches(':disabled,[aria-disabled="true"]'),has_focus:document.activeElement===el},
        mapping:row?'exact_source':'runtime_only',source:row?{address:row.address,object_version:row.version}:{}});
    }
    return {objects,text_input_regions:regions.slice(0,64),input_regions_complete:regions.length<=64,truncated:objects.length>=128};
  }
}

function trustedBitmap(el){
  if(el instanceof HTMLImageElement){
    let url;
    try{url=new URL(el.currentSrc);}catch{return null;}
    const build=new URL('.',location.href);
    if(url.origin!==build.origin||new URL('.',url).pathname!==build.pathname||!/^asset-[A-Za-z0-9_-]+\.(png|webp|jpe?g|gif)$/i.test(url.pathname.slice(build.pathname.length))||!el.complete)return null;
  }
  const canvas=document.createElement('canvas');
  canvas.width=el.naturalWidth||el.width;canvas.height=el.naturalHeight||el.height;
  if(!canvas.width||!canvas.height||canvas.width*canvas.height>4096*4096)return null;
  try{canvas.getContext('2d').drawImage(el,0,0);return canvas.toDataURL();}catch{return null;}
}
function paintTree(root){
  let count=0;
  function copyElement(el){
    if(!el.matches||el.matches('style,script,link,template,noscript,meta')||getComputedStyle(el).display==='none')return null;
    if(++count>maxNodes)throw Error('游戏界面超过单帧采集预算');
    const bitmap=el instanceof HTMLImageElement||el instanceof HTMLCanvasElement;
    const masked=el.matches(privateSelector);
    // Never instantiate arbitrary author custom elements. Text/layout and
    // bitmaps are copied from the already rendered isolated game.
    const copy=document.createElement(bitmap?'img':'div');
    const style=getComputedStyle(el);
    for(const property of style){
      const value=style.getPropertyValue(property);
      if(property.startsWith('--')||/url\s*\(|image-set\s*\(|attr\s*\(|var\s*\(/i.test(value)||
         /^(animation|transition|content$|cursor$|caret-|scrollbar-|view-transition)/.test(property))continue;
      copy.style.setProperty(property,value);
    }
    if(masked){
      copy.style.background='#12251b';copy.style.color='transparent';copy.style.textShadow='none';return copy;
    }
    if(bitmap){
      const bytes=trustedBitmap(el);
      if(bytes)copy.setAttribute('src',bytes);
      else copy.style.background='#12251b';
      return copy;
    }
    for(const node of el.childNodes){
      if(node.nodeType===Node.TEXT_NODE)copy.append(document.createTextNode(node.data));
      else if(node.nodeType===Node.ELEMENT_NODE){const child=copyElement(node);if(child)copy.append(child);}
    }
    return copy;
  }
  // Recursion through the same sanitizing copier also handles author buttons
  // whose visible text lives in spans.
  return copyElement(root);
}
export async function compositeFrame(canvas,ui,snapshot){
  if(!snapshot.input_regions_complete)throw Error('界面输入区域不完整，无法采集本帧');
  const image=document.createElement('canvas');
  const scale=Math.min(1,1280/canvas.width,720/canvas.height);
  image.width=Math.max(1,Math.round(canvas.width*scale));image.height=Math.max(1,Math.round(canvas.height*scale));
  const ctx=image.getContext('2d');ctx.drawImage(canvas,0,0,image.width,image.height);
  if(!ui.hidden&&ui.hasChildNodes()){
    const copy=paintTree(ui);
    if(copy){
      const {width,height}=canvas.getBoundingClientRect();
      Object.assign(copy.style,{position:'relative',inset:'auto',margin:'0',width:width+'px',height:height+'px'});
      const svg=document.createElementNS(svgNs,'svg'),foreign=document.createElementNS(svgNs,'foreignObject');
      svg.setAttribute('width',String(image.width));svg.setAttribute('height',String(image.height));svg.setAttribute('viewBox','0 0 '+width+' '+height);
      foreign.setAttribute('width','100%');foreign.setAttribute('height','100%');foreign.append(copy);svg.append(foreign);
      const bitmap=new Image();bitmap.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(svg));
      await bitmap.decode();ctx.drawImage(bitmap,0,0,image.width,image.height);
    }
  }
  ctx.fillStyle='#12251b';
  for(const [x,y,w,h] of snapshot.text_input_regions)ctx.fillRect(Math.floor(x*image.width)-2,Math.floor(y*image.height)-2,Math.ceil(w*image.width)+4,Math.ceil(h*image.height)+4);
  return {width:image.width,height:image.height,data_url:image.toDataURL('image/png'),redacted_input_regions:snapshot.text_input_regions.length};
}
