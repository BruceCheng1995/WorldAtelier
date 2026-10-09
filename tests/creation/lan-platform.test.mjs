import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto,randomBytes} from 'node:crypto';
import {networkInterfaces} from 'node:os';
import {workspaceNetwork} from '../../services/preview/network.mjs';
import {randomUUID,sha256Hex} from '../../apps/creation-workspace/client-platform.js';

test('LAN HTTP crypto fallback retains UUID randomness and exact artifact hashes',async()=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'crypto');
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues:array=>webcrypto.getRandomValues(array)}});
  try {
    const ids=Array.from({length:100},()=>randomUUID());assert.equal(new Set(ids).size,100);
    for(const id of ids)assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    for(const bytes of [Buffer.alloc(0),Buffer.from('abc'),Buffer.from('世界工坊'),...[55,56,63,64,65,1000,1048576].map(n=>randomBytes(n))]){
      assert.equal(await sha256Hex(bytes),createHash('sha256').update(bytes).digest('hex'));
    }
  } finally {Object.defineProperty(globalThis,'crypto',original);}
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')),createHash('sha256').update('abc').digest('hex'));
});

test('canonical LAN defaults and Host checks retain rebinding and private test boundaries',()=>{
  const live=workspaceNetwork(48910,{}),isolated=workspaceNetwork(48921,{});
  assert.equal(live.host,'0.0.0.0');assert.equal(live.publicPlay,true);
  assert.equal(isolated.host,'127.0.0.1');assert.equal(isolated.publicPlay,false);
  assert.equal(workspaceNetwork(48910,{WORLD_ATELIER_LAN:'0',WORLD_ATELIER_PUBLIC_PLAY:'0'}).publicPlay,false);
  const request=host=>({headers:{host}});
  assert.equal(live.requestOrigin(request('localhost:48910')),'http://localhost:48910');
  for(const host of ['evil.invalid:48910','localhost:48921','user@localhost:48910','localhost:48910/path','localhost:48910?x=1','localhost:48910#x','localhost:48910\\x'])assert.equal(live.requestOrigin(request(host)),null);
  for(const [name,rows]of Object.entries(networkInterfaces()))if(!/^(utun|tun|tap)/.test(name))for(const row of rows.filter(r=>!r.internal&&r.family==='IPv4')){
    assert.equal(live.requestOrigin(request(`${row.address}:48910`)),`http://${row.address}:48910`);
    assert.equal(isolated.requestOrigin(request(`${row.address}:48921`)),null);
  }
});
