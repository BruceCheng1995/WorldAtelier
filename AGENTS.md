# 世界工坊 · World Atelier

This is a new project, created from scratch at the user's explicit request on 2026-09-06. The only engineering root is `/Users/chengzhi/Projects/WorldAtelier`. The former RuntimeAtelier and runtime-atelier applications are retired; do not restore, migrate or use their code as the implementation baseline.

Read `PROJECT.md`, `docs/DEVELOPMENT-CONTEXT.md`, `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, `packages/contracts/IMPLEMENTATION.md` and `docs/ACCEPTANCE.md` before implementing. The six-part local development acceptance is delivered; see docs/VALIDATION-REPORT.md for exact tested runtime versions and scope. Further acceptance must use fresh evidence, never file presence or extrapolation from earlier runs.

The product is a centrally managed, versioned world service. The server owns projects, collaborator access, source branches, validated releases, world checkpoints, running-world authority, storage and job scheduling. Desktop, web, native editor and offline workspaces are clients. Web gameplay is a first-class requirement, not satisfied by a model viewer.

Distinguish source heads, playable releases and live room states. Resolve a moving branch into an immutable client/content compatibility manifest before downloading. Joining a world requires a matching state baseline, continuous synchronization and valid control authority. Offline content changes and offline gameplay progress are separate merge domains.

Compatible content updates should preserve play in the current runtime. User-requested branch switching and client upgrades may load a new runtime and transfer the session; continuity concerns state and control, not an invariant process ID. Do not describe a new-process transfer as in-process hot reload or promise zero transition delay.

Use one primary integration agent and one independent testing role. Build/edit workers may run concurrently in isolated workspaces; serialize intersecting writes and authority transitions. Tests use independent worlds, ports and state paths. Never substitute fabricated runtime ACKs or historical evidence for verification of this new project.

Official Godot 4.6 source is retained under `research/godot/4.6-stable/` solely for reference. Keep downloaded third-party sources, build outputs, credentials, local databases and world state out of Git. The local development service uses port 48900; independent tests use 48921 and temporary databases. No hosting account or external deployment has been created for this new project yet.
