import {fail} from './schema.mjs';

// The same vocabulary is returned to humans and Agents. Values are stable API keys.
export const MARKET_FILTERS = {
  category:{character:'角色',vehicle:'载具',weapon:'武器',model:'模型',effect:'特效',material:'材质',texture:'贴图',audio:'音频',controller:'控制器',scene:'场景',other:'其他'},
  dimension:{'2d':'2D','3d':'3D',any:'通用'},
  publisher:{official:'官方精选',developer:'开发者上传'},
  role:{humanoid:'人形主角',zombie:'僵尸',monster:'怪物',skeleton:'骷髅',robot:'机器人',vehicle:'载具',weapon:'武器',environment:'环境',other:'其他'},
  genre:{shooter:'射击',action:'动作',adventure:'冒险',platformer:'平台跳跃',racing:'驾驶竞速',survival:'生存',fantasy:'奇幻',scifi:'科幻'},
  style:{'low-poly':'低多边形',toon:'卡通',pixel:'像素',realistic:'写实'},
  capability:{controllable:'可操控',animated:'带动画',rigged:'骨骼绑定',jump:'跳跃',melee:'近战接口',ranged:'射击接口',drive:'驾驶', 'ai-input':'AI 输入'},
  license:{'CC0-1.0':'CC0','CC-BY-4.0':'CC BY 4.0',MIT:'MIT','Apache-2.0':'Apache 2.0'},
};
export const MARKET_SORTS={relevance:'推荐 / 相关度',newest:'最新收录',updated:'最近更新',name:'名称 A–Z',size:'文件体积最小',animations:'动画数量最多'};
const fields={genre:'genres',style:'styles',capability:'capabilities'};
const synonyms=[['射击','枪手','枪械','shooter','shooting','fps','gun'],['动作','action','战斗','combat'],['僵尸','丧尸','zombie','undead'],['怪物','monster','creature'],['骷髅','skeleton'],['载具','车辆','汽车','vehicle','car','driving'],['主角','人形','humanoid','protagonist'],['动画','animated','animation'],['驾驶','竞速','racing'],['机器人','robot'],['武器','weapon'],['骑士','knight'],['法师','mage','wizard']];
const terms=s=>String(s).normalize('NFKC').toLowerCase();
export const marketCatalog=()=>({filters:MARKET_FILTERS,sorts:MARKET_SORTS,query:{q:'Space-separated terms use AND; Chinese and English aliases are supported. Asset ID and author are searchable.',multi_value:'Comma-separated values use OR within a filter; capability uses ALL. Different filters use AND.',pagination:'offset >= 0, limit 1..60; default 24.',copy_policy:'Import a fixed version as an independent game-owned copy.'}});
function values(asset,key){const value=asset[fields[key]??key];return Array.isArray(value)?value:[value].filter(Boolean);}
function haystack(a){return terms([a.id,a.name,a.author,a.publisher_name,a.description,...(a.tags??[]),...(a.features??[]),...Object.keys(MARKET_FILTERS).flatMap(key=>values(a,key).flatMap(v=>[v,MARKET_FILTERS[key][v]??'']))].join(' '));}
export function searchMarket(assets,input={}){
  const query={};
  for(const key of Object.keys(MARKET_FILTERS)){
    if(input[key]===undefined||input[key]==='')continue;
    if(typeof input[key]!=='string')fail(422,`Invalid market filter: ${key}`);
    const requested=[...new Set(input[key].split(',').map(v=>v.trim()))];
    if(requested.some(v=>!Object.hasOwn(MARKET_FILTERS[key],v)))fail(422,`Invalid market filter: ${key}`);
    query[key]=requested;
  }
  if(input.q!==undefined&&(typeof input.q!=='string'||input.q.length>240))fail(422,'Search must be text of at most 240 characters');
  const q=terms(input.q??'').trim(),sort=input.sort||'relevance';if(!Object.hasOwn(MARKET_SORTS,sort))fail(422,'Invalid market sort');
  function integer(key,fallback,min,max){if(input[key]===undefined||input[key]==='')return fallback;const n=Number(input[key]);if(!['string','number'].includes(typeof input[key])||!Number.isSafeInteger(n)||n<min||n>max)fail(422,`Invalid market ${key}`);return n;}
  const offset=integer('offset',0,0,1000000),limit=integer('limit',24,1,60);
  const tokens=q.split(/\s+/).filter(Boolean).map(t=>synonyms.find(group=>group.includes(t))??[t]);
  const candidates=assets.filter(a=>!a.hidden_at).map(a=>({a,text:haystack(a)})).filter(({text})=>tokens.every(group=>group.some(t=>text.includes(t))));
  const match=(a,except)=>Object.entries(query).every(([key,wanted])=>key===except||(key==='capability'?wanted.every(v=>values(a,key).includes(v)):wanted.some(v=>values(a,key).includes(v))));
  const facets=Object.fromEntries(Object.entries(MARKET_FILTERS).map(([key,vocab])=>[key,Object.entries(vocab).map(([value,label])=>({value,label,count:candidates.filter(({a})=>match(a,key)&&values(a,key).includes(value)).length}))]));
  const size=a=>Object.values(a.files??{}).reduce((n,f)=>n+f.size,0),score=({a,text})=>tokens.reduce((s,group)=>s+Math.max(...group.map(t=>terms(a.id)===t?100:terms(a.name).includes(t)?30:terms((a.tags??[]).join(' ')).includes(t)?12:text.includes(t)?1:0)),0)+(a.publisher==='official'?2:0);
  const matched=candidates.filter(({a})=>match(a)).sort((x,y)=>{
    const a=x.a,b=y.a;
    const order=sort==='name'?a.name.localeCompare(b.name,'zh-CN'):sort==='size'?size(a)-size(b):sort==='animations'?(b.animations?.length??0)-(a.animations?.length??0):sort==='newest'?b.created_at-a.created_at:sort==='updated'?b.updated_at-a.updated_at:score(y)-score(x);
    return order||a.id.localeCompare(b.id);
  });
  return {records:matched.slice(offset,offset+limit).map(({a})=>a),total:matched.length,offset,limit,sort,has_more:offset+limit<matched.length,facets};
}
