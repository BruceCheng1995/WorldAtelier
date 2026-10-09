import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {AssetMarket} from '../../services/creation/asset-market.mjs';
import {CreationService} from '../../services/creation/service.mjs';
import {CreationAgentRuns,CREATION_TOOLS} from '../../services/creation/agent-runs.mjs';
import {assetFixturePNG} from './asset-test-fixtures.mjs';

const ids=result=>result.assets.map(asset=>asset.id);
const sorted=values=>[...values].sort();
const filterKeys=['dimension','category','publisher','role','genre','style','license','capability'];
const queryKeys=['q',...filterKeys,'sort','offset','limit'];

function fixture(t){
 const data=mkdtempSync(join(tmpdir(),'atelier-market-search-')),store=new CreationStore(join(data,'creation.sqlite'));
 t.after(()=>{store.close();rmSync(data,{recursive:true,force:true});});
 const service={store,data},market=new AssetMarket({service});service.market=market;
 const png=market.archive.put(assetFixturePNG()),base={description:'Independent search fixture',author:'Independent Creator',dimension:'3d',license:'CC0-1.0',screenshots:['cover.png'],preview:{type:'image',path:'cover.png'},redistribution_confirmed:true};
 const definitions=[
  {id:'search-soldier',name:'Soldier Shooter',category:'character',role:'humanoid',genres:['shooter'],styles:['low-poly'],capabilities:['controllable','ranged'],animations:['idle','run','shoot'],length:150,time:1000},
  {id:'search-zombie',name:'Zombie Scout',category:'character',role:'zombie',genres:['shooter','survival'],styles:['low-poly'],capabilities:['controllable','melee'],animations:['idle','walk'],length:120,time:2000},
  {id:'search-car',name:'Car Racer',category:'vehicle',role:'vehicle',genres:['racing'],styles:['low-poly'],capabilities:['drive','controllable'],animations:[],length:200,time:3000},
  {id:'search-knight',name:'Action Knight',category:'character',role:'humanoid',genres:['action'],styles:['pixel'],capabilities:['controllable','melee'],animations:['idle','run','slash','jump'],length:80,time:4000,dimension:'2d'},
  {id:'search-monster',name:'Monster Creature',category:'character',role:'monster',genres:['action'],styles:['low-poly'],capabilities:['controllable'],animations:['idle'],length:100,time:5000},
  {id:'search-soldier-twin',name:'Soldier Shooter',category:'character',role:'humanoid',genres:['shooter'],styles:['low-poly'],capabilities:['controllable','ranged'],animations:['idle','run','shoot'],length:150,time:1000},
 ];
 const assets=definitions.map(({length,time,...item})=>{const prior=Date.now;Date.now=()=>time;try{return market.installOfficial({...base,...item,files:{'cover.png':png,'metadata.txt':market.archive.put(Buffer.alloc(length,65))}}).asset;}finally{Date.now=prior;}});
 const map=Object.fromEntries(assets.map(asset=>[asset.id,asset]));
 return {data,store,service,market,assets,map,definitions};
}

function facets(result,key){assert.ok(result.facets&&Array.isArray(result.facets[key]),`facets.${key} is an array`);return Object.fromEntries(result.facets[key].map(item=>{assert.equal(typeof item.label,'string');assert.ok(Number.isSafeInteger(item.count)&&item.count>=0);return[item.value,item.count];}));}

test('market combines multiword AND search, bilingual matching and OR/ALL filters',t=>{
 const {market,map}=fixture(t);
 assert.deepEqual(sorted(ids(market.list({q:'soldier shooter'}))),['search-soldier','search-soldier-twin']);
 assert.deepEqual(sorted(ids(market.list({q:'ＳＯＬＤＩＥＲ'}))),['search-soldier','search-soldier-twin'],'fullwidth query normalization');
 assert.equal(market.list({q:'independent creator'}).total,6,'author is discoverable');
 assert.equal(market.list({q:'search-soldier',sort:'relevance'}).assets[0].id,'search-soldier','exact stable ID ranks before prefix match');
 assert.deepEqual(ids(market.list({q:'soldier zombie'})),[],'separate words require all terms');
 assert.deepEqual(ids(market.list({q:'僵尸'})),['search-zombie'],'Chinese alias matches English zombie metadata');
 assert.deepEqual(sorted(ids(market.list({category:'character,vehicle',genre:'shooter,racing',role:'humanoid,vehicle',sort:'name'}))),['search-car','search-soldier','search-soldier-twin']);
 assert.deepEqual(sorted(ids(market.list({capability:'controllable,ranged'}))),['search-soldier','search-soldier-twin'],'all requested capabilities are present');
 assert.deepEqual(ids(market.list({dimension:'2d',category:'character',role:'humanoid',genre:'action',style:'pixel',license:'CC0-1.0',capability:'controllable,melee'})),['search-knight']);
 assert.deepEqual(sorted(ids(market.list({category:'vehicle,vehicle'}))),['search-car'],'duplicate filter values do not duplicate results');
 assert.equal(map['search-car'].role,'vehicle');assert.deepEqual(map['search-soldier'].animations,['idle','run','shoot']);
});

