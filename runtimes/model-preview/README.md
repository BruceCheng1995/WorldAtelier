# World Atelier Godot model preview

A dedicated **Godot 4.6 Web** renderer for the creation workbench's main scene and object preview, with a separate headless Godot authority for shared Play. The main view switches between document editing, authoritative player projection, and personal inspection; the object view remains a noneditable model preview. It does not load or modify the Starfall runtime. Central persistence, permissions, collaborative transactions and publication belong to the host service; this runtime does not implement those services itself.

Build: `node tools/build-model-preview.mjs`. Default output is `.local/model-preview/build/`; `--out=/absolute/path` selects isolated output. The build runs real Godot import, headless startup and release Web export, scans engine errors, then inventories output hashes in `manifest.json`. Single-threaded GL Compatibility, no COOP/COEP requirement, no GLBs embedded in PCK. The HTTP service maps `/preview-runtime/` to this directory and `/preview-assets/*.glb` to immutable model assets.

## Bridge

Both frames use `/preview-runtime/index.html?mode=main|object&nonce=SESSION_NONCE`. The host checks the actual event `source === window.parent`, same `origin`, message `source`, and nonce. Parent should independently check the originating iframe, origin and nonce. Callback references are kept alive. The current bridge is protocol 1, runtime version `0.2.0`.

Parent scene message:

```js
{
  source: 'world-atelier-workspace', nonce, type: 'scene', seq: 1,
  document_id: 'scene-main', selected_id: 'object-1', frame: true, editable: true,
  objects: [{
    id: 'object-1', name: 'Beacon',
    model_url: '/preview-assets/beacon.glb?v=HASH', model_hash: 'SHA256',
    position: [0, 0, 0], rotation: [0, 30, 0], scale: [1, 1, 1]
  }]
}
```

`rotation` is Godot Euler **degrees**, YXZ rotation order; `position` is full XYZ in meters. `scale` accepts a scalar or XYZ array in 0.1–5, default 1. Position components must be in −1000–1000 m; rotation components in −36000–36000 degrees. Nonuniform XYZ scale is preserved. Each object is root-level: transforms are document-local, which is world space in this host. `kind:'anchor'` creates a selectable editor cross without requiring a model. `model_url` may be absolute at the iframe origin or start `/preview-assets/`; basename is ASCII alphanumeric/underscore/hyphen plus `.glb`, optional version query. Other origins/paths, external GLB dependencies, invalid hashes or nonfinite transforms are rejected. `model_hash` is optional; supplied hashes are verified against downloaded bytes, and telemetry always reports the actual hash.

Scene `seq` is a monotonically increasing nonnegative integer **per iframe lifetime**, including when switching documents. Older/equal scene packets are ignored. A newer request supersedes every previous in-flight load, including if the newer request is rejected. Invalid candidates retain the entire previous scene. Each scene is installed only after all model downloads/actual GLTF parsing/scene creation succeed. URL+expected-hash caches parsed PackedScenes (up to 32); URLs without hashes must be immutable or have a changing version query. If object IDs/model references are unchanged, scene packets update TRS/selection without re-instantiation. `frame:false` preserves the user's camera.

Other parent messages share `source` and `nonce`:

Scene messages may set `editable:false`: selection and cameras continue, but gizmos and transform proposals are disabled. Object mode is always noneditable. `ready.seq` is -1 until the first scene is installed.

- `{type:'select',id,seq?,document_id?}` selects an object (empty ID clears); no event loop back to parent. Supplied sequence/document must match the installed scene.
- `{type:'editor',seq,tool:'select'|'move'|'rotate'|'scale',snap:boolean,document_id?}` changes tool and/or persistent snap. `tool` and `snap` may independently be omitted.
- `{type:'camera',seq,action:'fit'|'focus'|'front'|'top'|'right'|'perspective',document_id?}` frames all, focuses the actual selected AABB (or all with no selection), or changes view. Front/top/right use orthographic projection; perspective uses the orbit camera. View changes frame the selected object, falling back to all.
- `{type:'camera',seq,action:'rotate',amount?:0.35,document_id?}` changes yaw in radians and returns to perspective.

