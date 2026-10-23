# Play context integration (2026-10-23)

Author: isolated `codex/play-context`. Modules own no central source or game control.

## Service hooks for root integration

In `services/creation/service.mjs`, import `PlayObservations` from `./play-observations.mjs` and `SessionContinuations` from `./session-continuations.mjs`. After `this.builds` and `this.sessionImages` exist:

```js
this.observations = new PlayObservations({service:this});
this.continuations = new SessionContinuations({service:this});
```

After existing Origin guard and authenticated `const user=this.auth(req)`, before the `sessions` router:

```js
if (await this.observations.request(req,res,user,parts,max=>readBody(req,max))) return true;
if (await this.continuations.request(req,res,user,parts,max=>readBody(req,max))) return true;
```

ReadBody receives its own limit; do not use the existing default-512-KiB lazy body closure for captures (bounded capture route accepts 4 MiB). Service close calls `this.observations.close()`; live handles intentionally do not survive restart. Database documents and frame files are immutable evidence. Add `play-observations/` to backup/restore file roots wherever session-images are currently included. Health can expose `play_context:1, session_continuations:1`.

## Agent tools

`session-continuations.mjs` exports `PLAY_CONTEXT_TOOLS` (three read-only tools) and `dispatchPlayContextTool`. Add tools to `CREATION_TOOLS` and permit all three in plan mode. After `assertRun` and existing receipt replay, before the existing tool dispatch:

```js
const observationTool = await dispatchPlayContextTool(this.service, {
  session,user,run,tool:request.tool,args,cwd:request.cwd,signal:request.signal
});
if (observationTool.handled) value = observationTool.value;
else if (request.tool === 'authoring_context') { /* current dispatcher */ }
```

Use the normal tool-result/receipt path for returned values. No direct write leases, gameplay inputs or author method execution are exposed. New observation/continuation attachments are `role:reference`, so they must not become object write targets. Existing attachmentReferences serializes their compact wrapper and leaves full content behind the read tools. Include `session.continuation` summary in per-turn context even after the first message consumes its draft attachment; full historical messages are always read through `session_context_read`. Existing image inputs work unchanged for attached keyframes.

## HTTP contracts

- `POST sessions/:s/play-context/captures`: `wa-play-context-1` input (`packages/contracts/play-context.mjs`), optional live_handle. Returns observation_id, summary and the updated session. Atomically appends one reference and up to three keyframe image attachments, without sending a turn.
- `GET sessions/:s/play-context/observations/:o?section=summary|events|objects|frames&cursor=0&limit=50`: bounded read. `objects` optionally filters runtime_id. Frames have authenticated image URLs.
- `GET sessions/:s/play-context/observations/:o/frames/:f`: immutable actual frame bytes.
- `POST sessions/:s/play-context/windows/register`: `{window_id,scope}` → `{handle,secret,expires_in_ms}`.
- `POST sessions/:s/play-context/windows/:handle/poll`: `{secret}` → pending read-only snapshot requests. No recording content is uploaded by polls.
- `POST .../respond`: `{secret,request_id,capture}` or `{secret,request_id,error}`. Creates another immutable observation, without changing drafts or past messages.
- `POST .../close`: `{secret}` invalidates current reads. A scene generation change requires a fresh registered handle. Missed heartbeats expire after 20 seconds.
- `POST sessions/:source/continue-context`: `{request_id,target_branch_id,expected_target_head,cutoff_message_id?,objective,observation_ids?}` → new private target session and context. Only the owner's sent messages through the fixed cutoff are copied; source drafts, old thread/jobs/leases/approvals/control never move.
- `GET sessions/:target/continued-context?section=summary|messages|mapping|observations`: immutable history paging, with BOTH original and target access checked. Mapping is a separate record at target creation head; source attachments never change branch identity.

## Frontend hooks (controller follows in next commit)

Serve `/play-context-buffer.js`, `/play-context.js`, `/play-context.css`, `/session-continuation.js` and `/packages/contracts/play-context.mjs` from original 48910 service. Relative contract imports match existing viewport-annotations modules.

`PlayContextController` receives `getContext`, `preview`, `request`, `requestInspect`, `onSession`, `onError`, composer/viewport hosts. `getContext()` returns `{user_id,project_id,branch_id,session_id,session_generation,can_write,mode,mode_pending,session}`; can_write requires current session ownership and current project edit permission. `preview()` returns current GamePlay (with job, nonce, sceneGeneration, sceneContext, commandSeq and captureFrame).

Feed valid GamePlay `onEvent` packets into `.accept(packet)` before other handling and call `.update()` after mode/session/scope changes. Await `.beforeSend()` immediately before send's snapshot of attachments; it returns updated session or null. `onSession(session)` updates the current `sessionData` only if the caller still owns the selected session. Call `.sent()` only after a successful real turn response consumes draft attachments. Call `.reset()` on logout/stop/branch change. The controller remains memory-only until send, with a visible removable range. Constructor appends its compact row to composer, and the single “指出这里” action to viewport. Include play-context.css.

`openSessionContinuation({session,branches,request,getContext,onCreated,onError})` opens the one contextual dialog. getContext returns current user_id/project_id; onCreated receives `{session,context}` and navigates to result.session.branch_id then selects result.session.id. A single action in existing session settings is sufficient. Targets have branch_id/name/head; source session must include actual messages so cutoff is explicit.

Game messages: `context_request` (action snapshot, request_id, seq, document_id, scene_generation) → `play_context` (protocol wa-play-context-1, runtime_instance_id, scene_generation, resource_id, source_revision, sequence, engine_time_ms, tick, kind event|snapshot, payload). Runtime identity is the GamePlay iframe nonce (headless probe falls back to explicit world_id), never a user credential or a NodePath. World id/epoch remain separate fences and changing either invalidates a live handle and ring. Frames use the root-owned captureFrame limited bridge; returned seq/document/source/generation are checked. `game_debug_bridge.gd` additionally supports direct capture_frame requests and emits packet_emitted(packet) for root's native transport.

The engine observes actual native nodes (including ordinary dynamic PackedScene instances), but source links are claims rechecked against fixed indexes. No author method or arbitrary script getter executes. Built-in text controls emit redacted input actions and normalized mask rectangles; the controller obscures those rectangles in automatic keyframes, and omits frames if the mask scan is incomplete. Custom-drawn text inputs are not automatically identifiable. No text unicode or clipboard contents are recorded.

## Current tests

`node --test tests/creation/play-context-buffer.test.mjs tests/creation/play-observations.test.mjs tests/creation/session-continuations.test.mjs tests/creation/play-context-engine.test.mjs` — 22/22, including a real canonical native Godot test with headless/Dummy and scripted in-process input. No Web rendering or paid Agent proof yet. The storage tests use real temporary SQLite and explicitly labelled build/native-index fixtures.
