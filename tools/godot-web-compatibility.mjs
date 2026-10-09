import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
// Exact official 4.6-stable feature detector, commit 89cea1439. An upgraded
// template must be reviewed again rather than broadly removing its checks.
const FEATURES_SHA256 = 'e9f47a8ac6ede94439cab2ce90cc5c19e35843aacaf213f26a3a6e9ad4098b92';
const SECURE_CONTEXT_CHECK = "\t\tif (!Features.isSecureContext()) {\n\t\t\tmissing.push('Secure Context - Check web server configuration (use HTTPS)');\n\t\t}";

function webOptions(presets) {
  const sections = new Map(); let current;
  for (const line of presets.split(/\r?\n/)) {
    const section = /^\[([^\]]+)\]$/.exec(line.trim());
    if (section) { current = {}; sections.set(section[1], current); continue; }
    const value = /^([^=]+)=(.*)$/.exec(line.trim()); if (value && current) current[value[1]] = value[2];
  }
  const named = [...sections].filter(([name, options]) => /^preset\.\d+$/.test(name) && options.name === '"Web"' && options.platform === '"Web"');
  if (named.length !== 1) throw Error('Local HTTP compatibility requires exactly one Web preset');
  return sections.get(named[0][0] + '.options') ?? {};
}

async function verifyNonSharedWasm(bytes) {
  const module = await WebAssembly.compile(bytes);
  if (WebAssembly.Module.imports(module).some(item => item.kind === 'memory')) throw Error('Local HTTP compatibility does not support imported or shared WebAssembly memory');
  let cursor = 8; const memories = [];
  const unsigned = end => {
    let value = 0, shift = 0;
    while (cursor < end && shift < 35) { const byte = bytes[cursor++]; value += (byte & 127) * 2 ** shift; if (!(byte & 128)) return value; shift += 7; }
    throw Error('Invalid WebAssembly memory descriptor');
  };
  while (cursor < bytes.length) {
    const id = bytes[cursor++], size = unsigned(bytes.length), end = cursor + size;
    if (end > bytes.length) throw Error('Invalid WebAssembly section');
    if (id === 5) {
      const count = unsigned(end);
      for (let index = 0; index < count; index++) {
        const flags = unsigned(end), minimum_pages = unsigned(end), maximum_pages = flags & 1 ? unsigned(end) : null;
        if (flags > 1) throw Error('Local HTTP compatibility requires unshared 32-bit WebAssembly memory');
        memories.push({ flags, minimum_pages, maximum_pages, shared: false });
      }
      if (cursor !== end) throw Error('Unsupported WebAssembly memory descriptor');
    }
    cursor = end;
  }
  if (memories.length !== 1) throw Error('Local HTTP compatibility requires the verified single-memory Godot template');
  return memories;
}

