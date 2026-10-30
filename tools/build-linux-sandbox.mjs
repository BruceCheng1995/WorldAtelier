import {mkdirSync,readFileSync,renameSync,rmSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';

if(process.platform!=='linux')throw Error('Linux helper 必须在 Linux 内编译；其他主机请使用 Docker 构建。');
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),source=resolve(root,'tools/linux-sandbox.c');
const option=process.argv.slice(2).find(arg=>arg.startsWith('--out='));
const output=resolve(option?option.slice(6):resolve(root,'.local/toolchains/wa-linux-sandbox'));
const hash=createHash('sha256').update(readFileSync(source)).digest('hex'),temporary=output+'.'+randomUUID()+'.tmp';
mkdirSync(dirname(output),{recursive:true});
try{
  const compiled=spawnSync(process.env.CC??'cc',['-O2','-Wall','-Wextra','-Werror',`-DPOLICY_SOURCE_SHA256="${hash}"`,source,'-lseccomp','-o',temporary],{encoding:'utf8'});
  if(compiled.error||compiled.status!==0)throw Error(compiled.error?.message||compiled.stderr||'Linux helper compilation failed');
  renameSync(temporary,output);console.log(JSON.stringify({helper:output,source_sha256:hash}));
}finally{rmSync(temporary,{force:true});}
