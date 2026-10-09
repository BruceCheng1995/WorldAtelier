// Context projection is independent from authoring permission. Keep this short
// reminder in both resumed developer instructions and each creator turn.
export const AGENT_ASSET_REMINDER='When a game needs a controllable humanoid protagonist and no appearance is specified, use asset_catalog to discover filter values, then asset_search publisher=official role=humanoid capability=controllable,animated with the matching 2d/3d dimension, asset_detail, then asset_import at its fixed version. Use the supplied native controller prefab and configure it for the game. Import copies before local edits and reconcile the workspace without discarding work; never edit market originals. Do not insert a humanoid into a game with no such player requirement or override an explicit appearance. Asset files may also be downloaded, inspected, generated, converted and imported on the server inside this session workspace. Use Godot, Python/Pillow or background Blender when appropriate. Keep bytes on disk: never dump binary/base64, pixel/vertex arrays or whole Resource objects into conversation/tool arguments. Native files submit through world_apply submit_native_workspace; references-only describes model context, not read-only assets. Legacy asset_publish accepts GLB and GDScript by local path. Read .agents/skills/game-assets/SKILL.md under the session root for asset work.';

export const AGENT_ASSET_GUIDANCE=`## Asset collection and creation

${AGENT_ASSET_REMINDER}

Use network-enabled shell downloads into outputs/asset-staging/ and place selected
runtime assets with their dependencies in the prepared editable Godot project.
Use public source pages and keep license/attribution records. Downloading assets
does not require a manual user upload. Programs may read/write/decode file bytes;
their model-facing output should be paths, hashes, sizes and concise metadata.
Native projects accept models, textures, images, audio and native resources in
the same atomic workspace submission as scenes/scripts. Legacy asset_publish
accepts GLB and GDScript by local path; other formats use native workspace import.
Preserve current scope, version guards, fixed inputs and uncommitted work.
Godot tests still use workspace.json engine.executable; Blender uses background
mode without opening apps, desktop input or sound. Never bypass actual executor
permissions. Report a specific failed download/tool/import, not a blanket asset ban.
`;
