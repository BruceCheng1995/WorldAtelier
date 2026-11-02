import {build,version} from 'esbuild';
import {resolve} from 'node:path';
import {hash} from '../creation/schema.mjs';
import {createFileIdentityCache} from '../creation/file-identity.mjs';

const identify=createFileIdentityCache();
const inputs=[
  'apps/creation-workspace/three-editor.html','apps/creation-workspace/three-editor-runtime.js',
  'apps/creation-workspace/three-editor-preview.js','apps/creation-workspace/three-editor-scene.js','apps/creation-workspace/three-editor-prefab.js',
  'apps/creation-workspace/three-editor-canvas.js','apps/creation-workspace/three-control-layout.js','apps/creation-workspace/three-editor-overlays.js','apps/creation-workspace/three-editor-outline-mask.js','apps/creation-workspace/three-source-scene.js','apps/creation-workspace/three-native-materials.js','apps/creation-workspace/three-gles-direct.js','apps/creation-workspace/three-native-post.js',
  'apps/creation-workspace/client-platform.js','apps/creation-workspace/preview-bridge.js',
  'services/creation/three-scene-projection.mjs','services/creation/three-native-visuals.mjs','tools/native-scene/three_surfaces.gd',
  'services/creation/native-project-settings.mjs','package-lock.json'
];
export function threeEditorIdentity(root){
  return hash([version,...inputs.map(file=>identify(resolve(root,file)))]);
}
let cached;
export function threeEditorBundle(root){
  const key=threeEditorIdentity(root);
  if(cached?.key!==key){
    // All viewports share the compilation. Edits invalidate the bundle on a
    // refresh, as they do for the existing workspace's unbundled UI modules.
    const promise=build({entryPoints:[resolve(root,'apps/creation-workspace/three-editor-runtime.js')],
      bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',minify:true,logLevel:'silent'})
      .then(result=>result.outputFiles[0].contents)
      .catch(error=>{if(cached?.key===key)cached=null;throw error;});
    cached={key,promise};
  }
  return cached;
}
