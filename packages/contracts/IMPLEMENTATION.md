# Implemented contract — local World Atelier, 2026-09-07

This records the local implementation interfaces; design invariants in docs/PROTOCOL.md still apply. Metadata timestamps use Unix milliseconds. Gameplay `world_time`, event time and attack/dash/respawn deadlines use simulation seconds; `tick` is the 30 Hz simulation counter. JSON uses snake_case. The game is **星屿远征 / Starfall Expedition**, a substantial cooperative action exploration game: observatory hub, verdant gardens, ember foundry, ancient citadel; multiple objectives, enemy archetypes, boss, upgrades, combat and persistent progress.

## Authority protocol (WebSocket JSON)

Godot is launched with `-- --role=authority --server=ws://127.0.0.1:48900 --world=ID --host-key=SECRET`. Connect to `/host`, then send `{type:'host_hello',world_id,host_key}`. Node replies `{type:'init',world_id,epoch,release_id,content,state}`. `state` is null for new world or the last durable snapshot. Authority must restore state, then send `{type:'ready',release_id,epoch,state,runtime_version}`. Node sends `{type:'join',user_id,name}` before player commands.

Node forwards `{type:'command',request_id,user_id,action,payload}`; authority validates cooldowns, ranges and action eligibility. Actions: `move` payload `{x,z}` normalized input; `attack`, `dash`, `interact` payload `{object_id?}`; `select` payload `{object_id}`; `upgrade`. Snapshots contain authoritative gameplay; no client can supply positions, rewards or arbitrary state. Reply `{type:'result',request_id,ok,error?,state}`. Result state includes all acknowledged critical changes. Node persists it before ACK. Authority emits `{type:'snapshot',state}` at 10Hz. State shape `{tick,players:{user_id:{name,x,z,hp,max_hp,stamina,crystals,level,kills,quest_stage,...}},enemies:{id:{kind,x,z,hp,...}},objects:{id:{...}},events:[{id,kind,x,z,...}],...}`. Keep state JSON serializable and events bounded. Node wraps current release/epoch externally.

Content update: `{type:'apply_content',request_id,release_id,content}`. Validate candidate before mutation; preserve players and compatible enemy/object progress, update resource/behavior/collision representation at frame boundary. Return `{type:'applied',request_id,ok,error?,release_id,state}`. Invalid candidate must leave old content/state intact. Maintenance updates `{type:'tasks',tasks:[{id,object_id,status,author,title}]}` are transient branch-scoped overlays; authority should echo/store them in snapshot `tasks` for rendering. Supported states editing/testing/delivered/failed. No fabricated completion timers.

## Game client protocol

Native launch: `-- --role=client --server=ws://127.0.0.1:48900 --ticket=TICKET`. Web gets server/ticket via URL query `?server=ws...&ticket=...` (Godot may use JavaScriptBridge). Connect `/play`, send `{type:'hello',ticket,snapshot_ack:true}`. Node replies `{type:'welcome',user_id,world_id,epoch,release_id,content,state,control_generation}`. Validate resources and construct/update scene nodes from content/state, then send `{type:'loaded',release_id}`. Only server `{type:'active',...}` means controls enabled.

Commands `{type:'command',request_id,epoch,release_id,control_generation,action,payload}`; ACK `{type:'ack',request_id,ok,error?,sequence}`. Updates `{type:'snapshot',epoch,release_id,state,sequence}`. Content change `{type:'content',release_id,content}` must be applied before `loaded` ACK; server fences old commands. State events include combat VFX. `{type:'revoked',reason}` stops commands. `{type:'error',error,recoverable:true,request_id}` is a rejected command and does not disconnect gameplay. An error without recoverable is a connection/load failure. Client must expose honest readiness/telemetry for browser E2E via window.postMessage `{source:'world-atelier-game',type:'telemetry',world_id,release_id,tick,user_id,active,selected,player,...}`; parent may send only normal input commands via postMessage for accessible controls, never set state.

Headless validation: `-- --role=validate --content=/absolute/content.json`, validate using same content parser and game initialization, exit 0 and print `CONTENT_VALIDATED` only if valid; nonzero on failure. Offline mode `-- --role=offline --content=/absolute/content.json --save=/absolute/state.json` uses same authority gameplay locally, isolated from online saves. `--offline-user=USER_ID` preserves the matching account identity from an authorized seed.

## Content schema

