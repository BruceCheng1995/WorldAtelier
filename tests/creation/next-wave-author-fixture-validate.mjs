// Fixture validity only: actual isolated headless Godot import, no gameplay,
// Web export, browser inputs or new-feature acceptance is inferred.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {CreationService} from '../../services/creation/service.mjs';
import {nextWaveAuthorFiles} from './next-wave-author-fixture.mjs';
import {Evidence,ROOT,ORIGIN} from './next-wave-test-support.mjs';

const evidence=new Evidence('author-fixture-import',{layers:['G'],scope:'Actual Godot 4.6 headless import of independent author fixture only. No gameplay, browser, Web export or acceptance of new features.'});
const data=mkdtempSync(join(tmpdir(),'atelier-next-wave-fixture-')),server=createServer(),prior={agent:process.env.WORLD_ATELIER_DISABLE_AGENT,worlds:process.env.WORLD_ATELIER_DISABLE_WORLDS};let service,completed=false;
try{
  process.env.WORLD_ATELIER_DISABLE_AGENT='1';process.env.WORLD_ATELIER_DISABLE_WORLDS='1';
  service=new CreationService({server,root:ROOT,data,origin:ORIGIN});
  await evidence.check('FIXTURE-GODOT-IMPORT','Real Godot imports all fixture source scenes and scripts',['G'],async receipt=>{
    const files=nextWaveAuthorFiles(),source={};for(const [path,bytes]of files){source[path]=service.native.archive.put(bytes);const out=join(evidence.directory,'author',path);mkdirSync(dirname(out),{recursive:true});writeFileSync(out,bytes);}
    const manifest=await service.native.inspectFiles(source,{assignIds:true});
    assert.equal(manifest.schema,'creation-native-1');assert.equal(manifest.entry_scene_id,'journey-a');
    assert.equal(manifest.resources['journey-a'].kind,'scene');assert.equal(manifest.resources['journey-b'].kind,'scene');assert.equal(manifest.resources['journey-actor'].kind,'prefab');
    assert.deepEqual(service.native.archive.read(manifest.source_files['opaque/author.bin']),files.get('opaque/author.bin'));
    assert.deepEqual(service.native.archive.read(manifest.source_files['opaque/author-notes.txt']),files.get('opaque/author-notes.txt'));
    receipt.source_identity=manifest.source_identity;receipt.resources=Object.values(manifest.resources).map(resource=>({id:resource.id,kind:resource.kind,nodes:resource.native_nodes.length}));
    evidence.json('manifest.json',manifest);
  });completed=true;
}catch(error){evidence.report.errors.push({message:error.message,stack:error.stack,details:error.details});console.error(error.stack);if(error.details)console.error(JSON.stringify(error.details));process.exitCode=1;}
finally{
  for(const [name,value]of [['WORLD_ATELIER_DISABLE_AGENT',prior.agent],['WORLD_ATELIER_DISABLE_WORLDS',prior.worlds]])if(value===undefined)delete process.env[name];else process.env[name]=value;
  await service?.close();server.close();rmSync(data,{recursive:true,force:true});evidence.finish({completed});console.log('NEXT_WAVE_EVIDENCE '+evidence.directory);
}
