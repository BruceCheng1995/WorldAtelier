/** Stage verified original packages in the server's immutable object archive.
 * Registration uses the same market store without restarting the service.
 * No game source, login, active run, build or publication is modified here. */
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {NativeSourceArchive} from '../../services/creation/native-source.mjs';
import {CreationStore} from '../../services/creation/store.mjs';
import {AssetMarket} from '../../services/creation/asset-market.mjs';
const root=resolve(import.meta.dirname,'../..'),work=resolve(root,'.local/asset-market');
const data=resolve(process.argv[2]??join(root,'.local/model-preview/creation'));
const archive=new NativeSourceArchive(join(data,'market/objects'));
const entries=JSON.parse(readFileSync(join(work,'package-metadata.json'))).map(meta=>({...meta,files:archive.capture(join(work,'packages',meta.id))}));
for(const entry of entries)if(!entry.files[entry.screenshots[0]])throw Error('Missing verified screenshot for '+entry.id);
mkdirSync(join(data,'market'),{recursive:true});const path=join(data,'market/official-install.json');writeFileSync(path+'.tmp',JSON.stringify(entries,null,2)+'\n');renameSync(path+'.tmp',path);
const store=new CreationStore(join(data,'creation.sqlite'));
try{new AssetMarket({service:{data,store}}).loadOfficial();}finally{store.close();}
console.log(JSON.stringify({packages:entries.length,files:entries.reduce((n,e)=>n+Object.keys(e.files).length,0),bytes:entries.reduce((n,e)=>n+Object.values(e.files).reduce((s,f)=>s+f.size,0),0),manifest:path}));
