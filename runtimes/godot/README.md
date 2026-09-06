# Starfall Expedition runtime

One Godot 4.6 project executes authoritative gameplay, Web/native rendering and isolated offline play. The four connected islands contain 227 authored objects, 46 enemies across five kinds including Asterion, three expedition objectives, shared crystals/beacons, persistent per-player upgrades/rewards, attacks, dodge invulnerability, telegraphed enemy attacks, death recovery and multiplayer avatars.

```sh
# Shared content validation: schema, real GLB import, world initialization + physics.
Godot --headless --path runtimes/godot -- --role=validate --content=/absolute/world.json
# Offline content + independent state domain (save path is never uploaded automatically).
Godot --path runtimes/godot -- --role=offline --content=/absolute/world.json --save=/absolute/offline-state.json --offline-user=USER_ID
# Authority is normally started from the immutable release package by central service.
Godot --headless --path runtimes/godot -- --role=authority --server=ws://127.0.0.1:48900 --world=WORLD --host-key=KEY
# Real rendered client receives a short-lived ticket from central prepare-join.
Godot --path runtimes/godot -- --role=client --server=ws://127.0.0.1:48900 --ticket=TICKET
# Deterministic domain checks; independent central/browser E2E lives in tests/.
Godot --headless --path runtimes/godot --script ../../tools/godot-state-tests.gd
```

Controls: WASD/arrows move relative to the camera; Space/right mouse strikes; Shift dashes; E interacts with the closest object; Q upgrades near a forge; left mouse selects; Tab expands the world map; wheel zooms; F toggles fullscreen. Compatible updates preserve state and use new candidate instances. Rejected model assets retain the preceding view and stop commands until the central version gate is resolved.

`tools/godot-content.py` reproduces canonical `content/world.json` and the default content embedded in the export. `tools/godot-explorer-asset.py` uses Blender to produce the original weighted explorer GLB and source `.blend` (16 bones, Idle/Walk/Strike/Dash, hand-attached staff and articulated cape). `tools/godot-audio.py` synthesizes the original soundtrack and feedback sounds. No third-party character or audio assets are included.

Scene models can reference `objects[].model_asset` hashes supplied as inline immutable `asset_blobs`. Godot verifies SHA256 and rejects external URI dependencies, then imports into fresh GLTFState/PackedScene instances. Collider `solid/radius/scale` changes are part of the same candidate migration; a newly invalid player location migrates to the verified safe spawn. Arbitrary remote code is not accepted by this model path.

Optional local evidence options: `--capture=/absolute/frame.png --capture-after=2 --quit-after-seconds=3`; `--input-script=/absolute/actions.json` executes timed **normal commands**, with `{at,action,payload,duration?}`, never direct state mutation. `--telemetry-file` writes observed state metadata. These tools assist reproducible tests and are not proof of gameplay or collaboration by themselves.

Export presets are **Web** and **macOS**. Official native templates can be installed by `tools/godot-install-templates.py`; builds must be checked in exported release binaries, not inferred from editor success.

`tools/godot-campaign-brain.mjs` exports `CampaignBrain(content, userIds)`. Feed an observed authoritative snapshot into `step(state)` and dispatch the returned `{user_id, action, payload}` commands through each real client's normal input bridge. The navigator follows 29 campaign phases using a collider-aware path grid and enemy telegraph avoidance. It does not connect to services, acknowledge client readiness, or alter the supplied state. A completed domain simulation does not establish that a browser or network campaign passed.

`node tools/godot-host-probe.mjs` starts a real Godot authority against an isolated local protocol fixture and checks ready-state receipt, collection, a large GLB update, the immutable freeze checkpoint, rejected frozen mutations and orphan-process shutdown. Pass `--native=/absolute/Starfall Expedition.app/Contents/MacOS/Starfall Expedition` to exercise an exported release binary. This is a runtime protocol probe; central-service/browser E2E remains separate.

Runtime identity is exposed as `runtime_version` in client telemetry and authority readiness. A whole-runtime upgrade freezes simulation at a final checkpoint; the old client disables control and reports the update target until a compatible new client enters. Compatible content updates use candidate-isolated state and resources. Cooperative behavior modules have a restricted rule API and explicit fallback/error reporting; they are not a security sandbox for hostile scripts.

Runtime 0.1.1 locks each enemy windup's center and hurt radius at warning creation. The same area is persisted in authority state, broadcast to renderers and used at impact; moving the target does not shift an artillery warning. `Godot --path runtimes/godot --script ../../tools/godot-telegraph-tests.gd -- --render --report-dir=/absolute/evidence` builds six isolated real Node3D fixtures, captures native frames and checks actual TorusMesh boundaries against damage at radius ±0.05 m. Fixture positions and boss phase are deliberately seeded; this check is separate from normal-input campaign evidence.

The [independent prefab inventory](tests/PREFAB-INVENTORY.md) covers 227 authored objects, one supported unplaced platform, 46 authored enemies and 16 systems as 290 real generated scenes. It documents scene generation, developer verification, standalone input controls, native image capture and the limits of isolated fixture evidence. `tools/godot-blender-pipeline.py` freshly authors the original Sunforge Relay prop from an empty Blender scene and records source/export hashes and statistics under `assets/source/live_pipeline/` for upload through the central asset workflow.

Runtime 0.1.2 gates attack retries on the previous request's acknowledgement and consumed snapshot, with a bounded timeout/backoff. Holding Space continues attacking without emitting a request every rendered frame while a 10 Hz cooldown snapshot is stale. `node tools/godot-input-probe.mjs` connects a real native Godot client to a real authority through an isolated coordinator, injects normal engine keyboard events, delays snapshots by 80 ms and records actual outbound requests/acknowledgements plus a rendered frame. This is software-injected native input evidence; actual browser keyboard and central-service checks remain separate.
