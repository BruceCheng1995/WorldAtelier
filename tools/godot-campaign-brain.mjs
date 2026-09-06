// Read-only expedition navigator for actual clients. Feed observed authoritative
// state to step(); dispatch its normal commands through the real client's input
// bridge. This module has no server connection and never mutates supplied state.
class Heap {
  data=[];
  push(v){let i=this.data.length;this.data.push(v);while(i){const p=(i-1)>>1;if(this.data[p].score<=v.score)break;this.data[i]=this.data[p];i=p}this.data[i]=v}
  pop(){const root=this.data[0],v=this.data.pop();if(this.data.length){let i=0;while(i*2+1<this.data.length){let c=i*2+1;if(c+1<this.data.length&&this.data[c+1].score<this.data[c].score)c++;if(this.data[c].score>=v.score)break;this.data[i]=this.data[c];i=c}this.data[i]=v}return root}
}
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const norm=(x,z)=>{const length=Math.hypot(x,z);return length>.00001?{x:x/length,z:z/length}:{x:0,z:0}};
export class CampaignBrain {
  constructor(content,userIds){
    this.content=structuredClone(content);this.users=[...userIds];this.objects=new Map(content.objects.map(o=>[o.id,o]));this.enemies=new Map(content.enemies.map(e=>[e.id,e]));this.phase=0;this.phaseStarted=null;this.paths=new Map();this.pathGoals=new Map();this.pathAt=new Map();this.moves=new Map();this.commands=[];this.lastTick=-1;this.trace=[];
    this.phases=content.objects.filter(o=>o.kind==='crystal'&&o.zone_id==='observatory').map(o=>({kind:'interact',object_id:o.id}));
    this.phases.push({kind:'upgrade',object_id:'forge_hub'},{kind:'interact',object_id:'launch_beacon'},{kind:'clear',zone:'gardens',object_id:'garden_beacon'},{kind:'interact',object_id:'garden_beacon'},{kind:'clear',zone:'foundry',object_id:'foundry_beacon'},{kind:'interact',object_id:'foundry_beacon'},{kind:'upgrade',object_id:'forge_hub'},{kind:'interact',object_id:'supply_hub'},{kind:'clear',zone:'citadel',object_id:'astral_throne'});
    this.solid=new Set();
    for(let x=-80;x<=80;x++)for(let z=-104;z<=35;z++)if(![[0,0],[.2,.2],[-.2,.2],[.2,-.2],[-.2,-.2]].every(([dx,dz])=>this.walkable(x+dx,z+dz)))this.solid.add(`${x},${z}`);
  }
  walkable(x,z){
    let land=this.content.zones.some(zone=>Math.hypot(x-zone.x,z-zone.z)<zone.radius-.5);
    if(!land)for(const object of this.content.objects){if(object.kind!=='bridge')continue;const a=object.rotation||0,dx=x-object.x,dz=z-object.z,lx=dx*Math.cos(a)-dz*Math.sin(a),lz=dx*Math.sin(a)+dz*Math.cos(a);if(Math.abs(lx)<object.length/2&&Math.abs(lz)<object.width/2-.4){land=true;break}}
    return land&&!this.content.objects.some(o=>o.solid&&Math.hypot(x-o.x,z-o.z)<(o.radius??.7)*(o.scale??1)+.3);
  }
  cell(pos){let best=null,dist=Infinity;const x=Math.round(pos.x),z=Math.round(pos.z);for(let dx=-3;dx<=3;dx++)for(let dz=-3;dz<=3;dz++){const p={x:x+dx,z:z+dz};if(this.blocked(p.x,p.z))continue;const d=distance(p,pos);if(d<dist){dist=d;best=p}}return best}
  blocked(x,z){return x < -80||x>80||z < -104||z>35||this.solid.has(`${x},${z}`)}
  path(start,goal){
    const a=this.cell(start),b=this.cell(goal);if(!a||!b)return [];
    const key=p=>`${p.x},${p.z}`,source=key(a),target=key(b),heap=new Heap(),g=new Map([[source,0]]),from=new Map(),closed=new Set();heap.push({...a,key:source,score:distance(a,b)});
    while(heap.data.length){const node=heap.pop();if(closed.has(node.key))continue;if(node.key===target){const result=[b];let cursor=target;while(from.has(cursor)){cursor=from.get(cursor);const [x,z]=cursor.split(',').map(Number);result.push({x,z})}return result.reverse()}closed.add(node.key);
      for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){const x=node.x+dx,z=node.z+dz;if(this.blocked(x,z)||(dx&&dz&&(this.blocked(node.x+dx,node.z)||this.blocked(node.x,node.z+dz))))continue;const next=`${x},${z}`,score=g.get(node.key)+Math.hypot(dx,dz);if(score>=(g.get(next)??Infinity))continue;g.set(next,score);from.set(next,node.key);heap.push({x,z,key:next,score:score+Math.hypot(x-b.x,z-b.z)})}
    }return [];
  }
  navigate(id,pos,goal,tick){
    if(distance(pos,goal)<1.2)return {x:0,z:0};
    if(!this.paths.has(id)||tick-(this.pathAt.get(id)??-100)>30||distance(this.pathGoals.get(id)||{x:Infinity,z:Infinity},goal)>3){this.paths.set(id,this.path(pos,goal));this.pathGoals.set(id,{...goal});this.pathAt.set(id,tick)}
    const path=this.paths.get(id);while(path.length&&distance(path[0],pos)<.38)path.shift();const next=path[0]||goal;return norm(next.x-pos.x,next.z-pos.z);
  }
  send(user_id,action,payload={}){this.commands.push({user_id,action,payload})}
  move(id,direction,time,force=false){const previous=this.moves.get(id);if(force||!previous||distance(direction,previous)>.001||(Math.hypot(direction.x,direction.z)>.001&&time-previous.at>.085)){this.send(id,'move',direction);this.moves.set(id,{...direction,at:time})}}
  done(state,target){
    if(target.kind==='clear')return this.content.enemies.filter(e=>e.zone_id===target.zone).every(e=>(state.enemies[e.id]?.hp??1)<=0);
    if(target.kind==='upgrade')return this.users.every(id=>{const p=state.players[id];return p.upgrades>=8||p.crystals<12+p.upgrades*8});
    const object=this.objects.get(target.object_id);if(object.kind==='crystal')return !!state.objects[object.id]?.collected;if(object.kind==='beacon')return !!state.objects[object.id]?.activated;if(object.kind==='supply')return this.users.every(id=>state.players[id].hp===state.players[id].max_hp);return false;
  }
  step(state){
    this.commands=[];
    if(!state?.players||this.users.some(id=>!state.players[id]?.online))return {waiting:true,commands:[],phase:this.phase,total:this.phases.length};
    if(state.tick===this.lastTick)return {waiting:true,commands:[],phase:this.phase,total:this.phases.length};this.lastTick=state.tick;
    if(this.phaseStarted===null)this.phaseStarted=state.world_time;
    while(this.phase<this.phases.length&&this.done(state,this.phases[this.phase])){this.trace.push({phase:this.phase,target:this.phases[this.phase],tick:state.tick,world_time:state.world_time});this.phase++;this.phaseStarted=state.world_time;this.paths.clear()}
    const complete=this.phase>=this.phases.length;
    if(complete){for(const id of this.users)this.move(id,{x:0,z:0},state.world_time);return {complete:!!state.objectives?.boss_defeated,commands:this.commands,phase:this.phase,total:this.phases.length,trace:this.trace}}
    const target=this.phases[this.phase],object=this.objects.get(target.object_id),rules=state.effective_rules||this.content.rules;
    for(const id of this.users){
      const p=state.players[id];if(p.hp<=0){this.paths.delete(id);continue}let goal={x:object.x,z:object.z},enemyId='',nearest=19;
      for(const [eid,e] of Object.entries(state.enemies)){if(e.hp<=0||(e.kind==='boss'&&state.objectives.beacons<3))continue;const d=distance(p,e);if(d<nearest){nearest=d;enemyId=eid}}
      if(target.kind==='clear'&&!enemyId){nearest=Infinity;for(const [eid,def] of this.enemies){const e=state.enemies[eid];if(def.zone_id!==target.zone||!e||e.hp<=0)continue;const d=distance(p,e);if(d<nearest){nearest=d;enemyId=eid}}}
      if(enemyId){const enemy=state.enemies[enemyId];goal={x:enemy.x,z:enemy.z};const face=norm(enemy.x-p.x,enemy.z-p.z);if(nearest<(rules.attack_range||4.5)&&p.attack_cooldown<=0){this.move(id,face,state.world_time,true);this.send(id,'attack')}if(nearest<=3.8)goal={x:p.x,z:p.z}}
      let direction=this.navigate(id,p,goal,state.tick);
      for(const enemy of Object.values(state.enemies)){if(enemy.hp<=0||enemy.telegraph<=0)continue;let origin=enemy,radius=3.4;if(enemy.kind==='artillerist'){origin={x:enemy.target_x??enemy.x,z:enemy.target_z??enemy.z};radius=3.2}if(enemy.kind==='brute')radius=4.5;if(enemy.kind==='boss')radius=enemy.phase===1?8:11;if(distance(p,origin)<radius+1.5){let away=norm(p.x-origin.x,p.z-origin.z);if(!away.x&&!away.z)away={x:1,z:0};if(enemy.telegraph<.20&&p.dash_cooldown<=0&&p.stamina>=28){this.move(id,away,state.world_time,true);this.send(id,'dash')}else if(enemy.telegraph>.22)direction=away;break}}
      this.move(id,direction,state.world_time);
      if(distance(p,object)<5.4){if(target.kind==='interact')this.send(id,'interact',{object_id:object.id});if(target.kind==='upgrade')this.send(id,'upgrade')}
    }
    return {commands:this.commands,phase:this.phase,total:this.phases.length,target,stalled:state.world_time-this.phaseStarted>240,trace:this.trace};
  }
}
