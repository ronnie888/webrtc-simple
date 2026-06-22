// src/signaling.js
// Translates WS JSON <-> media calls. One viewer per connection. `pool` shards
// viewers least-loaded across N Kurento instances (KurentoPool); it exposes the
// same addViewer(id)/removeViewer(id) surface as a single KurentoPipeline.
let counter = 0;

function handleConnection(ws, { pool, iceServers, token = null, tokens = [] }) {
  const viewerId = 'viewer-' + (++counter);
  let endpoint = null;
  let watching = false;

  const send = (obj) => ws.send(JSON.stringify(obj));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    try {
      if (msg.id === 'watch') {
        // Token is OPTIONAL: partner embeds use the bare /embed URL with NO token
        // and are gated at nginx (partner Referer/Origin + self-origin). The ?lt=
        // token is for testing/direct access. So only reject when a token IS
        // supplied but is NOT in the allow-list; a missing token passes through.
        if (token && Array.isArray(tokens) && tokens.length > 0 && !tokens.includes(token)) {
          send({ id: 'error', message: 'invalid token' });
          try { ws.close(); } catch { /* ignore */ }
          return;
        }
        if (watching) return; // idempotent: ignore repeat watch
        watching = true;
        try {
          endpoint = await pool.addViewer(viewerId);
        } catch (err) {
          watching = false; // unwedge: allow the client to retry watch
          throw err;
        }
        // Kurento -> browser trickle ICE. Kurento 7.x emits 'IceCandidateFound'
        // (the old 'OnIceCandidate' name is rejected: "doesn't accept events of type").
        endpoint.on('IceCandidateFound', (event) => {
          send({ id: 'ice', candidate: event.candidate });
        });
        // CRITICAL: under load Kurento can fail an op on the endpoint. Kurento 7.x
        // names this event 'Error' (PascalCase) — NOT 'error' (lowercase 'error'
        // is rejected by the endpoint: "doesn't accept events of type 'error'",
        // same gotcha as IceCandidateFound vs OnIceCandidate). Subscribe to the
        // real event so one bad viewer can't crash the whole process.
        endpoint.on('Error', () => {
          try { send({ id: 'error', message: 'media error' }); } catch { /* ws may be gone */ }
          try { ws.close(); } catch { /* ignore */ }
        });
        // Send iceServers ONLY after the endpoint exists, so the browser
        // cannot produce its offer before we are ready to processOffer.
        send({ id: 'iceServers', iceServers });
      } else if (msg.id === 'offer') {
        if (!endpoint) return send({ id: 'error', message: 'not watching' });
        const answer = await endpoint.processOffer(msg.sdp);
        send({ id: 'answer', sdp: answer });
        await endpoint.gatherCandidates();
      } else if (msg.id === 'ice') {
        if (endpoint) await endpoint.addIceCandidate(msg.candidate);
      }
    } catch (err) {
      send({ id: 'error', message: String(err && err.message || err) });
    }
  });

  ws.on('close', async () => {
    if (!watching) return;
    try { await pool.removeViewer(viewerId); } catch { /* best effort */ }
  });
}

module.exports = { handleConnection };