export async function adaptSingleThreadLocalHttp({ javascript, html, wasm, presets, engineVersion }) {
  if (engineVersion !== '4.6.stable.official.89cea1439') throw Error('Local HTTP compatibility has only been verified for official Godot 4.6 stable');
  const options = webOptions(presets);
  if (options['variant/thread_support'] !== 'false' || options['variant/extensions_support'] !== 'false' || options['progressive_web_app/enabled'] !== 'false') throw Error('Local HTTP compatibility requires explicit non-threaded, non-extension, non-PWA export options');
  if ((html.match(/const GODOT_THREADS_ENABLED = false;/g) ?? []).length !== 1 || /const GODOT_THREADS_ENABLED = true;/.test(html)) throw Error('Exported HTML does not confirm a single-threaded Godot build');
  const configLine = /^const GODOT_CONFIG = (\{.*\});$/m.exec(html), config = configLine && JSON.parse(configLine[1]);
  if (!config || config.serviceWorker || config.gdextensionLibs?.length) throw Error('Exported HTML uses an unsupported service worker or GDExtension');
  if (!Array.isArray(config.args) || config.args.some(arg => String(arg).startsWith('--audio-driver')) || (html.match(/const engine = new Engine\(GODOT_CONFIG\);/g) ?? []).length !== 1 || (html.match(/<script src="index\.js"><\/script>/g) ?? []).length !== 1) throw Error('Exported HTML audio/startup configuration differs from the reviewed shell');
  const start = javascript.indexOf('const Features = {'), end = javascript.indexOf('\n};', start) + 3;
  if (start < 0 || end < start || javascript.indexOf('const Features = {', start + 1) >= 0) throw Error('Exported Godot feature detector is missing or ambiguous');
  const original = javascript.slice(start, end);
  if (digest(original.trim()) !== FEATURES_SHA256 || !original.includes(SECURE_CONTEXT_CHECK)) throw Error('Godot feature detector differs from reviewed official source');
  const memories = await verifyNonSharedWasm(wasm);
  const detector = original.replace(SECURE_CONTEXT_CHECK, `\t\t// World Atelier: only this verified single-thread export may use local HTTP.
\t\t// Keep the actual isSecureContext result and every unrelated engine check.
\t\tconst location = window.location;
\t\tconst host = location.hostname.toLowerCase();
\t\tconst octets = /^\\d{1,3}(?:\\.\\d{1,3}){3}$/.test(host) ? host.split('.').map(Number) : [];
\t\tconst localIPv4 = octets.length === 4 && octets.every(value => value <= 255) && (
\t\t\toctets[0] === 10 || octets[0] === 127 ||
\t\t\t(octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
\t\t\t(octets[0] === 192 && octets[1] === 168) ||
\t\t\t(octets[0] === 169 && octets[1] === 254));
\t\tconst localName = host === 'localhost' || (host.length > 6 && host.endsWith('.local'));
\t\tconst localHttp = supportsThreads === false && location.protocol === 'http:' && (localIPv4 || localName);
\t\tif (!Features.isSecureContext() && !localHttp) {
\t\t\tmissing.push('Secure Context - Check web server configuration (use HTTPS)');
\t\t}
\t\tif (typeof WebAssembly !== 'object' || typeof WebAssembly.instantiate !== 'function') {
\t\t\tmissing.push('WebAssembly - Check web browser configuration and version');
\t\t}`);
  const adapted = javascript.slice(0, start) + detector + javascript.slice(end);
  // Godot 4.6 initializes its sample-position worklet unconditionally before
  // ScriptProcessor can provide a fallback. Use the engine's existing Dummy
  // driver for this HTTP mode rather than pretending AudioWorklet is present.
  const adaptedHtml = html.replace('const engine = new Engine(GODOT_CONFIG);', `// Local HTTP has no AudioWorklet: Godot 4.6 needs its explicit silent driver.
if (GODOT_THREADS_ENABLED === false && !window.isSecureContext &&
\twindow.location.protocol === 'http:' && !Engine.isAudioWorkletAvailable() &&
\tEngine.getMissingFeatures({ threads: false }).length === 0) {
\tGODOT_CONFIG.args = GODOT_CONFIG.args.concat(['--audio-driver', 'Dummy']);
\tdocument.getElementById('wa-http-audio-note').hidden = false;
}
const engine = new Engine(GODOT_CONFIG);`).replace('<script src="index.js"></script>', '<div id="wa-http-audio-note" hidden role="status" style="position:fixed;right:12px;bottom:12px;z-index:2;padding:5px 9px;border-radius:5px;background:rgba(12,21,33,.76);color:#e0e6ec;font:12px/1.5 sans-serif;pointer-events:none">局域网试玩暂不播放声音</div>\n\t\t<script src="index.js"></script>');
  return { javascript: adapted, html: adaptedHtml, metadata: {
    format: 1, policy: 'world-atelier-single-thread-local-http-v1', engine: engineVersion,
    source_commit: '89cea143987d564363e15d207438530651d943ac', upstream_features_sha256: FEATURES_SHA256,
    original_javascript_sha256: digest(javascript), adapted_javascript_sha256: digest(adapted),
    original_html_sha256: digest(html), adapted_html_sha256: digest(adaptedHtml),
    single_threaded: true, wasm_memory: memories, local_http_hosts: ['RFC1918 IPv4', 'IPv4 loopback', 'IPv4 link-local', 'localhost', '*.local'],
    retained_checks: ['WebGL2', 'Fetch streaming', 'WebAssembly', 'Secure Context outside local HTTP', 'Cross-Origin Isolation and SharedArrayBuffer when threads requested'],
    secure_context_only_features: ['microphone access', 'async clipboard', 'AudioWorklet', 'service workers'],
    local_http_audio: 'Dummy (silent) when AudioWorklet is unavailable; secure HTTPS audio configuration is unchanged',
    local_http_notice: '局域网试玩暂不播放声音',
  } };
}
