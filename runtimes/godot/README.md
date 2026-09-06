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