test('market facets remove only their own selected condition',t=>{
 const {market}=fixture(t),result=market.list({category:'character',genre:'shooter',role:'zombie,monster',capability:'controllable'});
 assert.deepEqual(ids(result),['search-zombie']);
 assert.equal(facets(result,'role').humanoid,2,'role facet includes player alternatives matching all other conditions');
 assert.equal(facets(result,'role').zombie,1);
 assert.equal(facets(result,'genre').action,1,'genre facet includes a non-shooter enemy matching other constraints');
 assert.equal(facets(result,'genre').shooter,1);
 assert.equal(facets(result,'capability').melee,1);
 assert.equal(facets(result,'dimension')['3d'],1);
 const withQuery=market.list({q:'zombie',role:'humanoid'});assert.equal(withQuery.total,0);assert.equal(facets(withQuery,'role').zombie,1,'facets retain search terms while relaxing their own filter');
});

test('market sorts deterministically and paginates without losing or duplicating assets',t=>{
 const {market,assets}=fixture(t);
 for(const sort of ['relevance','newest','updated','name','size','animations']){
  const full=market.list({sort,limit:60});assert.equal(full.total,6);assert.equal(full.sort,sort);assert.equal(full.has_more,false);assert.deepEqual(ids(full),ids(market.list({sort,limit:60})));
  const pages=[];for(let offset=0;offset<6;offset+=2){const page=market.list({sort,limit:2,offset});assert.equal(page.total,6);assert.equal(page.offset,offset);assert.equal(page.limit,2);assert.equal(page.has_more,offset+2<6);pages.push(...ids(page));}
  assert.deepEqual(pages,ids(full));assert.equal(new Set(pages).size,6);
 }
 assert.deepEqual(ids(market.list({sort:'name'})),[...assets].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')||a.id.localeCompare(b.id)).map(asset=>asset.id));
 const newest=market.list({sort:'newest'}).assets;assert.equal(newest[0].id,'search-monster');assert.deepEqual(newest.slice(-2).map(asset=>asset.id),['search-soldier','search-soldier-twin']);
 assert.deepEqual(ids(market.list({sort:'size'})),['search-knight','search-monster','search-zombie','search-soldier','search-soldier-twin','search-car']);
 assert.deepEqual(ids(market.list({sort:'animations'})),['search-knight','search-soldier','search-soldier-twin','search-zombie','search-monster','search-car']);
 assert.equal(market.list({offset:100,limit:2}).assets.length,0);assert.equal(market.list({offset:100,limit:2}).has_more,false);
});

test('market updates affect updated order without changing creation order or the fixed older version',t=>{
 const {market,map}=fixture(t),before=map['search-soldier'];
 const prior=Date.now;let after;Date.now=()=>10000;try{after=market.installOfficial({...before,description:'New edition of this fixture'}).asset;}finally{Date.now=prior;}
 assert.equal(after.id,before.id);assert.equal(after.created_at,before.created_at);assert.notEqual(after.version,before.version);assert.equal(market.list({sort:'updated'}).assets[0].id,before.id);assert.equal(market.list({sort:'newest'}).assets[0].id,'search-monster');
 assert.equal(market.detail(before.id,before.version).asset.description,before.description);assert.equal(market.list().total,6);
 const again=market.installOfficial({...after});assert.equal(again.asset.updated_at,after.updated_at,'reinstalling unchanged content does not bump discovery order');
});

test('market rejects malformed query parameters instead of silently broadening discovery',t=>{
 const {market}=fixture(t);
 for(const input of [{limit:0},{limit:61},{limit:1.5},{limit:'no'},{limit:[1]},{limit:true},{offset:[]},{offset:null},{offset:-1},{offset:0.5},{offset:'no'},{sort:'nonsense'},{category:'not-a-category'},{dimension:'4d'},{publisher:'root'},{license:'proprietary'},{capability:'unknown'},{role:['humanoid']},{q:{text:'zombie'}},{q:'x'.repeat(241)}])assert.throws(()=>market.list(input),error=>error.status===422,JSON.stringify(input));
});

test('public HTTP discovery and the Agent read tools share catalog and complete query semantics',async t=>{
 const f=fixture(t),port=Number(process.env.WORLD_ATELIER_MARKET_TEST_PORT??48921),origin=`http://127.0.0.1:${port}`;
 const service=Object.create(CreationService.prototype);Object.assign(service,{origin,market:f.market});
 const server=createServer((req,res)=>service.request(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}}));
 t.after(async()=>{if(server.listening)await new Promise(resolve=>server.close(resolve));});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 const get=async(route,expected=200)=>{const response=await fetch(origin+'/creation-api/'+route);const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value;};
 const catalog=await get('market/catalog');assert.ok(catalog.filters);assert.ok(catalog.sorts);assert.ok(catalog.query);
 const searchTool=CREATION_TOOLS.find(tool=>tool.name==='asset_search');assert.ok(searchTool);for(const key of queryKeys)assert.ok(searchTool.inputSchema.properties[key],`asset_search accepts ${key}`);assert.ok(CREATION_TOOLS.some(tool=>tool.name==='asset_catalog'));
 const user=f.store.register({name:'Search Agent',password:'Independent-test-password'}).user;
 const project=f.store.createProject(user,{name:'Agent search test'},{entry_scene_id:'main',resources:{main:{id:'main',kind:'scene',name:'Main',objects:[]}}});
 const session=f.store.createSession(user,project.project.id,'main',{title:'Catalog planning'});session.executor_thread_id='search-thread';f.store.put('creator_session',session);
 const run={id:'search-run',status:'running',turn_id:'search-turn',lease_generation:1,execution_mode:'plan'};f.store.put('creator_run',run);
 const manager=Object.create(CreationAgentRuns.prototype);Object.assign(manager,{store:f.store,service:f.service,turnBindings:new Map(),runForTurn:(thread,turn)=>thread==='search-thread'&&turn==='search-turn'?run:null,assertCleanupReady:()=>{}});
 const invoke=async(tool,args={})=>{const response=await manager.dynamic({threadId:'search-thread',turnId:'search-turn',scope:{sessionId:session.id,userId:user.id},cwd:f.data,signal:new AbortController().signal,tool,arguments:args,callId:crypto.randomUUID()});assert.equal(response.success,true);return JSON.parse(response.contentItems[0].text);};
 assert.deepEqual(await invoke('asset_catalog'),catalog,'planning Agent can discover supported filters');
 const query={q:'soldier',dimension:'3d',category:'character',publisher:'official',role:'humanoid',genre:'shooter',style:'low-poly',license:'CC0-1.0',capability:'controllable,ranged',sort:'animations',offset:1,limit:1};
 const http=await get('market?'+new URLSearchParams(query));assert.deepEqual(await invoke('asset_search',query),http,'no search/filter/sort/page argument disappears in Agent path');
 const detail=await invoke('asset_detail',{asset_id:f.assets[0].id,version:f.assets[0].version});assert.equal(detail.asset.id,f.assets[0].id);assert.doesNotMatch(JSON.stringify(detail),/data_base64|raw_bytes/);assert.ok(JSON.stringify(http).length<32000,'search remains a compact metadata response');
 await assert.rejects(invoke('asset_import',{asset_id:f.assets[0].id,version:f.assets[0].version,base_revision:project.branch.head,transaction_id:'plan-cannot-write'}),error=>error.status===403);
 await get('market?limit=61',422);await get('market?sort=wrong',422);
 run.status='completed';await assert.rejects(invoke('asset_search',query),error=>error.status===409,'completed Agent lease cannot query through old dynamic tool');run.status='running';
 const revoked=f.store.get('creator_project',project.project.id);revoked.members[user.id]='viewer';f.store.put('creator_project',revoked);await assert.rejects(invoke('asset_catalog'),error=>error.status===403,'revoked editor cannot reuse its previous creator session');
});
