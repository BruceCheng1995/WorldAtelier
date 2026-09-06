# Independent prefab and system scenes

`python3 tools/godot-prefab-scenes.py` generates **290 independently loadable `.tscn` scenes** and their fixture content under the project root’s `.local/prefab-scenes/`. An optional `--output=/absolute/path` isolates another run. Every scene is a real `Node3D` with the same `ExpeditionState`, procedural prefab builder and GLB importer used by the game. The generated `inventory.json` maps each authored ID to its exact scene and records the source content SHA256.

The current map contains **227 authored objects across 14 placed kinds**. The runtime supports **15 object kinds**, so an additional standalone platform fixture covers the supported kind that is currently unplaced. All **46 authored enemies** get their own scene. These are followed by **16 system scenes**, including model binding as a separate resource system, not an invented object kind.

| Object kind | Authored instances | Behavior checked beyond actual mesh construction and selection |
| --- | ---: | --- |
| monument | 2 | Circular solid collider where configured |
| forge | 2 | Seeded 12-crystal budget spent by normal upgrade |
| supply | 3 | Normal interaction heals seeded injury |
| beacon | 3 | Normal interaction activates shared state |
| gate | 1 | Required beacon state permits opening |
| bridge | 4 | Authored dimensions load; separate system checks bridge travel beyond land |
| pillar | 38 | Configured circular solid collider |
| tree | 52 | Configured circular solid collider |
| crystal | 50 | Normal interaction grants exactly two crystals |
| lamp | 32 | Actual mesh construction and authored selection |
| rock | 30 | Configured circular solid collider |
| furnace | 3 | Actual mesh construction and authored selection |
| flower | 3 | Actual mesh construction and authored selection |
| arch | 4 | Actual mesh construction and authored selection |
| platform | 0 + 1 unplaced prefab | Real supported platform mesh |

| Enemy kind | Authored instances | Checks |
| --- | ---: | --- |
| sentinel | 19 | Actual enemy scene, normal player strike reduces enemy HP, AI warning resolves to damage |
| stalker | 9 | Same independent combat checks |
| artillerist | 9 | Same independent combat checks; exact remote warning center has a separate boundary suite |
| brute | 8 | Same independent combat checks; exact radius has a separate boundary suite |
| boss | 1 | Same checks with the fixture's three beacons explicitly unlocked |

| System scene | Explicit fixture setup and assertions |
| --- | --- |
| selection | Normal select command creates expanded mesh outlines and spatial corner bounds |
| editing | Seeded editing task creates amber maintenance orbit and engineering markers |
| testing | Seeded testing task creates testing-colored orbit and engineering markers |
| delivered | Seeded delivered task creates delivered marker and Chinese status text |
| failed | Seeded failed task creates failed marker and Chinese status text |
| move_and_dash | Normal move changes position; dash consumes stamina and creates invulnerability interval |
| combat | Normal strike damages enemy; actual enemy AI damages nearby player |
| death_respawn | Seeded 1 HP receives a lethal enemy hit, timer respawns player, collected count remains |
| collection_reward | Normal pickup awards two crystals; duplicate pickup cannot reward again |
| beacon_progress | Normal interaction increments shared beacon objective |
| upgrade_and_healing | Seeded budget is spent exactly; normal supply interaction heals seeded injury |
| collision | Solid circle blocks its center and normal movement; bridge rectangle supports points outside the island and rejects lateral void |
| content_replacement | Compatible candidate retains reward; failed candidate retains the exact previous snapshot |
| offline_restore | Serialized in-memory snapshot restores consumed object and reward through normal join |
| player_avatar | Actual GLB instantiates its 16-bone skeleton and Idle/Walk/Strike/Dash animation clips |
| model_binding | Fresh Blender Sunforge Relay imports as 50 actual mesh nodes; corrupt asset retains preceding authority state and rendered node |

## Run and inspect

```sh
python3 tools/godot-prefab-scenes.py
Godot --headless --path runtimes/godot --script ../../tools/godot-prefab-verify.gd -- --report-dir=/absolute/headless-evidence
Godot --path runtimes/godot --script ../../tools/godot-prefab-verify.gd -- --render --report-dir=/absolute/render-evidence
# One scene, with actual local gameplay controls enabled:
Godot --path runtimes/godot /absolute/generated/object-starheart.tscn -- --play
# A single reproducible screenshot with automatic termination:
Godot --path runtimes/godot /absolute/generated/system-editing.tscn -- --capture=/absolute/editing.png --quit-after-seconds=1
```

The verifier actually loads and instantiates every generated `PackedScene`; it does not validate JSON alone. `--render` captures one representative scene for each of the 15 object kinds, five enemy kinds and 16 systems (36 images). `--inventory=/absolute/generated/inventory.json` selects an isolated generator output. Individual assertions record their outcome in `prefab-report.json`; completion is marked only at the end of all assertions. A runner-level Godot Logger makes any non-warning engine/VM error a hard failure, even if a broken fixture itself reports success. Independent acceptance should also inspect process stderr for `SCRIPT ERROR`, `Parse Error` or unexpected `ERROR:` and verify the full expected ID set.

These developer fixtures use the Godot editor executable. Official release templates do not expose arbitrary external `--script`; packaged release, central service and Web tests have separate runners. The optional scene input controls are WASD/arrows, Space attack, Shift dash, E interact and Q upgrade.

## Evidence boundaries

Fixture setup deliberately seeds starting positions, HP, budgets, tasks or beacon prerequisites. That is appropriate for isolated boundary testing and is **not normal-input campaign completion**. Preview state is kept separate from the gameplay instance used for destructive assertions, so a successful pickup test does not remove the prefab being inspected.

Collision checks cover the implemented authoritative **XZ circles for solid objects, rectangles for bridges and circular island bounds**. They do not claim GLB triangle-mesh collision. Snapshot restoration here is in memory; disk persistence, process restart, cross-world transfer, binary upgrades, user permissions and Web delivery need their independent central/runtime tests. A generated PNG is rendering evidence; aesthetic/legibility review must still inspect it. Headless results alone do not establish visual quality or frame-time performance.