`{schema:1,title,revision_label,spawn:{x,z},zones:[{id,name,x,z,radius,color}],objects:[{id,name,kind,x,z,scale,color,solid,zone_id,...}],enemies:[{id,kind,x,z,hp,zone_id,...}],rules:{player_speed,attack_damage,enemy_damage,...},quests:[{id,title,description,target,...}]}`. Coordinates on XZ plane, Y elevation mostly visual. Godot worker owns initial `content/world.json` schema details. Objects include beacon, crystal, supply, gate, forge, monument, tree, rock, pillar, platform, bridge, lamp, flower, furnace and arch. Bridges require finite length and width in [0.1,160]. Stable IDs and finite bounds are validated. Objects may reference `model_asset:SHA256`. `behaviors:[{id,asset_hash,api:1}]` references constrained GDScript assets. Materialized content includes `asset_blobs` with verified base64 data. This is an explicit bounded rule interface, not arbitrary remote code or general scene hot reload.

## Portal HTTP API

All `/api` JSON. Errors non-2xx `{error,details?}`. Bearer token except register/login. POST `/api/auth/register` `{name,password}`; POST `/api/auth/login` same → `{token,user:{id,name}}`. GET `/api/me`. GET `/api/projects` → `{projects}`. POST `/api/projects` `{name}` → `{project}` seeds game content with main branch. GET `/api/projects/:id` → `{project,branches,releases,worlds,tasks,members,activity,builds}`. POST `/api/projects/:id/members` `{name,role}` role editor/tester/viewer (owner protected).

GET `/api/projects/:id/branches/:branch/content` → `{revision,content}`. POST `/api/projects/:id/branches` `{name,from_branch:'main'}`. POST `/api/projects/:id/branches/:branch/commit` `{base_revision,content,message}` → `{revision,conflicts?}`; three-way content merge on stale base, HTTP409 on conflicts. POST `.../:branch/merge` `{target:'main'}`. POST `.../:branch/build` → `{build}`; async actual Godot validation + immutable artifact registration. GET `/api/projects/:id` polls actual task results. POST `/api/projects/:id/worlds` `{branch,name?}` → `{world}`; POST `/api/worlds/:id/apply-latest` → applied result. GET `/api/worlds/:id` → world metadata and state.

POST `/api/projects/:id/checkouts` `{branch,platform:'web'|'macos',mode:'join-live'|'preview-frozen'|'offline',world_id?}` → `{checkout,release,artifacts,world?}` pinned immutable release; POST `/api/checkouts/:id/prepare-join` → `{ticket,world_id,release_id,game_url,server_url}`. `game_url` is actual versioned Godot Web entry, e.g. `/artifacts/:runtime_hash/web/index.html?ticket=...&server=...`. POST `/api/projects/:id/tasks` `{branch,object_id,title,status}`; PATCH `/api/tasks/:id` `{status}`. GET `/api/projects/:id/branches/:branch/offline` → `{format:1,project_id,branch,base_revision,content}` downloadable JSON workspace; POST `.../:branch/import` accepts same plus modified content, never gameplay progress. Workspace UI stores drafts locally, lets download/upload JSON and shows conflicts. API membership enforced per project; viewer cannot edit/build/tasks. Member role tester can play and inspect but not commit.

IDs are opaque; branch names restricted slug. Default local service is 127.0.0.1:48900, tests must use isolated port/data roots. Node backend uses SQLite and ws, portal Vue/Vite builds to apps/portal/dist. Artifacts stored under `.local` and served immutable. No production deployment yet.


## Consumer ACK, durable state and fences

Shipped clients negotiate `snapshot_ack:true`. Each socket has at most one outstanding full snapshot. After logical consumption and node update (not a GPU frame-present fence), client sends `{type:"snapshot_ack",sequence,release_id,epoch}` matching that exact snapshot. The coordinator coalesces newer states while waiting, then sends the newest durable full state. This implementation uses full shared-project snapshots, not the private filtered event stream described as a future protocol target.

Content candidates use actual Godot preparation and an `applied` response before the world release moves. Client content loading pauses command authority; `loaded` causes a full state barrier and activation. Command checks include world epoch, release, control generation, current project membership and current controlling socket. The same checks are repeated when queued work runs. Critical command request IDs are persisted with payload fingerprints and actual responses; retry returns the same ACK, differing payload reuse fails. Activity positions use `activity_sequence`, never overwrite `world_sequence`.

Host `ready.state` is restored and persisted before declaring running. Authority frames and command-result snapshots are persisted before acknowledgment. `host_key` and current epoch fence stale host sockets. The local SQLite store uses WAL and FULL synchronization. This is a single-host coordinator, not a proven distributed lease protocol.

## Immutable exports, runtime upgrade and recovery

`POST .../branches/:branch/build {runtime_hash?}` validates actual content using that immutable export's binary, verifies required artifact bytes and records the release. Omitted runtime_hash selects the current export and requires source inventory to match; an explicitly pinned historical export is permitted. Old builds finishing late cannot move a newer playable head backward. Interrupted jobs are failed on restart.

