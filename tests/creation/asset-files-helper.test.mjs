/** Runs the packaged Python file helper against private files and a temporary loopback download server. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {assetFixturePNG} from './asset-test-fixtures.mjs';
import {hash} from '../../services/creation/schema.mjs';

const helper=resolve('skills/game-assets/scripts/asset_files.py');
const execute=(args)=>new Promise(resolve=>execFile('python3',args,{encoding:'utf8',timeout:10000,maxBuffer:32768},(error,stdout,stderr)=>resolve({exit:error?.code??0,stdout,stderr})));
const run=async(...args)=>{const result=await execute([helper,...args]);return{...result,value:JSON.parse(result.stdout.trim())};};
const fixture=t=>{const cwd=mkdtempSync(join(tmpdir(),'atelier-asset-helper-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));return cwd;};
const zipScript=`import sys, zipfile, stat\narchive,mode=sys.argv[1:]\nwith zipfile.ZipFile(archive,"w",compression=zipfile.ZIP_STORED) as z:\n if mode=="traversal": z.writestr("../escape.png",b"unsafe")\n elif mode=="symlink":\n  i=zipfile.ZipInfo("linked.png"); i.create_system=3; i.external_attr=(stat.S_IFLNK|0o777)<<16; z.writestr(i,b"../../private")\n elif mode=="duplicate": z.writestr("Asset.png",b"one"); z.writestr("asset.png",b"two")\n elif mode=="conflict": z.writestr("asset",b"file"); z.writestr("asset/child.png",b"child")\n elif mode=="crc": z.writestr("asset.txt",b"CRC_VALIDATION_SENTINEL")\n else: z.writestr("textures/icon.png",b"selected texture bytes"); z.writestr("materials/icon.tres",b"selected material bytes")\n`;

test('asset fetch downloads exact bytes with compact receipt and cannot overwrite an existing file',async t=>{
 const cwd=fixture(t),png=assetFixturePNG(),server=createServer((_request,response)=>{response.writeHead(200,{'content-type':'image/png','content-length':png.length});response.end(png);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const out=join(cwd,'download.png'),url='http://127.0.0.1:'+server.address().port+'/asset';
 const result=await run('fetch','--url',url,'--out',out);assert.equal(result.exit,0);assert.deepEqual(readFileSync(out),png);assert.equal(result.value.sha256,hash(png));assert.equal(result.value.size,png.length);assert.equal(result.stdout.includes(png.toString('base64')),false);
 const again=await run('fetch','--url',url,'--out',out);assert.equal(again.exit,1);assert.deepEqual(readFileSync(out),png);assert.deepEqual(readdirSync(cwd),['download.png']);
});

test('failed HTML, oversize, truncated and HTTP-error downloads leave no output or partial file',async t=>{
 const cwd=fixture(t),png=assetFixturePNG(),server=createServer((request,response)=>{
  if(request.url==='/status'){response.writeHead(404,{'content-type':'text/plain'});response.end('missing');return;}
  if(request.url==='/html'){response.writeHead(200,{'content-type':'text/html'});response.end('<html>login</html>');return;}
  if(request.url==='/disguised'){response.writeHead(200,{'content-type':'application/octet-stream'});response.end('<!doctype html><html>login</html>');return;}
  response.writeHead(200,{'content-type':'image/png','content-length':request.url==='/truncated'?png.length+12:png.length});response.end(png);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 for(const route of ['html','disguised','oversize','truncated','status']){
  const result=await run('fetch','--url','http://127.0.0.1:'+server.address().port+'/'+route,'--out',join(cwd,route+'.png'),'--timeout','2',...(route==='oversize'?['--max-mib','0.000001']:[]));
  assert.equal(result.exit,1,route);assert.equal(existsSync(join(cwd,route+'.png')),false,route);assert.deepEqual(readdirSync(cwd),[],route+' must remove partial files');
  if(route==='status')assert.match(result.value.error,/404/);
 }
});

test('ZIP helper keeps dependencies and rejects traversal, links, collisions, limits and CRC damage without residue',async t=>{
 const cwd=fixture(t);
 for(const mode of ['good','traversal','symlink','duplicate','conflict','crc','limit','count']){
  const archive=join(cwd,mode+'.zip'),out=join(cwd,mode);const created=await execute(['-c',zipScript,archive,mode]);assert.equal(created.exit,0,created.stderr);
  if(mode==='crc'){const bytes=readFileSync(archive),at=bytes.indexOf(Buffer.from('CRC_VALIDATION_SENTINEL'));assert.ok(at>0);bytes[at]^=1;writeFileSync(archive,bytes);}
  const result=await run('unpack','--archive',archive,'--out',out,...(mode==='limit'?['--max-mib','0.000001']:mode==='count'?['--max-files','1']:[]));
  if(mode==='good'){
   assert.equal(result.exit,0);assert.equal(result.value.files,2);assert.equal(readFileSync(join(out,'textures/icon.png'),'utf8'),'selected texture bytes');assert.equal(readFileSync(join(out,'materials/icon.tres'),'utf8'),'selected material bytes');
   const retry=await run('unpack','--archive',archive,'--out',out);assert.equal(retry.exit,1);assert.equal(readFileSync(join(out,'textures/icon.png'),'utf8'),'selected texture bytes');
  }else{assert.equal(result.exit,1,mode);assert.equal(existsSync(out),false,mode+' must not leave an extracted partial directory');}
 }
 assert.equal(existsSync(join(cwd,'escape.png')),false);
});
