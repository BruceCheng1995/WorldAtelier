# Notifications producer repair

Files to copy: `services/creation/notifications.mjs`, `services/creation/inbox.mjs`, `tests/creation/notifications.test.mjs`, `tests/creation/inbox.test.mjs`. Existing notification public method names are retained. Do not copy development symlinks.

- All direct `closeByScope` calls have valid source/kind and a causal selector. Session-level or client document-loaded recovery expands matching records into exact item IDs/version guards using a server-only helper.
- Development request closure selects code `agent_request`; it cannot close the independent verification Agent's code `verification_request`. The latter closes by job_id/request_key.
- Actual cleanup confirmation resolves only same-run cleanup errors; actual completed execution resolves only same-run execution uncertainty/failure. Generic successful content verification never changes a failed execution record into successful execution.
- Passed automatic verification resolves only older persisted jobs of the same goal/session/actor, same runtime build, covered passed-report resources and ancestor source revisions. Missing coverage, another goal/resource/build, or an equal/newer ambiguous job timestamp remains unresolved. Earlier failed tool calls can become obsolete history only after their actual run completed and nonempty output coverage passed; they are not relabeled successful tools.
- Manual Godot pass closes only same origin run (or explicit null origin), resource, revision and build. Private run report failures deliver to that run owner.
- `world(world,failure,{notify:false})` is the optional host shutdown control; `service.closing`, `service.worlds.closing` and existing precondition failures also suppress notification. Actual worldReady only resolves earlier/same-epoch connection problems for that world/resource; it never clears behavior faults or a future epoch.
- `client` and `clientRecovered` accept optional client_id (viewport nonce, nonempty <=160 chars) and runtime_build_id. Their identity is included in persisted deduplication and exact recovery. A client object/address is resolved against the supplied immutable manifest, including hierarchy runtime IDs and instance paths; forged/missing/mismatched targets reject. Bare IDs never seek a similarly named object in another instance.
- A recovered event with an object/address closes only that exact client target. A whole-document loaded event without an object closes its child asset_load/runtime_load reports only for the same user + nonce + project/branch/revision/resource/build/world pins. An omitted nonce matches only old null-nonce records, never every tab.
- Client reports and recoveries remain authenticated client observations; these helpers do not manufacture a Godot authority/GPU proof.
- Notification title/message cleaning always yields nonempty bounded text and redacts configured local paths/query tokens. Missing target documents are dropped from asset badges without losing the owning execution failure notification.
- Inbox list now accepts parsed target objects and performs target filtering before pagination; counts remain whole authorized project/branch scope. Whole-resource issues match children; instance-specific object issues do not contaminate siblings.
- Asset projections include the already-authorized project_id/branch_id so flat object markers can be matched by the frontend without inferring scope; no private session details are added.

Run focused checks: `node --test tests/creation/inbox.test.mjs tests/creation/notifications.test.mjs`.
These tests use real isolated SQLite and explicitly synthetic Agent/Godot/client producer events; they are not runtime/graphics acceptance evidence.
