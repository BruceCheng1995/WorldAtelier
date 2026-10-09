import test from 'node:test';import assert from 'node:assert/strict';
import {CreationAgentRuns} from '../../services/creation/agent-runs.mjs';
// Production projection function with explicit store/transport doubles. These
// ensure the cheap idle path still retires prior visible Agent selections.
test('idle Agent projection broadcasts an empty state without reading native source',()=>{
 const broadcasts=[],agent=Object.create(CreationAgentRuns.prototype);
 Object.assign(agent,{store:{list:kind=>{assert.equal(kind,'creator_run');return [{id:'finished',project_id:'p',branch_id:'b',status:'completed',created_at:1,targets:[{resource_id:'s'}]}];},get(){throw Error('idle projection must not read source');},readRevision(){throw Error('idle projection must not read source');}},service:{realtime:{development:(p,b,states)=>broadcasts.push({p,b,states})}}});
 assert.deepEqual(agent.projectDevelopment('p','b'),[]);assert.deepEqual(broadcasts,[{p:'p',b:'b',states:[]}]);
});
