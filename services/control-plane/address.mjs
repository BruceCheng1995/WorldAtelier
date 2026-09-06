export function clientAddress(port, configured) {
  const url = new URL(configured || `http://127.0.0.1:${port}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('WORLD_ATELIER_PUBLIC_URL must be an HTTP(S) origin without credentials, path, query or fragment');
  return {http: url.origin, websocket: `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`};
}
