import { createHash } from 'node:crypto';
export const CANONICAL_WEB_POLICY='world-atelier-canonical-game-web-v1';
const digest=value=>createHash('sha256').update(value).digest('hex');
/** One immutable exported page serves standalone and embedded runs. Only host
 * debugging and save persistence differ; project/PCK/entry remain identical. */
export function adaptCanonicalGameWeb({html,identity,storage}){
  const anchor='const engine = new Engine(GODOT_CONFIG);';
  if((html.match(/const engine = new Engine\(GODOT_CONFIG\);/g)??[]).length!==1)throw Error('Canonical game shell requires one reviewed Godot startup');
  if(!identity?.content_key||!storage?.namespace)throw Error('Canonical game shell requires fixed identity and storage domain');
  const fixed=JSON.stringify({policy:CANONICAL_WEB_POLICY,identity,storage}).replace(/</g,'\\u003c');
  const injected=`const WA_GAME_MANIFEST = ${fixed};
const waParameters = new URLSearchParams(window.location.search);
// The access shell lives on the isolated runtime origin and supplies this
// exact parent window. No creator token is ever part of the game contract.
window.WA_RUNTIME_HOST = Object.freeze({parent_origin:waParameters.get('wa_parent_origin') || window.location.origin,launch_nonce:waParameters.get('nonce') || ''});
const waEmbedded = window.parent !== window && waParameters.get('launch') === 'editor' && waParameters.get('wa_embedded') === '1' && Boolean(waParameters.get('nonce'));
// Disable IDBFS before Engine initialization. Each iframe receives fresh RAM
// user://, so stop/restart and another user's preview cannot inherit its save.
if (waEmbedded || WA_GAME_MANIFEST.identity.purpose === 'prefab_test') GODOT_CONFIG.persistentPaths = [];
window.worldAtelierLaunch = Object.freeze({ ...WA_GAME_MANIFEST, embedded: waEmbedded, persistence: waEmbedded || WA_GAME_MANIFEST.identity.purpose === 'prefab_test' ? 'memory_only_per_iframe' : 'godot_user_data' });
${anchor}`;
  const adapted=html.replace(anchor,injected);
  return {html:adapted,metadata:{format:1,policy:CANONICAL_WEB_POLICY,content_key:identity.content_key,storage,original_html_sha256:digest(html),adapted_html_sha256:digest(adapted)}};
}
