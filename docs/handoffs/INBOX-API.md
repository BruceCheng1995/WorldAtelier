# CreationInbox integration contract

This package adds only `services/creation/inbox.mjs` and its pure domain/SQLite tests. Its development `schema.mjs` and `store.mjs` are symlinks to the canonical existing modules, not delivered copies. No routes, UI, automatic test jobs, runtime processes or producer hooks are installed here.

## Public class

`new CreationInbox({store, onChanged?, now?})`

- `store` is the existing CreationStore. All mutations use its synchronous transaction. Call producer methods **after existing authoritative transactions commit**, not inside a nested `store.transaction`.
- `onChanged` is a synchronous invalidation callback called after commit with `{item_id,project_id,branch_id,recipient_user_ids,version,status}`. Use recipient IDs to send individual `inbox_changed` invalidations; do not broadcast private message bodies. Its exceptions are retained in `lastNotificationError` and do not make committed authority operations fail.
- `now` is an injectable test clock; production defaults to `Date.now`.

## Server producer methods

Never expose `record`, `close`, or `closeByScope` as generic client JSON writes. The service must derive project/session/run/world/version scope and recipients from its actual authenticated objects. A Godot client observation remains a client report; it is never an authority success/fault receipt merely because the client sent text.

`record(input) -> {item,replayed,changed}`

Required fields:

```js
{
  event_id: 'stable ID for this exact producer event',
  dedupe_key: 'stable semantic incident ID',
  source: 'agent', // agent | godot_client | godot_authority | backend
  kind: 'error',  // error | decision | validation | notice
  title: 'Short title', message: 'Actual event summary',
}
```

Optional fields:

- `severity`: `info | warning | error`. Defaults notice→info, decision→warning, others→error.
- Fixed scope: `project_id,branch_id,session_id,goal_id,run_id,job_id,revision,runtime_build_id,world_id,epoch,resource_id,client_id`. `client_id` is a nonempty <=160 character viewport nonce, only for godot_client notifications. Together with the runtime build it separates multiple tabs of one user; both may also pin an explicitly addressed personal runtime-load notification without a project.
- `targets`: `{resource_id,object_id?,address?}[]`, where address is the canonical `{project_id,branch_id,resource_id,instance_path,definition_node_id}`. Additional target annotation fields are deliberately discarded. Nested path segments may repeat. Resource documents must exist in the fixed source revision; object/node existence and the actual incident-to-target diagnosis belong to the trusted producer/adapter.
- `code`: producer-owned machine category for exact closing, e.g. `authority_runtime_fault`, `client_scene_load`, `verification_failed`.
- `actions`: `[{id,label,enabled?,reason?}]`; allowed IDs are `locate,session,decision,retry_verification,build`. These are navigation descriptors only; no URL/command/payload execution is supported.
- `request_key`: only for `source:'agent',kind:'decision'` with a real session. This is an existing Agent request reference, **not evidence it is still pending**. Actual answers must use existing `agent.reply`, which checks thread/turn/epoch, owner and actual adapter request liveness. The host must close obsolete decision records on request resolution, terminal runs and startup reconciliation.
- `recipient_user_ids`: optional persisted user IDs. Public project events default to current owner/editor members. Agent events with session scope are owner-only even if the session is shared. Other session events obey current session sharing. Unscoped/global events require explicit recipients and cannot have asset markers.
- `occurred_at`: optional source event time in milliseconds. Defaults server now. A known old occurrence arriving after closure is retained as a repeat without reopening/overwriting the resolved incident. A later actual recurrence reopens it.

Session scope fills project/branch. Asset-targeted events without an explicit revision pin the run's last source output/input or current branch head at recording. A world event requires world ID, revision, epoch and runtime build; historical pins are retained rather than rewritten to current values.

Deduplication has two layers:

1. Same source + event_id + exact payload returns the persisted item, `replayed:true`, without another occurrence/notification. Reusing an event ID with changed payload is 409. Original raw producer payload identity is checked before current membership defaults, so changing collaborator membership cannot break an exact retry.
2. Different event IDs with the same source/kind/dedupe key and fixed scope/targets/request key combine into one item. Repeated identical active content increments `occurrences,last_seen_at` only and stays read if already read. A material title/message/severity/code/actions change or a later recurrence increases version and becomes unread. Different branch/run/job/revision/build/world/epoch/target/request identities remain separate.

`close(id,{expected_version?,status,reason}) -> {item,changed}`

