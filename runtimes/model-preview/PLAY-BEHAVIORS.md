# Creator behavior API 1

The Web workbench and the single Godot authority load immutable creator-written GDScript. This document describes the generic runtime contract, not a prebuilt set of game tasks. Changes to a scene/prefab and behavior publication use the central document transaction and validation service. Do not write server state or claim a goal complete from script output.

## Component reference

Each flat object may contain:

```json
{
  "solid": true,
  "components": {
    "collider": {"shape":"trimesh"},
    "interactable": {"radius":2,"label":"与装置交互"},
    "trigger": {"shape":"box","size":[2,2,2],"offset":[0,1,0]},
    "behaviors": [{
      "id":"stable-component-id","api":1,
      "script_url":"/preview-assets/SHA256.gd?cap=CAPABILITY",
      "script_hash":"SHA256","properties":{}
    }]
  }
}
```

`components` is an object, not an array. All fields shown are optional except a behavior's `id`, `api`, `script_url`, and `script_hash`. The renderer receives resolved flat root objects; the current central service stores separate scene/prefab resources and copies instances. Internal prefab hierarchy expansion is not implemented. `parent_id` other than null is explicitly rejected; the renderer does not flatten unsupported parent relationships. `solid` creates actual triangle collision from the model unless a box collider is declared. Collision vertices include all imported/object transforms; bodies retain identity scale. `interactable` is a real Area3D used by E interaction. A trigger is a real Area3D and reports body enter/exit. Trigger/collider dimensions are local meters; a spherical area conservatively uses the largest object scale component.

Immutable source paths must use the exact SHA-256 filename. Same-origin, constrained capability query strings are allowed, but they are authorization rather than content versions. The downloaded UTF-8 source must match `script_hash`. Maximum source size is 256 KiB. Models use the same asset namespace and verified hash dependencies.

## Script lifecycle

A source file must `extends RefCounted`. Each instance receives a `BehaviorContext`; avoid a global `class_name` because versions coexist. Every implemented callback is synchronous and returns a dictionary containing `ok:true`. Optional callbacks are:

```gdscript
func initialize(context) -> Dictionary:
    return {"ok":true}
func tick(context, delta: float) -> Dictionary:
    return {"ok":true}
func interact(context, player: Dictionary) -> Dictionary:
    return {"ok":true}
func trigger(context, player: Dictionary, entered: bool) -> Dictionary:
    return {"ok":true}
func present(context, event: Dictionary) -> Dictionary:
    return {"ok":true}
func freeze(context, frozen: bool) -> Dictionary:
    return {"ok":true}
func dispose(context) -> Dictionary:
    return {"ok":true}
```

`initialize` runs in both roles. `tick` runs at 60 physics Hz on authority and at rendering cadence on presentation. `interact`/`trigger` run only on authority after normal player input/physics overlap. `present` runs on clients for authoritative events and `{kind:'snapshot',initial:bool,tick}` updates. Distinguish these kinds in your code so recurring snapshots do not create repeated one-shot effects.

| Context field/API | Meaning |
| --- | --- |
| `role` | `authority` or `presentation`; explicitly branch when using visual APIs |
| `object_id`, `component_id` | Stable instance/component identity |
| `properties` | Immutable component configuration copied for this instance |
| `state` | Authoritative JSON state, restored across matching component IDs; use initialize to preserve or migrate existing keys |
| `local` | Transient local dictionary, suitable for presentation node references; never checkpointed |
| `root` | The object's presentation Node3D; null on authority |
| `players`, `player(id)` | Readable player dictionaries with position/velocity/yaw/online/interaction count |
| `tick`, `time` | Current authoritative snapshot/physics time, not operating-system wall clock |
| `emit_event(kind, data)` | Authority queues a JSON event scoped to this object/component; clients invoke `present` on the same component |
| `create_tween()` | Creates an owned presentation Tween that pauses with personal inspection |

Keep durable gameplay facts in `context.state`; it must contain bounded JSON primitives, arrays, and dictionaries (64 KiB, depth ≤12). Node/RID/coroutine/Tween references belong in `local`, not state. `properties` and read-only player data do not grant authority to the client. A presentation state change is not sent back as gameplay progress.

Use ordinary Godot Node3D/MeshInstance3D/Material/CPUParticles3D/AnimationPlayer APIs under `context.root` to build effects. Each projection owns private mesh/material resources so a new version cannot mutate frozen resources accidentally through shared imported materials. Use `context.create_tween()` for inspection-aware animation. Standard particle `speed_scale`, AnimationPlayer, context tweens and Node processing freeze in personal inspection. Custom render-time shaders and unmanaged asynchronous callbacks need explicit `freeze` support; the runtime does not claim arbitrary GPU `TIME` effects are frozen.

## Validation and hot application

Run the actual engine against a scene candidate before publication:

```sh
Godot --headless --path runtimes/model-preview -- \
  --validate-scene=/absolute/candidate.json --report=/absolute/report.json
```

