// Packs one picture of a streamed screen or browser tile with its description into a single
// binary message.

// Binary relay frame: [u16BE header length][UTF-8 JSON header][JPEG bytes].
// Streaming clients opt in ({binary:true} on open/start) and then receive frames
// as binary WebSocket messages — no base64 layer (~33% less wire) and no
// per-frame atob loop on the client's main thread. The base64-in-JSON path stays
// for a dashboard that was already open before a server update.
function _packWsFrame(header, payload) {
  const h = Buffer.from(JSON.stringify(header), 'utf8');
  const out = Buffer.allocUnsafe(2 + h.length + payload.length);
  out.writeUInt16BE(h.length, 0);
  h.copy(out, 2);
  payload.copy(out, 2 + h.length);
  return out;
}

module.exports = { _packWsFrame };
