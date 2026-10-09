import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeSourceArchive} from '../../services/creation/native-source.mjs';
import {createCreationBackup,restoreCreationBackup} from '../../tools/backup-creation.mjs';

test('published market originals and historical versions survive backup and restore',async t=>{
  const parent=resolve('.local/asset-market-backup-test');mkdirSync(parent,{recursive:true});const directory=mkdtempSync(join(parent,'case-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const data=join(directory,'live'),store=new CreationStore(join(data,'creation.sqlite')),archive=new NativeSourceArchive(join(data,'market/objects'));
  const first=archive.put(Buffer.from('first published original')),second=archive.put(Buffer.from('second published original'));
  store.put('market_version',{id:'asset:one',asset_id:'asset',files:{'original.txt':first}});store.put('market_version',{id:'asset:two',asset_id:'asset',files:{'original.txt':second}});store.put('market_asset',{id:'asset',version:'two',files:{'original.txt':second}});
  await createCreationBackup({data,out:join(directory,'backup')});store.close();rmSync(data,{recursive:true,force:true});
  await restoreCreationBackup({from:join(directory,'backup'),out:join(directory,'restored')});
  const restored=new NativeSourceArchive(join(directory,'restored/data/market/objects'));
  assert.equal(restored.read(first).toString(),'first published original');assert.equal(restored.read(second).toString(),'second published original');
  const inventory=JSON.parse(readFileSync(join(directory,'backup/retention.json')));assert.equal(inventory.asset_market.objects.length,2);
});
