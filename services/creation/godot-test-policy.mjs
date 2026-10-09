// Shared creator guidance; this does not schedule tests or add an acceptance gate.
export const GODOT_TEST_REMINDER = 'Run server Godot tests only through workspace.json engine.executable: headless by default, --wa-render for brief background-only visual checks, always silent. Never launch the raw Godot app, activate a window, use desktop/CUA keyboard or mouse automation, or play audio. Use in-process scripted inputs and saved images; do not bypass the launcher. Headless results do not verify visuals.';

export const GODOT_TEST_GUIDANCE = `## Server Godot test cost

Tests remain optional. When testing imports, script errors, physics, AI, input
logic or game rules, use workspace.json engine.executable (or the session godot
command on PATH). This managed launcher defaults to --headless and forces the
Dummy audio driver for ALL server tests, including screenshots. Do not run a raw
Godot binary, open the Godot app, or modify/bypass the launcher and its config.
workspace_test and game_validate already use headless execution. Use the same
canonical game project and a finite test plan, --quit-after limit or wall-clock
timeout. Do not leave a game or editor running after the check.

Only request --wa-render to answer a specific visual question about framing,
materials, lighting, animation or UI. The launcher uses macOS --embedded with
no desktop window, limits rendering to 30 FPS / 120 seconds, and permits one
rendering process per session. Set --resolution WIDTHxHEIGHT to the intended
capture size (default 1280x720, each side 64..1920); verify saved image dimensions.
It rejects unsupported hosts; never fall back to
a visible, minimized or offscreen desktop window. Keep these checks separate from repeated
logic tests; use a small set of representative frames, suitable resolution and
an FPS cap when appropriate. Run at most one rendering check at a time in this
session and close its process when captures finish or the deadline expires.
Do not repeatedly replay the whole game with rendering for logic-only changes.

Never activate/focus applications, move the user's pointer, send OS keyboard or
mouse events, or use CUA/AppleScript/System Events/desktop automation for tests.
Drive the game through in-process Input.action_press/action_release,
Input.parse_input_event, or test hooks; inspect saved images with view_image.
Do not play music, sound effects, TTS, or invoke an external media player. These
are server test restrictions: preserve the authored game's audio and normal
player controls. Do not save test-only mute/window settings into central source.
If background rendering is unavailable, report the visual check as unavailable
and continue useful headless checks without touching the user's desktop.

--headless disables real rendering and audio; it cannot validate appearance or
produce a real viewport screenshot. A hidden window is not headless. Screenshot
code must skip GPU readback/frame_post_draw waits in headless mode and use a
bounded capture wait in rendering mode. Report logic and visual evidence
separately, including when visual behavior was not checked.
`;