`POST /api/worlds/:id/apply-latest {release_id?}` pins the expected playable target. Matching runtime uses compatible content application. Different runtime freezes the real authority, persists an independent checkpoint at F, stops the old host and restores the new binary at a new epoch. The upgrade receipt records actual progress. Failure returns to the old binary from the old frozen checkpoint; it never restores from partially migrated target state. `GET /api/upgrades/:id` queries this record. `POST /api/worlds/:id/sleep` freezes and stores a checkpoint before stopping; a subsequent checkout wakes it.

`POST .../checkouts` also accepts an explicit project `release_id`, with matching world. This permits deliberately rejoining a retained old world after failed upgrade without rolling the branch's global head back. `GET /api/transfers/:id` returns the authenticated user's actual transfer result. A restored authority epoch uses the persisted checkpoint as the old-session fence; ordinary same-epoch handoff obtains a real zero-input acknowledgment. New runtime/iframe startup is a session handoff, not same-process HMR.

`tools/backup.mjs` snapshots SQLite with its backup API and copies all referenced assets/content/runtime files with SHA-256 inventory. Restore requires new data, verifies every file and can run entirely from a separate runtime root. Current releases remain retained; no automatic garbage collector is implemented.

## Assets, constrained behaviors and offline workspaces

`POST /api/projects/:id/assets {name,mime,data_base64}` accepts project-scoped immutable GLB up to 2 MB or `text/x-gdscript` up to 32 KB. `GET .../assets` lists, and `GET .../assets/:hash` returns authorized data. Materialized closure is bounded to 8 MB raw. GLB is parsed by actual Godot with external URI rejection. Models are selected by immutable content hash and decoded from verified bytes into fresh GLTFState/PackedScene candidates before replacing the previous representation. No versioned filesystem path is required by this GLB loader.

Behaviors extend RefCounted and expose `evaluate(context:Dictionary)->Dictionary`, return bounded rule overrides, and obey a restricted call/syntax policy. Invalid candidate compilation/output rejects publication. Detected late invalid output quarantines the release and restores the previous full content through a real world apply. Release tests demonstrated invalid-output detection; no general VM exception or hostile-code isolation guarantee follows.

`GET .../branches/:branch/offline` supplies source revision/content/dependency closure separately from the fixed playable content and only its matching state seed. The portable package adds a verified macOS application, `Play offline.command`, local save domains and optional native editor. Push/import sends source fields and base revision, never play state or asset blobs. The desktop tool rebases edits saved while an upload is in flight, records unresolved conflicts and refreshes dependencies introduced by the remote merge. Offline progress is isolated by user/workspace/candidate; different candidates do not automatically migrate saves.

Native editor details and supported fields: [adapter contract](../../tools/native-editor/README.md). Save events export supported Node3D fields into content.json, watcher submits, actual build validates and selected world applies the pinned release.

## Object annotations and actual delivery

`POST /api/projects/:id/tasks` accepts `{branch,object_id,title,origin:"live",observed_world_id,observed_release_id,observed_object_hash?}`. Live origin validates the actual world/branch/release and pins its revision, object hash, epoch and observed sequence. Source origin pins an optional branch-reachable `base_revision` or current source. Tasks always start editing. Directly setting delivered is rejected.

A build changing the target object automatically records testing and candidate revision/build. Actual build failure records failed. A real world application records delivered revision/hash/release/world and applied sequence. Every state transition is retained in task history; reopening creates another cycle. Per-world task overlays compare the current object hash: another world still on the old object remains `testing, delivery_status:"awaiting_world"` until it actually applies the delivered object.

`GET /api/projects/:id/branches/:branch/objects/:object_id/history?limit=30` returns:

- `source` and `playable`: revision, object hash, object snapshot and release where applicable.
- `worlds`: actual world release/revision/hash/object, epoch, applied/durable sequence and status.
- `versions`: first-parent object-changing revisions with author, timestamp, message, full object, changed fields and related releases; bounded page, `has_more` indicates truncation.
- `tasks`: branch/object-specific base, candidate, delivered identities and lifecycle history.

Portal restores a selected historical object's value into the current draft only, preserving the current base revision and all other object edits. Commit, validation and world apply remain required. Object-local hash history does not claim transitive arbitrary dependency graph versioning.

## Membership

`DELETE /api/projects/:id/members/:user_id` is owner-only and cannot remove the owner. It revokes connected project clients; queued operations, assets and already issued checkout/tickets recheck access. Tests verify five local accounts and two projects. Project members currently share the full gameplay state; fine-grained secret per-player views are not implemented.


Host control also includes `leave`, `freeze` and its matching `frozen` state response. Freeze blocks simulation and mutation before the checkpoint is persisted. During a program change the coordinator emits upgrading/runtime_upgrade notices; the old client stops sending commands and a new program must use a fresh checkout/ticket. A successful resource/node load or snapshot ACK is not proof of GPU presentation; exported-client screenshots and input tests are recorded separately.
