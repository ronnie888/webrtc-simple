// src/signaling.js
// Translates WS JSON <-> pipeline calls. One viewer per connection.
let counter = 0;

function handleConnection(ws, { pipeline, iceServers }) {
  const viewerId = 'viewer-' + (++counter);
  let endpoint = null;

  const send = (obj) => ws.send(JSON.stringify(obj));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    try {
      if (msg.id === 'watch') {
        send({ id: 'iceServers', iceServers });
        endpoint = await pipeline.addViewer(viewerId);
        // Kurento -> browser trickle ICE
        endpoint.on('OnIceCandidate', (event) => {
          send({ id: 'ice', candidate: event.candidate });
        });
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
    try { await pipeline.removeViewer(viewerId); } catch { /* best effort */ }
  });
}

module.exports = { handleConnection };
