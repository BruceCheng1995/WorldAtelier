import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clientAddress} from '../services/control-plane/address.mjs';
test('local and explicitly configured origins produce matching client WebSocket addresses',()=>{
 assert.deepEqual(clientAddress(48900),{http:'http://127.0.0.1:48900',websocket:'ws://127.0.0.1:48900'});
 assert.deepEqual(clientAddress(48921,'https://world.example:8443'),{http:'https://world.example:8443',websocket:'wss://world.example:8443'});
 assert.equal(clientAddress(48921,'http://[::1]:48922/').websocket,'ws://[::1]:48922');
});
test('external origin rejects credentials and paths that could leak secrets or misroute joins',()=>{
 for(const value of ['https://user:secret@world.example','https://world.example/atelier','https://world.example/?token=x','https://world.example/#ticket','file:///tmp/example','wss://world.example']) assert.throws(()=>clientAddress(48921,value));
});
