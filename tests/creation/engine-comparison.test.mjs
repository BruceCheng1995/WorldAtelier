import test from 'node:test';
import assert from 'node:assert/strict';
import {comparisonLink,readComparison,clearComparison} from '../../apps/creation-workspace/game-catalog.js';
const revision='src-'+'a'.repeat(64);
test('share an immutable comparison without forwarding invitation credentials or unrelated query parameters',()=>{
  const camera={dimension:'3d',position:[1,2,3],target:[0,0,0],view:'perspective'};
  const url=comparisonLink('http://localhost:48910/creation-workspace.html?invite=private&debug=true#/games/game/branches/main',
    {revision,resource:'prefab/a',selected:'实例/节点',camera,godot:true});
  assert.equal(url.searchParams.has('invite'),false);
  assert.equal(url.searchParams.has('debug'),false);
  assert.equal(url.searchParams.get('engine'),'godot');
  assert.deepEqual(readComparison(url.href),{kind:'branch',projectId:'game',branchId:'main',resource:'prefab/a',selected:'实例/节点',camera,valid:true,revision});
  assert.equal(readComparison(clearComparison(url).href),null);
});
test('malformed shared revisions cannot quietly select a moving branch head',()=>{
  const invalid=readComparison('http://test/creation-workspace.html?compareRevision=main#/games/g/branches/main');
  assert.equal(invalid.valid,false);
});
