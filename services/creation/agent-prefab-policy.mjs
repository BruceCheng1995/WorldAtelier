// Shared by thread creation/resume, every turn, and the native workspace guide.
// Authoring guidance only: no automatic test, source-save gate or fixed quota.
export const AGENT_PREFAB_REMINDER = 'For game creation or structural changes, first read the current scene/prefab catalog and design-knowledge-index.json; use knowledge_search/read for relevant architecture decisions. Identify independently editable gameplay concepts and repeated objects before implementation. In native projects, author real reusable PackedScene prefabs with serialized editable children, meaningful exported parameters and actual scene/runtime instances. Do not hide all towers, enemies, obstacles or UI in a monolithic scene or runtime geometry factory. Keep one-off details local and avoid a prefab per primitive. For native projects read WORLD-API.md "Prefab authoring and structure"; for legacy projects follow their existing WORLD-API prefab/version operations without migrating the source schema. Preserve existing behavior, native IDs, instance overrides and uncommitted work; record shared structure decisions through knowledge_write after source is saved. This is an authoring convention, not an automatic verification or publication gate.';

export const AGENT_PREFAB_GUIDANCE = `## Prefab authoring and structure

Before implementing a game or changing its structure, read the current catalog,
the context design-knowledge-index.json and relevant knowledge_search/read entries.
Make a short responsibility map: level composition; reusable actors/objects/UI;
shared configuration; game orchestration. Reuse existing definitions first.

Extract a prefab when an object is repeated, spawned at runtime, has variants,
or needs independent editing/tuning (for example a tower, enemy, obstacle,
projectile, interactable building, reusable effect or HUD). A single important
actor may deserve a prefab even before reuse. Keep level-specific placement,
wave/economy orchestration and small one-off details in their owning scene or
script. Do not create a prefab for every mesh, decorative primitive or helper.
For a small targeted edit, preserve the existing structure unless it blocks the
request; do not turn every change into a whole-project refactor.

In native projects, a prefab is a real .tscn/.scn PackedScene, normally under
prefabs/, with meaningful serialized children that open in the independent
editor. Put its own visuals, collision, animation and local behavior together;
expose useful @export parameters with names, units and descriptions. A script
class, a factory function, an empty root rebuilding everything in _ready, or a
catalog card alone does not provide an editable prefab. Procedural generation
is appropriate for genuinely dynamic content; serialize stable authored parts.

Use inherited/nested PackedScenes or shared Resource configuration for variants;
do not copy the whole tower/enemy implementation per type or per upgrade level.
Record each public definition in .atelier/catalog.json resources with stable id,
kind:"prefab", name, path and design.description. Keep the existing entry scene.
The native source files remain authoritative; never hand-edit native_nodes.
Use actual PackedScene instances in placed scenes and load/preload(...).instantiate()
for runtime spawning. A prefab that gameplay never consumes is unfinished work.

When extracting existing content, preserve behavior and appearance, transforms,
names/NodePaths, signals, groups, collisions, native node/instance IDs and real
per-instance overrides. Keep unknown files/properties and unrelated local edits.
Update callers as part of the same atomic source submission. Inspect the saved
catalog and real references; choose proportionate engine/gameplay checks for the
change and report their actual scope. Do not add an automatic check or approval
gate. Capability-preview scenes are optional supporting material, not a substitute
for the production prefab or a requirement for ordinary edits.

After saving a structural change, use knowledge_write to retain a concise shared
architecture entry: responsibilities, prefab IDs and paths, exposed tuning points,
runtime/scene consumers and any remaining exceptions. Update the existing entry
with its current version. Store project decisions, not private conversation or
volatile test claims. Later turns must verify this knowledge against current
source; never trust an old memory instead of reading the current files.
`;
