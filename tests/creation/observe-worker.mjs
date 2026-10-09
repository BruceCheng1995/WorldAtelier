// Test-only passive wire evidence. No fake peer, response, acknowledgement or state.
import { appendFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';

const path = process.env.WORLD_ATELIER_TEST_WORKER_TRACE;
if (path) {
  const original = WebSocketServer.prototype.handleUpgrade;
  WebSocketServer.prototype.handleUpgrade = function (request, socket, head, callback) {
    return original.call(this, request, socket, head, ws => {
      if (new URL(request.url, 'http://localhost').pathname === '/ws/world-worker') {
        const record = (direction, bytes) => {
          const raw = typeof bytes === 'string' ? bytes : bytes.toString();
          const redacted = raw.replace(/([?&]cap=)[^&\s"']+/g, '$1[redacted]');
          appendFileSync(path, JSON.stringify({ at: Date.now(), server_pid: process.pid, direction, packet: JSON.parse(redacted) }) + '\n');
        };
        const send = ws.send;
        ws.send = function (bytes, ...args) { record('node_to_godot', bytes); return send.call(this, bytes, ...args); };
        ws.on('message', bytes => record('godot_to_node', bytes));
      }
      callback(ws);
    });
  };
}
