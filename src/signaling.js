// src/signaling.js
// Translates WS JSON <-> pipeline calls. One viewer per connection.
let counter = 0;

function handleConnection(ws, { pipeline, iceServers }) {
  const viewerId = 'viewer-' + (++counter);
  let endpoint = null;
  let watching = false;

  const send = (obj) => ws.send(JSON.stringify(obj));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    try {
      if (msg.id === 'watch') {
        if (watching) return; // idempotent: ignore repeat watch
        watching = true;
        try {
          endpoint = await pipeline.addViewer(viewerId);
        } catch (err) {
          watching = false; // unwedge: allow the client to retry watch
          throw err;
        }
        // Kurento -> browser trickle ICE. Kurento 7.x emits 'IceCandidateFound'
        // (the old 'OnIceCandidate' name is rejected: "doesn't accept events of type").
        endpoint.on('IceCandidateFound', (event) => {
          send({ id: 'ice', candidate: event.candidate });
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
    try { await pipeline.removeViewer(viewerId); } catch { /* best effort */ }
  });
}

module.exports = { handleConnection };
