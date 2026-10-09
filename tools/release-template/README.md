# Independent release runtime

The release assembler copies these files to the root of an isolated copy of
`runtimes/model-preview/`, sets `run/main_scene="res://standalone.tscn"`, and writes
`release.json`. No current workbench runtime files are replaced.

`release.json` includes `project_name`, `project_id`, `branch_id`, immutable
`revision`, `entry_scene_id`, `scenes` (resource ID to full runtime scene document),
and `assets` (original immutable `/preview-assets/...` URL to a file under
`res://bundled/`). Keep each scene's original `model_url`, `model_hash`,
`script_url`, `script_hash`, hierarchy pack and scene revision unchanged.
The complete creator manifest, including uninstantiated prefab definitions,
is separately included as `source-manifest.json` by the assembler.

Keep bundled assets as raw files, for example `<hash>.glb.bin` and `<hash>.gd.txt`,
so Godot's import/export remapping cannot remove the original bytes. Include
`release.json`, `source-manifest.json`, and `bundled/*` in every export preset.
The loader checks size and SHA-256 before the existing GLB/behavior loaders run.
It never falls back to HTTP for missing content.

The startup scene runs the existing `WorldSimulation`, `WorldProjection`,
hierarchy assembler, collision and behavior registry locally. It does not join
a default player, install gameplay InputMap actions, provide movement/jump/
interaction buttons, or run a follow-camera controller. Characters, gameplay
input and cameras belong to explicitly authored scene behaviors. A static
fallback camera remains for scenes without their own camera; free-camera input
is confined to paused inspection. All declared scenes can be selected in the
game, and restarting or selecting a scene begins from its initial state.

For verification, `STANDALONE_READY {json}` is logged only after assets, authority
behaviors and presentation have been created. `telemetry()` reads current
simulation data, without a synthetic local-player record. Web builds publish
that same read-only observation as `window.worldAtelierRelease` every 250 ms.
`ready`, `tick`, `revision`, `scene_revision`, `object_states` and
`rendered_players` are observations of this running instance, not server ACKs.
Loading failures set `ready:false`; gameplay faults retain the scene for readonly
inspection and require an explicit restart.
