import {resolve} from 'node:path';

// One packaged catalog for workspace manifests, discovery prompts and health.
// Keep this independent of the workspace writer to avoid an environments cycle.
export const GAME_ASSET_SKILL={name:'game-assets',path:'.agents/skills/game-assets/SKILL.md',description:'Search, download, create and import game assets with compact context; Godot, Pillow and background Blender.'};
export const CREATOR_SKILLS=[
  {name:'game-create',path:'.agents/skills/game-create/SKILL.md',description:'新游戏规划：拆分场景和预制件、确定玩法框架、搜集素材并将详细需求记录到当前任务。'},
  {name:'game-change',path:'.agents/skills/game-change/SKILL.md',description:'游戏需求实施：分析既有内容关联、制定验证方案、开发、维护描述属性和修改记录、验收交付。'},
  GAME_ASSET_SKILL,
];
export const creatorSkillIndex=cwd=>CREATOR_SKILLS.map(skill=>({...skill,path:resolve(cwd,skill.path)}));
export const AGENT_WORKFLOW_REMINDER='For a new game or initial requirements planning, read .agents/skills/game-create/SKILL.md under the session root. For existing-game changes or implementation after planning, read .agents/skills/game-change/SKILL.md. Record requirements and changes in the current task conversation; session outputs may keep a file copy. Shared design knowledge is separate. In plan mode, follow read-only limits. These skills guide authoring, not automatic verification or publication.';
export const AGENT_WORKFLOW_GUIDANCE=`\n## Game workflow skills\n\n${CREATOR_SKILLS.map(skill=>`- ${skill.path}: ${skill.description}`).join('\n')}\n\n${AGENT_WORKFLOW_REMINDER}\n`;
