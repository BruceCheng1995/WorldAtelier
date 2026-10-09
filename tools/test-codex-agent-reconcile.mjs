/** Read-only real reconciliation probe; never starts or retries a turn. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {CodexAgent} from '../services/creation/codex-agent.mjs';
if(!process.argv[2])throw new Error('Pass the live-test evidence directory');
const directory=path.resolve(process.argv[2]);
const binding=JSON.parse(await readFile(path.join(directory,'thread.json'),'utf8'));
const events=(await readFile(path.join(directory,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const submission=events.filter(e=>e.kind==='submission').at(-1);
const agent=new CodexAgent({workspaceRoot:directory});
try{
  await agent.start();
  const restored=await agent.resumeThread({...binding,expectedClientUserMessageId:submission.clientUserMessageId});
  assert.equal(restored.reconciliation.canSend,true);assert.ok(restored.reconciliation.matchedTurnId);
  const unknown=await agent.resumeThread({...binding,expectedClientUserMessageId:'unsubmitted-reconciliation-probe'});
  assert.equal(unknown.reconciliation.missingExpectedTurn,true);assert.equal(unknown.reconciliation.canSend,false);
  const report={outcome:'passed',threadId:binding.threadId,matchingClientMessageId:submission.clientUserMessageId,matchedTurnId:restored.reconciliation.matchedTurnId,knownTerminalCanSend:true,absentMessageRemainsFenced:true,noTurnsStarted:true};
  await writeFile(path.join(directory,'reconcile-report.json'),JSON.stringify(report,null,2));
  console.log('CODEX_RECONCILE_PASSED',JSON.stringify(report));
}finally{await agent.stop();}
