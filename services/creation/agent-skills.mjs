import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeWorkspaceFile} from './environments.mjs';

const source=fileURLToPath(new URL('../../skills/game-assets/',import.meta.url));
export const GAME_ASSET_SKILL={name:'game-assets',path:'.agents/skills/game-assets/SKILL.md',description:'Search, download, create and import game assets with compact context; Godot, Pillow and background Blender.'};

/** Project only the packaged skill, never host personal skills or asset bytes.
 * writeWorkspaceFile fences symlink parents and keeps unrelated session files. */
export function projectGameAssetSkill(cwd){
  function visit(directory,prefix=''){
    for(const entry of readdirSync(directory,{withFileTypes:true})){
      if(entry.name==='__pycache__'||entry.name==='.DS_Store'||entry.name.endsWith('.pyc'))continue;
      const relative=prefix+entry.name;
      if(entry.isDirectory())visit(resolve(directory,entry.name),relative+'/');
      else if(entry.isFile())writeWorkspaceFile(cwd,'.agents/skills/game-assets/'+relative,readFileSync(resolve(directory,entry.name)));
      else throw Error('Packaged creator skills must contain regular files and directories');
    }
  }
  visit(source);return {...GAME_ASSET_SKILL,path:resolve(cwd,GAME_ASSET_SKILL.path)};
}
