// Actual child-process output tests; the marker is a test string, never a
// fabricated Godot/client acknowledgment or a gameplay acceptance claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {CreationBuilds} from '../../services/creation/export-builds.mjs';
const root=resolve('.local/creation-verification/build-output-boundary');mkdirSync(root,{recursive:true});
function runner(){const directory=mkdtempSync(join(root,'case-'));mkdirSync(join(directory,'job'));return {directory,closing:false,executionUser(){},verifyToolchain(){},cleanError:v=>v};}
const marker='EXPECTED_OUTPUT_MARKER';
test('observed output marker survives bounded diagnostic truncation and chunk boundaries',async()=>{
 const runnerObject=runner();const output=await CreationBuilds.prototype.command.call(runnerObject,{id:'job'},process.execPath,['-e',`process.stdout.write('EXPECTED_');setTimeout(()=>process.stdout.write('OUTPUT_MARKER\\n'+'x'.repeat(80000)),30)`],root,{requiredMarker:marker});
 assert.equal(output.length,32000);assert.equal(output.includes(marker),false);
});
test('exit success without the required marker remains a failure',async()=>{
 await assert.rejects(CreationBuilds.prototype.command.call(runner(),{id:'job'},process.execPath,['-e',`process.stdout.write('x'.repeat(80000))`],root,{requiredMarker:marker}),/未确认固定场景/);
});
test('an early process error cannot disappear behind a large successful-looking output tail',async()=>{
 await assert.rejects(CreationBuilds.prototype.command.call(runner(),{id:'job'},process.execPath,['-e',`process.stdout.write('ERROR: explicit test failure\\n${marker}\\n'+'x'.repeat(80000))`],root,{requiredMarker:marker}));
});
