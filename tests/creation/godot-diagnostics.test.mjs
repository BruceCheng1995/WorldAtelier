// Pure diagnostic-classification regression. All messages are explicit test
// strings; these checks do not represent engine execution or runtime ACKs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {godotErrorLines, createGodotErrorScanner, LINUX_DESKTOP_PROBE_ERROR as desktop} from '../../tools/godot-diagnostics.mjs';

const realErrors = [
  'SCRIPT ERROR: Invalid call. Nonexistent function on the authored node.',
  'Parse Error: Unexpected identifier in the authored script.',
  'ERROR: Failed loading resource: res://missing.tscn.',
  'Export failed: a required Web resource was not produced.',
  'STANDALONE_FAILED {"reason":"scene did not initialize"}',
  'STANDALONE_RUNTIME_FAULT {"error":"actual runtime exception"}',
];
const rid = "ERROR: 2 RID allocations of type 'P11GodotBody3D' were leaked at exit.";
const scan = (chunks, options = {linux:true}) => {
  const scanner = createGodotErrorScanner(options);
  for (const chunk of chunks) Array.isArray(chunk) ? scanner.push(chunk[1], chunk[0]) : scanner.push(chunk);
  return {failed:scanner.finish(), scanner};
};

test('only one exact Linux desktop startup diagnostic is exempted and raw input is unchanged', () => {
  const raw = 'Godot Engine 4.6.stable.official.89cea1439\n' + desktop + '\n   at: execute (drivers/unix/os_unix.cpp:1)\nordinary progress\n';
  const original = raw;
  assert.deepEqual(godotErrorLines(raw, {linux:true}), []);
  assert.equal(raw, original);
  const result = scan([raw]); assert.equal(result.failed, false); assert.equal(result.scanner.desktopProbeDenied, true);
  assert.deepEqual(godotErrorLines('ordinary progress\nWARNING: explicit warning\n', {linux:true}), []);
});

test('macOS and other non-Linux processes do not receive the Linux exception', () => {
  for (const allowEditorRidLeaks of [false, true]) {
    assert.deepEqual(godotErrorLines(desktop + '\n', {linux:false, allowEditorRidLeaks}), [desktop]);
    const result = scan([desktop + '\n'], {linux:false, allowEditorRidLeaks});
    assert.equal(result.failed, true); assert.equal(result.scanner.desktopProbeDenied, false);
  }
});

test('repeated startup diagnostics are errors, including repeats across stdout and stderr', () => {
  assert.deepEqual(godotErrorLines([desktop, desktop, desktop].join('\n'), {linux:true}), [desktop, desktop]);
  assert.equal(scan([['stderr', desktop + '\n'], ['stdout', desktop + '\n']]).failed, true);
  assert.equal(scan([['stdout', desktop], ['stderr', desktop]]).failed, true);
});

test('other commands, changed arguments, prefixes, suffixes and whitespace are never excused', () => {
  const variants = [
    desktop.replace('DESKTOP', 'DOWNLOAD'),
    desktop.replace('xdg-user-dir', 'sh'),
    desktop.replace('2>/dev/null.', '2>/tmp/other.'),
    desktop.replace('"DESKTOP"', '"DESKTOP" "extra"'),
    ' ' + desktop,
    desktop + ' ',
    '[authored message] ' + desktop,
    desktop + ' SCRIPT ERROR: later failure',
    '\u001b[31m' + desktop + '\u001b[0m',
  ];
  assert.deepEqual(godotErrorLines(variants.join('\n'), {linux:true}), variants);
  for (const line of variants) assert.equal(scan([line + '\n']).failed, true, line);
});

test('a matching startup line never clears another error before or after it', () => {
  for (const line of realErrors) {
    for (const rows of [[line, desktop], [desktop, line]]) {
      assert.deepEqual(godotErrorLines(rows.join('\n'), {linux:true}), [line]);
      const result = scan(rows.map(row => row + '\n')); assert.equal(result.failed, true); assert.equal(result.scanner.desktopProbeDenied, true);
    }
  }
});

test('the startup diagnostic is recognized across every same-stream chunk boundary', () => {
  for (const suffix of ['\n', '\r\n', '']) {
    const line = desktop + suffix;
    for (let split = 0; split <= line.length; split++) {
      const result = scan([['stderr', Buffer.from(line.slice(0, split))], ['stderr', Buffer.from(line.slice(split))]]);
      assert.equal(result.failed, false, `split ${split}, ending ${JSON.stringify(suffix)}`);
      assert.equal(result.scanner.desktopProbeDenied, true);
    }
  }
  const scanner = createGodotErrorScanner({linux:true});
  for (const byte of Buffer.from(desktop + '\n')) scanner.push(Buffer.from([byte]), 'stderr');
  assert.equal(scanner.finish(), false); assert.equal(scanner.desktopProbeDenied, true);
});

