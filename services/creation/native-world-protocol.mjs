import {fail,hash} from './schema.mjs';

export const NATIVE_WORLD_PROTOCOL='wa-native-world-state-1';
export const NATIVE_SHARED_PURPOSE='native_shared';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;

// A world publication version excludes ticking state. A caller can compare the
// room it intends to update without taking a lock for the entire build queue.
export function nativeWorldVersion(world){
  return world?hash({world_id:world.id,epoch:world.epoch,revision:world.revision,runtime_build_id:world.runtime_build_id}):null;
}

function finiteJson(value,depth=0){
  if(depth>12)fail(400,'玩法输入嵌套过深');
  if(value===null||typeof value==='boolean')return;
  if(typeof value==='number'){if(!Number.isFinite(value)||Math.abs(value)>1e12)fail(400,'玩法输入数字无效');return;}
  if(typeof value==='string'){if(value.length>4096||value.includes('\0'))fail(400,'玩法输入文本过长或无效');return;}
  if(Array.isArray(value)){if(value.length>256)fail(400,'玩法输入列表过长');for(const item of value)finiteJson(item,depth+1);return;}
  if(!plain(value)||Object.keys(value).length>64)fail(400,'玩法输入对象无效');
  for(const [key,item]of Object.entries(value)){
    if(['__proto__','constructor','prototype'].includes(key)||key.length>128)fail(400,'玩法输入字段无效');
    finiteJson(item,depth+1);
  }
}

export function validateNativeInput(packet,world,client){
  if(!plain(packet)||!client.world_active||client.world_key!==world.key)fail(409,'客户端尚未应用当前共享世界基线');
  for(const [field,value]of Object.entries({world_id:world.id,epoch:world.epoch,scene_revision:world.revision,resource_id:world.snapshot.resource_id,scene_generation:world.snapshot.scene_generation,control_generation:client.control_generation})){
    if(packet[field]!==value)fail(409,'玩法输入的世界版本或控制权已过期',{field});
  }
  if(packet.player_id!==undefined&&packet.player_id!==client.user.id)fail(403,'不能代替其他玩家提交输入');
  if(!Number.isSafeInteger(packet.input_seq)||packet.input_seq<1||packet.input_seq<=(client.last_input_seq??0))fail(409,'玩法输入序号已过期');
  if(!Array.isArray(packet.inputs)||packet.inputs.length>32)fail(400,'每次玩法输入最多包含 32 个动作');
  for(const input of packet.inputs){
    if(!plain(input)||Object.keys(input).some(key=>!['target_key','action','payload'].includes(key))||typeof input.target_key!=='string'||input.target_key.length>4096||typeof input.action!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(input.action))fail(400,'玩法动作格式无效');
    let target;try{target=JSON.parse(input.target_key);}catch{fail(400,'玩法目标地址无效');}
    if(!Array.isArray(target)||target.length!==2||!Array.isArray(target[0])||target[0].length>32||target[0].some(id=>typeof id!=='string'||!id||id.length>160)||typeof target[1]!=='string'||!target[1]||target[1].length>160)fail(400,'玩法目标需要完整原生实例地址');
    finiteJson(input.payload??null);
  }
  if(Buffer.byteLength(JSON.stringify(packet.inputs))>16384)fail(413,'玩法输入超过大小限制');
  return {world_id:world.id,epoch:world.epoch,scene_revision:world.revision,resource_id:world.snapshot.resource_id,scene_generation:world.snapshot.scene_generation,player_id:client.user.id,input_seq:packet.input_seq,inputs:structuredClone(packet.inputs)};
}

export function validateNativeReady(packet,world,client){
  const barrier=client.world_barrier;
  if(!plain(packet)||!barrier||client.world_key!==world.key)fail(409,'没有待确认的共享世界基线');
  for(const [field,value]of Object.entries({world_id:world.id,epoch:world.epoch,scene_revision:world.revision,resource_id:world.snapshot.resource_id,scene_generation:world.snapshot.scene_generation,control_generation:client.control_generation,sequence:barrier.sequence,state_hash:barrier.state_hash,...(world.source_identity?{source_identity:world.source_identity}:{})}))if(packet[field]!==value)fail(409,'客户端确认与固定世界基线不一致',{field});
  return true;
}

export function validateNativeSnapshot(snapshot,world,{allowNewRevision=false}={}){
  if(!plain(snapshot)||snapshot.schema!==NATIVE_WORLD_PROTOCOL||snapshot.world_id!==world.id||snapshot.epoch!==world.epoch||!allowNewRevision&&snapshot.scene_revision!==world.revision||!allowNewRevision&&world.source_identity&&snapshot.source_identity!==world.source_identity||typeof snapshot.resource_id!=='string'||!snapshot.resource_id||!Number.isSafeInteger(snapshot.scene_generation)||snapshot.scene_generation<1||!Number.isSafeInteger(snapshot.sequence)||snapshot.sequence<0||!Number.isSafeInteger(snapshot.tick)||snapshot.tick<0||!plain(snapshot.players)||!plain(snapshot.nodes)||!plain(snapshot.spawns)||!Array.isArray(snapshot.removed))fail(502,'原生权威快照的身份或状态结构无效');
  if(Object.keys(snapshot.nodes).length>20000||Object.keys(snapshot.spawns).length>5000||snapshot.removed.length>20000||Buffer.byteLength(JSON.stringify(snapshot))>8*1024*1024)fail(502,'原生权威快照超过当前传输范围');
  return snapshot;
}
