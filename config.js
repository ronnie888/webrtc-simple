// All tunables in one place. Override via env on the VPS.
module.exports = {
  // Node signaling server
  signalingPort: parseInt(process.env.SIGNALING_PORT || '3000', 10),

  // Localhost-only metrics endpoint (GET /count) for load testing.
  metricsPort: parseInt(process.env.METRICS_PORT || '3001', 10),

  // Kurento Media Server WebSocket(s). Multiple instances on this node run on
  // 8888,8889,... — each Kurento serializes connect setup, so N instances =
  // N× parallel connect handling. Comma-list via env; default single instance.
  kurentoUris: (process.env.KURENTO_URIS || process.env.KURENTO_WS || 'ws://localhost:8888/kurento')
    .split(',').map((u) => u.trim()).filter(Boolean),

  // Source the PlayerEndpoint pulls. nginx-RTMP runs on the same box.
  rtmpSource: process.env.RTMP_SOURCE || 'rtmp://localhost/live/stream',

  // ICE servers handed to the browser. PUBLIC_IP must be the VPS public IP.
  publicIp: process.env.PUBLIC_IP || '127.0.0.1',
  stun: process.env.STUN_URL || 'stun:stun.l.google.com:19302',
  turn: {
    url: process.env.TURN_URL || 'turn:127.0.0.1:3478',
    username: process.env.TURN_USER || 'webrtc',
    credential: process.env.TURN_PASS || 'changeme',
  },

  // Shared access tokens for /embed (comma-separated). Empty = gate disabled.
  embedTokens: (process.env.EMBED_TOKENS || '').split(',').map((t) => t.trim()).filter(Boolean),
};