- Only `resolved` (actual covered successful check/recovery) or `obsolete` (request/context no longer applicable). Required `reason` is the producer's concrete closing basis.
- Optional version guards concurrent material progress. Existing matching closed status/reason is an idempotent no-op without a version guard. Different closed facts cannot overwrite each other.
- Prior closure facts remain in `resolution_history` if an actual recurrence reopens the item.
- Never call this because a user read a notification or merely because source changed. A generic validation pass does not prove an unrelated client rendering error recovered.

`closeByScope(scope,{status,reason}) -> {items,count}`

- Allowed selectors: all fixed scope fields, plus `source,kind,code,request_key,dedupe_key`; equality is exact, with no prefix or wildcard matches.
- Requires `source + kind` and at least one causal `run_id/job_id/request_key/dedupe_key/world_id/revision`. Add project/branch and as many pin fields as the actual recovery covers. A project-only “everything fixed” close is rejected.
- Closes matching currently open items in one transaction and sends invalidations after commit. No-match is a zero-count result; invalid inputs are still rejected.

## Authenticated user API

`get(user,id) -> item`

`list(user,{project_id?,branch_id?,filter?,status?,unread_only?,target?,limit?,cursor?}) -> {items,counts:{unread,actionable},next_cursor}`

- `filter`: `actionable | unread | all`; omitted is all. Optional status: `open | resolved | obsolete | all`.
- Filters are applied before pagination; counts always summarize the entire currently authorized project/branch scope independently of filters/pagination.
- `target` is an object with `{project_id?,branch_id?,resource_id?,object_id?,address?}`. Host route parses target JSON; project/branch may come from outer filters. Scope mismatch is rejected. Target matching happens before pagination but does not reduce counts. A resource-wide issue includes its child objects; an object issue only matches its exact flat/runtime identity or full nested address. A bare node name does not match every instance of a prefab. A resource filter shows all its object issues. Exported `issueMatchesTarget` uses the same semantics after target normalization.
- `actionable` means non-notice, open and current context. A problem can require attention without a navigation button. Unread is independent: resolved updates may be unread; old unreviewed issues may be unread but not currently actionable.
- Default limit 100, max 200. Opaque cursor binds user ID and the last updated_at/id position. Every page rechecks recipients, role and private-session authorization. No private counts are leaked by filtering after pagination.
- Item projection removes recipient IDs and dedupe_key. Adds personal `read_at,read_version,unread`, plus `context_current,actionable`. Closed/historical navigation actions are disabled with a reason.
- Currentness checks branch source content, goal's current run and supplied world's persisted epoch/revision/build. A historical revision remains current only when every referenced resource still exists and its `{schema,resource,all active prefabs}` hash is unchanged; this preserves issues across unrelated scene edits while conservatively invalidating on any prefab change. Branch-level items without resource targets keep an exact revision requirement. Pending `decision` notifications remain answerable across source changes; they still depend on current run and the existing reply endpoint's live-request check. Asset markers require the original target/dependency content even for decisions. World epoch/revision/build checks remain strict. A build ID without a world has no server-global runtime comparison in this standalone module; host scope/producer rules must settle obsolete job/build events. It does not prove a world is online.
- Loss of project role, membership or private-session access takes effect on every get/list/read, including request replays.

`read(user,id,{expected_version,request_id}) -> {item,replayed}`

- Marks only that user's observed version read; never changes problem status, others' read state, requests, source or world.
- Version mismatch is 409. Exact request replay returns fresh current item but does not accidentally mark a newer version read. Same request ID with changed item/payload is 409.
- Current access is checked before replay. Personal `read_at` persists across restarts. New material issue progress makes the older read_version unread again.

## Asset marker projection

`projection(user,projectId,branchId) -> [{id,project_id,branch_id,source,kind,severity,status,revision,runtime_build_id,world_id,epoch,resource_id,targets,occurrences}]`

- Any authorized project reader can see a shared asset problem, including a safe indication of a private Agent problem. This never includes title/message, actor/session/goal/run/job, request key or actions.
- Only open, non-notice, currently pinned context is projected. Old revisions/goal runs/world epochs remain in the authorized Inbox history with `context_current:false`, not labeled “fixed”.
- It returns individual safe issues; the workbench may aggregate counts by exact resource/address. No current-source target is substituted for a historical target.

## Persistence and verification

Document kinds: `creator_inbox_item`, `creator_inbox_read`, `creator_inbox_receipt`. No DDL or changes to existing domains. Existing full SQLite backups naturally include them. No automatic deletion or external sending occurs.

Run `node --test tests/creation/inbox.test.mjs` in this package or after copying its two delivered files into the repository. These are isolated real SQLite/domain tests using explicitly synthetic producer events, not actual Agent/Godot/browser acceptance evidence.