**Editor and camera commands require `seq === applied_seq`**; these are commands against the installed document, not new scene revisions. Missing/stale sequences and mismatched documents are ignored. Accepted selection/editor/camera commands cancel any pending drag before applying. A newer scene request also cancels before validating/loading the candidate, so a failed import retains the original confirmed transform.

All child events include `{source:'world-atelier-preview',nonce,runtime_version:'0.2.0'}`:

| Event | Additional fields |
| --- | --- |
| `ready` | `mode, capabilities`; repeated while no scene has loaded so a parent startup race can recover |
| `loaded` | `seq,document_id,rebuilt,object_ids,objects,mesh_count,bounds,assets,selected_id,render_verified:false` |
| `selected` | `seq,document_id,id`; actual mouse selection, triangle-tested for models |
| `transform` | `seq,document_id,id,phase:'start'|'preview'|'commit'|'cancel',position,rotation,scale,before:{position,rotation,scale},tool,handle` |
| `camera` | `seq,document_id,position,target,distance,yaw,pitch,view,projection` |
| `editor_state` | `seq,document_id,tool,snap,editable,axis_space:{move:'world',rotate:'world',scale:'local'}`; emitted after scene install, editor commands, and tool shortcuts |
| `history` | `seq,document_id,action:'undo'|'redo'`; parent owns the transaction history; never emitted in noneditable mode |
| `error` | `seq,document_id,id,code,error,retained_seq,recoverable:true` |

`objects` reports each object's actual transformed AABB, position/rotation/scale and model mesh count. `bounds` is `{min,max,size,center}` with XYZ arrays. `assets` reports `{id,url,hash,bytes,mesh_count}` for each model instance. Editor grid/handles/anchor markers do not inflate the aggregate **model** mesh count. `loaded` proves resource preparation and node installation, **not a presented GPU frame**. Use actual rendered capture for visual verification.

## Controls and layout writes

| Input | Main view | Object view |
| --- | --- | --- |
| LMB click/drag | Select actual mesh, or drag an active handle; empty dragging leaves camera unchanged | Orbit |
| Double LMB | Select the hit model and focus its transformed AABB | Orbit |
| RMB drag / Alt+LMB | Orbit | Orbit |
| MMB / Shift+RMB | Pan | Pan |
| RMB held + WASD / Q,E | Fly along camera axes / world vertically; tool shortcuts are suppressed | Same |
| Wheel | Zoom | Zoom |
| F / Shift+F | Focus actual selected AABB / whole scene | Same |
| Q / W / E / R | Select / move / rotate / scale; editable mode only | No editing |
| Ctrl / Shift during drag | Temporarily toggle snap / one tenth precision | No editing |
| Escape | Restore complete original TRS and emit cancel | Cancel navigation |
| Ctrl or Cmd+Z / Shift+Z, Ctrl+Y | Cancel pending drag, then request undo / redo from parent; editable only | No editing |

Move and rotate use **world axes**; scale uses the object's **local axes**. Move has XYZ shafts and XY/XZ/YZ planes, rotate has three circular rings, scale has XYZ boxes and a central uniform handle. Handles use an approximately 80-pixel world length/radius, 13-pixel screen hit tolerance, and yellow hover/active highlights. Foreshortened axes or edge-on plane projections may be unusable until the camera rotates. Plane ray intersections within roughly 4.6 degrees of parallel are rejected; an invalid intersection retains the previous valid drag position.

Movement snaps the delta from drag start in 0.25 m increments; rotation snaps the world-axis delta in 15 degree increments; scale snaps the multiplicative factor in 0.1 increments. Ctrl is an **XOR** with persistent `snap`: it can disable existing snap temporarily. Shift multiplies the total drag delta by 0.1. Position clamps to ±1000 and scale to 0.1–5. Uniform scale clamps one shared factor, retaining the original component ratios. World rotation uses a basis rotation, with accumulated angles across full circles; emitted Euler degrees may change representation around ±180° or a gimbal singularity while the actual orientation stays continuous.