The JSON may be a scene with `origin`, or `{scene,origin,scene_revision,state}`. `state` is the matching current checkpoint for migration checks. Asset URLs are capability-bearing same-origin URLs; never copy those capabilities or worker tokens into source files. The validator performs actual HTTP/hash/GLTF loading, creates a separate physics World3D, restores current state, joins a validation player, steps 20 physics frames and exercises declared authority interaction/trigger signatures. It also creates separate presentation nodes with private resources and runs presentation initialization, initial snapshot and emitted events, 20 ticks, freeze/resume and disposal. Require process exit 0, report `ok:true`, `completed:true`, and no engine/script errors in the captured process log. This is bounded initialization/lifecycle validation, not GPU or goal acceptance; later failures or unexercised event branches remain possible.

A valid candidate is installed after preparation succeeds. Compile/initialization failures retain the existing scene/world. Runtime callback failure restores that callback's previous JSON state, disables the failing component, and emits a fault; it is not success. The central service supervises isolated validation and authority workers. Arbitrary GDScript is trusted creator code, **not a security sandbox**: native crashes, external side effects, asynchronous errors and infinite loops are not made transactional by this API. Watchdogs, process isolation and explicit failed/recovering UI remain necessary. Do not promise universal safe arbitrary-code hot reload.

## World transport

A headless authority starts with `--authority` and reads loopback `WA_WORKER_URL` plus `WA_WORKER_TOKEN` from environment. Authorization is a WebSocket handshake header. Never place the token in command-line arguments or world JSON. Node controls one authority per world/epoch; the Web client never creates its own authoritative physics timeline.

Worker messages: `init` / `apply_scene` take `request_id,world_id,epoch,scene_revision,scene,state?`; responses are `world_ready` / `applied` with the same request ID, `ok`, and actual `snapshot`. `join`, `leave`, `input`, `checkpoint`, `shutdown` are the other commands. Snapshots contain `world_id,epoch,scene_revision,sequence,tick,event_sequence,players,object_states,module_assets,runtime_fault`. Inputs use strictly increasing `input_seq`, normalized `move:[x,z]`, and edge-triggered jump/interact. The worker uses 60 Hz CharacterBody3D physics, 10 Hz snapshots, input deduplication and a 0.4-second movement deadman.

Snapshots additionally persist `trigger_contacts:{schema:1,members:{object_id:[player_id,...]},legacy_pending:[player_id,...]}`. This platform ledger records spatial contacts independently of connection presence and creator-owned JSON. Removing/recreating a player's physics body on disconnect, reconnect, or worker recovery does not create a new spatial entry at the same position. Real exits clear the contact and subsequent real entries invoke `trigger` again; new players still receive their first entry. On a cold restore of the same fixed revision, old checkpoints without the ledger seed only previously saved players using actual capsule/Area shape queries at a physics boundary. `legacy_pending` preserves that migration across a checkpoint taken before the boundary. A different revision without a ledger cannot be assumed to have the same former trigger geometry. No frame timer or blanket first-entry suppression is used. Creator scripts may independently prune their own online-member arrays; the runtime does not rewrite those fields or pretend disconnected players are online. Use the platform ledger when inspecting physical contact continuity, rather than assuming a creator's custom membership array has the same semantics.

The iframe consumes `world` actions `join/snapshot/events/mode/leave` and emits `player_input` and `world_state`. Playing renders authoritative snapshots; personal inspection first waits for the zero-input sequence to be acknowledged, then fixes its projection while still consuming a bounded latest snapshot. `input_zero_seq`, `stop_ack_sequence`, `frozen_sequence` and `frozen_revision` distinguish the acknowledged stop from the viewed frame. `inspection_objects` captures actual rendered object TRS; those are client observations, never automatic edits to the authoring document. Resume prepares the matching latest revision and clears held input before enabling control.

`world_state.runtime_fault` is empty or identifies the observed failing `role`, object, component, script hash, callback and error. Its `error` also remains populated while that fault exists, and the runtime HUD labels the failing component. A late presentation fault disables that component without claiming the publication succeeded on this client; the authority timeline and unaffected controls may continue. `control_ready` only describes whether movement input is enabled, not whether all components passed. The central UI must keep a failed/degraded state distinct from an applied scene revision.

### Hierarchy identity (runtime 0.3.0)

For `creation-hierarchy-2`, the canonical pack supplies the complete fixed object/mount graph; the outer metadata rows are not scene geometry. API 1 contexts additionally expose full `address`, `source_revision`, `object_version`, `ancestry_hash`, and the fixed `source_world_matrix`. Two copies of the same prefab get separate runtime IDs, contexts and state. Authority events include that identity. Presentation roots are actual nested nodes; authority roots remain null. See [HIERARCHY-RUNTIME.md](HIERARCHY-RUNTIME.md) for primitive collision limits, actual matrix diagnostics, personal observation semantics, and the remaining distinction between presentation effects and authoritative physics.
