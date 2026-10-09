// Independent identity-color and viewport projection tests. No services, accounts,
// browser, network, Godot process, or Agent is used. Persisted UUIDs are FAKE inputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {userColor,previewPeers} from '../../apps/creation-workspace/collaboration-client.js';
const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
const helpers=source.split('// BEGIN WORKSPACE TOPBAR')[1].split('// END WORKSPACE TOPBAR')[0];
const {collaboratorUsers}=await import('data:text/javascript;base64,'+Buffer.from(helpers).toString('base64'));
const uuid=i=>'user-00000000-0000-4000-8000-'+i.toString(16).padStart(12,'0');
const rgb=color=>[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255);
function luminance(color){return rgb(color).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);}
function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}

test('server-persisted UUID supplies the same color across login, branch, window and local metadata changes',()=>{
  const id=uuid(17),base={id,name:'原来的名字',color:'#ff0000'},expected=userColor(base);
  for(const state of [
    {...base,token:'a different login'},
    {...base,project_id:'second-project',branch_id:'night'},
    {...base,peer_id:'a-new-window',name:'已改名字',color:'#0000ff'},
    JSON.parse(JSON.stringify(base)),
    {user_id:id,id:'a-renderer-window-id',name:'Viewport peer'},
  ])assert.equal(userColor(state),expected);
  assert.notEqual(expected,base.color,'server/client legacy color fields do not override identity color v1');
});

test('same display name does not define identity and UUID colors do not repeat a four-entry registration palette',()=>{
  const first={id:uuid(1),name:'林'},second={id:uuid(2),name:'林'};
  assert.notEqual(userColor(first),userColor(second));
  const colors=new Set(Array.from({length:256},(_,i)=>userColor({id:uuid(i),name:'同名'})));
  assert.ok(colors.size>64,'a broad identity palette; no assertion that random users can never collide');
});

test('every sampled UUID returns RGB hex usable by both CSS and Godot within a visible saturated range',()=>{
  for(let i=0;i<4096;i++){
    const color=userColor({id:uuid(i)});assert.match(color,/^#[0-9a-f]{6}$/i);
    const channels=rgb(color),max=Math.max(...channels),min=Math.min(...channels);
    assert.ok(max-min>.12,`${color} has a visible identity hue`);
    assert.ok(luminance(color)>.10&&luminance(color)<.85,`${color} avoids almost-black or almost-white markers`);
  }
});

test('all sampled avatar backgrounds meet small-text contrast against the actual foreground style',()=>{
  const css=readFileSync(new URL('../../apps/creation-workspace/workspace.css',import.meta.url),'utf8');
  const declaration=css.match(/\.atelier-topbar \.collaborator-human,\.atelier-topbar \.account-trigger \.avatar\{([^}]+)\}/)?.[1];
  assert.ok(declaration,'shared topbar identity-color style exists');
  const foreground=declaration.match(/(?:^|;)color:(#[\da-f]{6})/i)?.[1];assert.ok(foreground,'test derives the actual fixed avatar text color');
  for(let i=0;i<4096;i++){
    const id=uuid(i),color=userColor({id}),ratio=contrast(color,foreground);
    assert.ok(ratio>=4.5,`${id} ${color} / ${foreground}: ${ratio.toFixed(3)}:1`);
  }
  assert.ok(contrast(userColor(null),foreground)>=4.5,'missing-identity avatar remains readable');
});

test('multiple windows share one user color, deduplicate only in the topbar and filter only the current viewport',()=>{
  const id=uuid(8),other=uuid(9),peers=[
    {id,peer_id:'self',name:'我',color:'#badbad',camera:{position:[1,2,3],target:[0,0,0]}},
    {id,peer_id:'my-second-window',name:'我',color:'#ffffff',camera:{position:[4,5,6],target:[0,0,0]}},
    {id:other,peer_id:'another-user-window',name:'我',color:'#000000',camera:{position:[7,8,9],target:[0,0,0]}},
  ];
  const people=collaboratorUsers(peers),projected=previewPeers(peers,'self');
  assert.equal(people.length,2);assert.deepEqual(projected.map(p=>p.id),['my-second-window','another-user-window']);
  assert.equal(projected[0].user_id,id);assert.equal(projected[1].user_id,other);
  assert.equal(userColor(people.find(p=>p.user_id===id)),projected[0].color);
  assert.equal(userColor(people.find(p=>p.user_id===other)),projected[1].color);
  assert.equal(projected[0].color,userColor({id}));assert.equal(projected[1].color,userColor({id:other}));
  assert.notEqual(projected[0].color,projected[1].color);
});

test('identity normalization is idempotent before and after replacing renderer ids with peer ids',()=>{
  const peer={id:uuid(31),peer_id:'window',name:'Creator'},once=previewPeers([peer],'self')[0];
  assert.equal(userColor(once),userColor(peer));
  const twice=previewPeers([once],'self')[0];assert.deepEqual(twice,once);
});

test('API and presence inputs stay immutable and returned camera data is a deep copy',()=>{
  const peer=freeze({id:uuid(6),peer_id:'peer',name:'Test',color:'#123456',camera:{position:[1,2,3],target:[4,5,6]}}),peers=freeze([peer]),before=JSON.stringify(peers);
  assert.doesNotThrow(()=>userColor(peer));const projected=previewPeers(peers,'self');
  assert.equal(JSON.stringify(peers),before);projected[0].camera.position[0]=999;
  assert.equal(peer.camera.position[0],1);assert.equal(peer.color,'#123456');
});

test('missing user identity uses one stable fallback independent of spoofed color, name or window',()=>{
  const fallback=userColor(null);assert.match(fallback,/^#[\da-f]{6}$/i);
  for(const input of [undefined,{}, {name:'A'}, {name:'B',color:'#f00000'},{id:''},{id:7},{user_id:'',id:'peer-id'}])assert.equal(userColor(input),fallback);
  const projected=previewPeers([{peer_id:'a',name:'A',color:'#fff000'},{peer_id:'b',name:'B',color:'#000fff'}],'self');
  assert.equal(projected.length,2);assert.equal(projected[0].color,fallback);assert.equal(projected[1].color,fallback);
});
