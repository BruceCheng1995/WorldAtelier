import {readFileSync,writeFileSync,mkdirSync,readdirSync,copyFileSync} from 'node:fs';
import {resolve,join,extname} from 'node:path';
import {runTest} from '../../services/creation/godot-test-runner.mjs';
const root=resolve(import.meta.dirname,'../..'),work=resolve(root,'.local/asset-market'),project=join(work,'preview-project');
mkdirSync(project,{recursive:true});
for(const meta of JSON.parse(readFileSync(join(work,'package-metadata.json')))){
  const source=join(work,'packages',meta.id),destination=join(project,meta.id);mkdirSync(destination,{recursive:true});
  for(const name of readdirSync(source)){
    const bytes=readFileSync(join(source,name));writeFileSync(join(destination,name),['.gd','.tscn','.tres'].includes(extname(name))?bytes.toString().replaceAll('res://',`res://${meta.id}/`):bytes);
  }
}
writeFileSync(join(project,'project.godot'),'config_version=5\n[application]\nconfig/name="Asset Market Preview"\n[display]\nwindow/size/viewport_width=720\nwindow/size/viewport_height=540\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
copyFileSync(join(root,'tools/asset-market/preview.gd'),join(project,'preview.gd'));
process.exitCode=await runTest({executable:'/Applications/Godot.app/Contents/MacOS/Godot',sessionRoot:work,cwd:work,args:['--headless','--editor','--path',project,'--import','--wa-timeout','60']});