`start` captures the original complete TRS; every transform event repeats `before`. Previews are throttled to at most 25/s, while commit and cancel are immediate. Parent should update fields on preview and send a confirmed scene only after commit. These are **proposed document edits**; this renderer does not persist them. Parent owns validation, history and conflict resolution. Escape, focus loss, resize, missing held-button mask, or an accepted new command restores the exact original Transform3D before emitting cancel. Handles and outline nodes are cached: hovering changes materials, camera movement adjusts gizmo scale/transform, and geometry is only rebuilt on tool changes.

## Native/headless checking

The same scene path supports an isolated HTTP fixture and native diagnostics:

```sh
Godot --headless --path runtimes/model-preview -- \
  --scene=/absolute/scene.json --origin=http://127.0.0.1:48931 \
  --quit-on-loaded --report=/absolute/report.json --quit-after=30
```

`scene.json` uses the scene envelope, with source/nonce/type/seq defaulted for CLI diagnostics. `PREVIEW_LOADED` and report events come from the real runtime. A candidate error exits 2 with `--quit-on-loaded`; an unready timeout exits 2. For a native render remove `--headless`, add `--capture=/absolute/image.png`; capture waits for the actual post-draw signal and saves the framebuffer. Do not use `--capture` in headless mode.

`tests/probe.gd` is a targeted **HTTP/GLTF and native input-handler** probe. Run with `--headless --path runtimes/model-preview --script res://tests/probe.gd -- --fixture=/absolute/scene.json --origin=http://127.0.0.1:48931 --probe-report=/absolute/result.json`. Its fixture uses the six supplied `pf-*` models plus `anchor-point`, and its isolated HTTP server also serves `/preview-assets/bad.glb` containing invalid bytes. It checks 198 actual model meshes, TRS without reinstantiation, stale/corrupt candidate preservation, model/anchor picking, Y handle commit, readonly mode, and superseded asynchronous loads. Scan process output for engine/script errors and require `PREVIEW_PROBE_COMPLETE` plus all checks; the 25-second watchdog fails unfinished runs. This does not substitute for browser keyboard/mouse or GPU validation.

`tests/interaction_probe.gd` uses the same CLI fixture arguments and real HTTP models. It checks actual InputEvent paths for three tools, axis/plane acquisition, hover caching, complete-circle rotation, full-TRS cancellation, temporary/permanent snap, precision, nonuniform scale, readonly/history/sequence fences and camera controls. Require `INTERACTION_PROBE_COMPLETE`, all checks, exit 0 and a clean script/engine-error scan. Its 35-second watchdog fails incomplete execution. Screen hit metadata is exposed as `host.gizmo.screen_handles()` returning `{handle_id:{kind,points:PackedVector2Array,axis?,axes?}}`; `hit_test(Vector2)` is the actual production hit test. Mouse motion fixtures must carry the physical `button_mask` just as real input does.

## Shared Play and personal inspection

[PLAY-BEHAVIORS.md](PLAY-BEHAVIORS.md) specifies immutable component scripts, actual Godot physics, the authority worker transport, candidate validation, and world projection messages. A scene may additionally include `branch_id`, immutable `scene_revision`, object `solid/components/developments`, and an optional `spawn_position`. Unsupported object hierarchy is rejected explicitly.

Only the main iframe accepts `{type:'world',action:'join'|'snapshot'|'events'|'mode'|'leave',...}`. It emits `player_input` for the server to authenticate/relay and `world_state` describing the actual viewed revision and sequence. In Play, WASD moves a CharacterBody3D on the headless authority, Space jumps and E interacts with a real Area3D. Camera pointer gestures remain available. Editor tool shortcuts and transforms are disabled while playing or inspecting.

