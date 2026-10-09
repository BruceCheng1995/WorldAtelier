import test from 'node:test';
import assert from 'node:assert/strict';
import {CreationClient} from '../../apps/creation-workspace/collaboration-client.js';

// Real client with a fake browser transport; no service or live user state.
test('branch roster rejects stale generation, other branches/projects and obsolete sockets',t=>{
  class Socket {static OPEN=1;readyState=1;send(){}close(){this.readyState=3;}}
  for(const [key,value] of Object.entries({sessionStorage:{getItem:()=> 'test-token'},location:{protocol:'http:',host:'test.invalid'},WebSocket:Socket})){
    const prior=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
    t.after(()=>prior?Object.defineProperty(globalThis,key,prior):delete globalThis[key]);
  }
  const client=new CreationClient(),seen=[];t.after(()=>client.disconnect());
  client.addEventListener('packet',event=>seen.push(event.detail));
  client.subscribe({project_id:'p',branch_id:'main',resource_id:'scene-a'});client.connect();
  const ws=client.ws,packet=extra=>({type:'branch_presence',project_id:'p',branch_id:'main',resource_id:'scene-a',generation:client.generation,peers:[{id:'other-scene-user',name:'Peer'}],...extra});
  const deliver=value=>ws.onmessage({data:JSON.stringify(value)});
  for(const extra of [{project_id:'other'},{branch_id:'other'},{resource_id:'old-scene'},{generation:0}])deliver(packet(extra));
  assert.equal(seen.length,0);deliver(packet());assert.equal(seen.length,1);
  const old=packet();client.subscribe({project_id:'p',branch_id:'main',resource_id:'scene-b'});deliver(old);assert.equal(seen.length,1);
  deliver(packet({resource_id:'scene-b'}));assert.equal(seen.length,2);
  client.unsubscribe();deliver(packet({resource_id:'scene-b'}));assert.equal(seen.length,2);
  client.disconnect();deliver(packet());assert.equal(seen.length,2);
});