test('real error tokens remain failures across every chunk split and at EOF without a newline', () => {
  for (const error of realErrors) for (let split = 0; split <= error.length; split++) {
    assert.equal(scan([['stderr', desktop + '\n'], ['stdout', error.slice(0, split)], ['stdout', error.slice(split)]]).failed, true, `${error} split at ${split}`);
  }
});

test('stdout and stderr retain independent line boundaries and share one exemption budget', () => {
  const mid = Math.floor(desktop.length / 2);
  const interleaved = scan([['stderr', desktop.slice(0, mid)], ['stdout', 'ordinary progress\n'], ['stderr', desktop.slice(mid) + '\n']]);
  assert.equal(interleaved.failed, false); assert.equal(interleaved.scanner.desktopProbeDenied, true);
  assert.equal(scan([['stderr', desktop.slice(0, mid)], ['stdout', desktop.slice(mid) + '\n']]).failed, true, 'different streams cannot assemble an exempt line');
  assert.equal(scan([['stdout', 'SCRIPT ER'], ['stderr', 'ROR: not one stream\n']]).failed, false, 'fragments on different streams cannot manufacture an error token');
  assert.equal(scan([['stdout', 'SCRIPT ER'], ['stderr', desktop + '\n'], ['stdout', 'ROR: real stdout error\n']]).failed, true);
});

test('known editor RID teardown diagnostics require explicit opt-in and do not exempt runtime failures', () => {
  assert.deepEqual(godotErrorLines(rid, {linux:true}), [rid]);
  assert.equal(scan([rid]).failed, true);
  const options = {linux:true, allowEditorRidLeaks:true};
  assert.deepEqual(godotErrorLines(desktop + '\n' + rid + '\n', options), []);
  assert.equal(scan([desktop + '\n', rid + '\n'], options).failed, false);
  for (const line of realErrors) assert.equal(scan([desktop + '\n', rid + '\n', line], options).failed, true, line);
  assert.equal(scan([desktop + '\n', desktop + '\n', rid + '\n'], options).failed, true);
});

test('the RID exception does not match other messages or hide embedded actual-error markers', () => {
  const options = {linux:true, allowEditorRidLeaks:true};
  const variants = [
    'ERROR: 2 RID allocations could not be initialized.',
    'ERROR: RID allocations were leaked at exit.',
    'ERROR: 1 RID allocations SCRIPT ERROR: actual failure were leaked at exit.',
    "ERROR: 1 RID allocations of type 'SCRIPT ERROR: actual failure' were leaked at exit.",
    "ERROR: 1 RID allocations of type 'ERROR: actual failure' were leaked at exit.",
    rid + ' SCRIPT ERROR: actual later error',
    'prefix ' + rid,
  ];
  assert.deepEqual(godotErrorLines(variants.join('\n'), options), variants);
  for (const line of variants) assert.equal(scan([line + '\n'], options).failed, true, line);
});

test('an early true error stays sticky after the retained display log has lost it', () => {
  const scanner = createGodotErrorScanner({linux:true, allowEditorRidLeaks:true});
  let displayLog = '';
  const collect = text => { scanner.push(text, 'stdout'); displayLog = (displayLog + text).slice(-32000); };
  collect(desktop + '\n' + realErrors[0] + '\n');
  for (let n = 0; n < 20; n++) collect('ordinary progress ' + 'x'.repeat(10000) + '\n');
  collect(rid + '\n');
  assert.equal(displayLog.includes(realErrors[0]), false);
  assert.deepEqual(godotErrorLines(displayLog, {linux:true, allowEditorRidLeaks:true}), []);
  assert.equal(scanner.hadError, true); assert.equal(scanner.finish(), true);
});

test('very long lines preserve split error tokens and errors arriving after a long normal log', () => {
  const huge = 'ordinary '.repeat(20000);
  assert.equal(scan([huge, '\n', desktop + '\n', 'quiet end']).failed, false);
  assert.equal(scan([desktop + '\n', huge, '\n', realErrors[4]]).failed, true);
  assert.equal(scan([huge + 'SCRIPT ER', 'ROR: late chunk completes a real error\n']).failed, true);
  assert.equal(scan([realErrors[2] + ' ' + huge, '\nordinary ending\n']).failed, true);
});

test('finish is idempotent and the one-message exception belongs to one process scanner', () => {
  const first = createGodotErrorScanner({linux:true}); first.push(desktop); assert.equal(first.finish(), false); assert.equal(first.finish(), false);
  first.push(desktop + '\n'); assert.equal(first.finish(), true);
  const second = createGodotErrorScanner({linux:true}); second.push(desktop + '\n'); assert.equal(second.finish(), false);
});