The workbench also offers a collapsible **游玩控制** panel. Direction clicks request a 0.12-second short step; a pointer held for 180 ms starts continuous movement with renewable 0.4-second input leases. Release, pointer cancellation, page blur, hidden page, panel closure and mode changes stop continuous input. Jump/interact are ordinary one-shot player intents. The parent sends `{type:'world',action:'control',world_id,epoch,scene_revision,control:'forward'|'backward'|'left'|'right'|'jump'|'interact'|'stop',kind:'tap'|'start'|'end'|'cancel'}`; only matching playing clients accept them. The child combines these camera-relative intents with keyboard input and emits its normal sequenced `player_input`. No control writes a player position or bypasses authority.

The same panel shows `world_state.player_position` from the displayed avatar, `authoritative_player_position` from the latest authority snapshot, displayed `tick`, `latest_tick` and, during inspection, `frozen_tick`. These are observable game state, not editable coordinate inputs. DOM `#playControls` also exposes those ticks, sequence boundaries and displayed position as data attributes for accessible state observation.

Personal inspection sends zero movement and waits for its real snapshot acknowledgement, then freezes that projection. The latest network snapshot continues to advance. The camera can detach and inspect the frozen objects; resuming prepares the latest matching assets before enabling movement. Captured object transforms are inspection observations, never automatic authoring edits. See the behavior contract for custom animation freeze responsibilities and script risk boundaries.

Presence packets use `{type:'presence',seq,document_id,branch_id,peers:[{id,name,color,camera:{position,target}}]}`. Sequence/document/branch must match the installed document. Up to 32 peer camera frustums and names are drawn. Each object's `developments` is an array of actual server task entries `{id,status:'editing'|'testing'|'delivered'|'failed',label?,actor?}`; amber rings, yellow/black boards and labels reflect supplied status without simulated completion.

Live task updates use a separate `{type:'development',seq,document_id,branch_id,states:[{object_id,status,label?,actor?}]}` packet. The host checks current document/sequence/branch and updates transient overlay metadata against the actual displayed objects in edit, Play or inspection. It does not load another scene or change canonical/playable revisions. An empty states array clears the current task markers. Playing clients hide peer cameras whose `mode` is playing, because avatars already represent those users. Editing/inspection retain camera markers, except within 1.5 m of the observer camera or behind it, where near-plane projection would obscure the viewport.

`tests/world_projection_probe.gd` checks a real authority simulation and two separate client projection trees through actual snapshots, including zero acknowledgement, personal freeze, another player continuing, rejected candidates and matching-revision resume. `tests/world_worker_probe.mjs` exercises the separate actual Godot authority over authenticated loopback WS and HTTP assets. `tests/world_validator_probe.mjs --out=/absolute/output` launches isolated validators for both script roles and failing lifecycle/migration candidates. These are engine/protocol tests, not browser or production-service acceptance. All reports require completed checks, correct exit status and an appropriate engine/script error scan; intentional negative script cases must be reported as failures of the candidate.

Limits: imported model animations are not automatically played, and triangle picking uses mesh geometry rather than skin-deformed animation poses. Imported camera/light children are stripped so the workspace camera/lighting remain in control. Creator scripts are trusted code with process/watchdog isolation, not a security sandbox or universally safe arbitrary-code reload. This is not the full native Godot editor. Browser pointer capture, keyboard focus, final aesthetics and actual central multi-user operation require separate Web verification.

## Hierarchy documents (0.3.0)

The runtime now also consumes the canonical `creation-hierarchy-2` pack through explicit mount nodes and quaternion local transforms. Full-address picking/transform messages, immutable asset access, source-safe temporary previews, readonly object observations, and the primitive physics/shear limits are specified in [HIERARCHY-RUNTIME.md](HIERARCHY-RUNTIME.md). `runtime_capabilities.json` is the single advertised capability data source and is included in the exported PCK. Flat document input and existing controls remain supported.
