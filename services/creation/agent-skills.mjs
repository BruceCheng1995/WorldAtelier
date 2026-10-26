import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeWorkspaceFile} from './environments.mjs';
import {CREATOR_SKILLS,GAME_ASSET_SKILL} from './agent-skill-catalog.mjs';

const source=fileURLToPath(new URL('../../skills/',import.meta.url));
export {GAME_ASSET_SKILL} from './agent-skill-catalog.mjs';

/** Project only allowlisted packaged skills, never host personal skills or asset bytes.
 * writeWorkspaceFile fences symlink parents and keeps unrelated session files. */
function projectSkill(cwd,skill){
  function visit(directory,prefix=''){
    for(const entry of readdirSync(directory,{withFileTypes:true})){
      if(entry.name==='__pycache__'||entry.name==='.DS_Store'||entry.name.endsWith('.pyc'))continue;
      const relative=prefix+entry.name;
      if(entry.isDirectory())visit(resolve(directory,entry.name),relative+'/');
      else if(entry.isFile())writeWorkspaceFile(cwd,`.agents/skills/${skill.name}/`+relative,readFileSync(resolve(directory,entry.name)));
      else throw Error('Packaged creator skills must contain regular files and directories');
    }
  }
  visit(resolve(source,skill.name));return {...skill,path:resolve(cwd,skill.path)};
}

export const projectCreatorSkills=cwd=>CREATOR_SKILLS.map(skill=>projectSkill(cwd,skill));
// Retain the narrow projection entry for existing callers.
export const projectGameAssetSkill=cwd=>projectSkill(cwd,GAME_ASSET_SKILL);
