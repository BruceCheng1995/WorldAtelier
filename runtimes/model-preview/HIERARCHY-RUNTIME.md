# Hierarchy runtime 0.3.0

This runtime consumes `creation-flat-1` and `creation-hierarchy-2`. The advertised data is read from `runtime_capabilities.json`; that exact file must be included in the source inventory and exported PCK. The build manifest is the host's identity proof. A `loaded` or `scene_graph` response is an actual parser/node observation, not proof that a browser GPU presented a frame.

## Fixed scene input

A hierarchy `scene` message keeps the existing same-origin/parent/nonce/sequence envelope and adds:

```js
{
  document_schema: 'creation-hierarchy-2',
  document_id, branch_id, resource_id, scene_revision, origin,
  hierarchy_pack, hierarchy_pack_canonical,
  asset_access: [{ hash, extension: 'glb' | 'gd', url }],
  objects, // optional UI metadata only; never geometry/behavior truth
  preview_object_id, // optional, object iframe only
  preview_observation // optional fixed read-only object observation
}
```

`hierarchy_pack_canonical` is the server's exact canonical string of the pack without `pack_hash`. The runtime checks its SHA-256 against `pack_hash`, parses and compares its payload against the supplied pack. It does not try to reproduce JavaScript's floating-point number formatting with Godot JSON serialization. Authorized asset URLs stay in `asset_access`, keyed by extension and immutable hash. The pack retains canonical query-free URLs. HTTP has redirects disabled; assets must use the same origin and the exact hash filename, with a restricted optional capability query. Verified asset byte hashes are independent of the capability string.

`assembly_order` and explicit object/mount `parent` references build the actual Godot tree. Every local transform is a quaternion TRS. Mount nodes remain separate from prefab roots. Geometry, behaviors, state identity and collisions use this tree; `scene.objects`, `node.parent_id` and resolver `parent_key` never reconstruct it. Object IDs remain stable across source versions, while the full address includes project/branch/resource/instance path/definition ID. States use the runtime ID inside the fixed world scope.

Both editor and Play loaders retain complete old candidates on a failed hash, GLB, script, matrix or supported-physics check. Editing reuses nodes when model hashes and topology match. Changing only source TRS or capability queries does not reload GLTF. Geometry bounds are checked for both rebuilt and reused candidates. The isolated authority validator also runs real collision physics and both behavior roles before reporting completion. Trusted GDScript is still not an OS or VM sandbox; later exceptions/infinite loops retain the existing explicit fault/watchdog limits.

## Editing and temporary observations

Selection and every hierarchy transform phase (`start`, `preview`, `commit`, `cancel`) include `id`, full `address`, `source_revision`, `object_version`, `ancestry_hash`, actual `world_matrix[16]`, and local quaternion `local_transform` (or null if the observed pose cannot be expressed as local TRS). A transform's `before` records the same full identity/pose. There is no Euler reconstruction of the authoritative matrix. Flat documents keep their prior TRS messages.

Movement and rotation use world axes. Scale uses the actual transformed local axis directions, including a nonorthogonal world basis inherited from ancestors. The source still permits only local quaternion TRS: a world rotation that would introduce local shear is cancelled and the original local transform restored with `local_trs_unrepresentable`. Existing inherited world shear remains intact. Source limits are local position ±1e6 and local positive scale 1e-4–1e4; runtime origins and imported geometry are additionally bounded to ±10000.

```js
{ type: 'editor_preview', seq, document_id, source_revision,
  previews: [{ id, address, world_matrix, expected_object_version,
    expected_ancestry_hash, peer_id, expires_at }],
  reset_local: true }
```

The command requires the current applied scene sequence and source revision, full matching address and versions, and a finite nonsingular affine matrix. It changes only presentation nodes. Empty `previews` clear remote observations. Explicit `reset_local:true` also resets a just-committed local pose that has not received its source ACK. Successful source scene installation clears both kinds. Previews expire at their supplied Unix milliseconds deadline, with a maximum ten-second local lifetime; `expires_at:0` uses only that local lifetime. Starting a local drag clears remote observations and captures the canonical source pose. Another local drag waits for the preceding source ACK, so uncommitted temporary transforms cannot silently become an edit base.

Object preview receives the complete pack plus `preview_object_id`; structural ancestors and mounts remain present, while only the selected object's actual subtree is visible and framed. An optional matching `preview_observation` places that subtree at the fixed observed world matrix without rewriting its source. Unknown identity or mismatched version is a candidate error. No observation is applied to authority state.

## Physics and inspection

Trimesh collisions bake owned model triangles with the full world matrix, including shear. Descendant authored objects own their own collisions; a parent does not duplicate its child's triangles. Box colliders and box Areas require an orthogonal world basis; nonuniform axis lengths scale their dimensions. Sphere Areas require an orthogonal, uniformly scaled basis at the pack's relative 1e-7 tolerance. Unsupported primitive transforms reject the whole candidate. Offsets use the complete world matrix. Shape orientation is normalized only after the canonical primitive transform passes that policy. The existing flat policy is retained.

Behavior contexts add `address`, `source_revision`, `object_version`, `ancestry_hash`, `source_world_matrix`. Authority `root` remains null; presentation `root` is the actual owning nested Node3D. API 1 behavior state is still JSON, not a generic node transform/physics mutation API. Events carry full object identity. A script intentionally moving presentation nodes does not, by itself, move authoritative collision geometry.

Personal inspection retains its prior zero-input ACK and individual projection freeze. `world_state.inspection_objects` now includes full address, fixed version and the actual frozen global matrix; `position` is its matrix origin. Network snapshots and source updates continue separately. The server may store that as an authenticated client observation, never as proof of an authoritative object pose or a source edit.

`world_ready`, successful `applied`, and the isolated validator report include `scene_graph`: actual object/mount matrices plus primitive Area positions/dimensions and baked collider face counts. `scene_graph` is sampled at candidate installation; regular snapshots keep player/object-state/contact fields and do not repeat all static source matrices at 10 Hz. Asset records include actual hash, mesh count and full object identity. Existing checkpoint contacts and incarnation-specific online presence are preserved.

## Reproducible checks

```sh
node runtimes/model-preview/tests/hierarchy_driver.mjs --source-root=/absolute/WorldAtelier
```

The driver uses the checked-in pure-pack fixtures, actual project GLB bytes and a generic test-only API 1 script, temporary local HTTP/WS endpoints, real Godot Node3D/Area3D/CharacterBody3D and native input events. It does not use production state, browser automation, an Agent-created final task script, or fabricated worker acknowledgements. Reports/logs default to `.local/model-preview/hierarchy-test` in this checkout. Both exit codes and complete result files must pass; any unexpected Godot VM/parse/engine error fails the driver. Separate existing contact, controls and label probes remain runnable. Browser/high-DPI interaction and integrated service transactions require the independent root acceptance run.
