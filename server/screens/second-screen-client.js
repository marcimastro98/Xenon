// One screen connected to watch the PC's picture: what it may ask (the list of screens, start,
// stop, size, touches) and the stop of the capture when it goes away.

const { screenCapture } = require('./second-screen-hosts.js');
const { _packWsFrame } = require('../windows-tiles/ws-frame.js');

// Relay for the Second-screen tile. One capture host is shared, so only one
// client streams at a time; if a second client starts, it takes over the sink.
// The capture process itself self-stops when no tile is visible (the client
// sends 'stop' on hide / perf-pause), keeping idle cost at zero.
function _handleSecondScreenClient(client) {
  const send = (obj) => { try { client.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } };
  let owns = false;
  let useBinary = false;
  const sink = (data, meta) => {
    if (!useBinary) { send({ type: 'frame', data, w: meta.w, h: meta.h, seq: meta.seq }); return; }
    let payload; try { payload = Buffer.from(data, 'base64'); } catch (e) { return; }
    try { client.send(_packWsFrame({ type: 'frame', w: meta.w, h: meta.h, seq: meta.seq }, payload)); } catch (e) { /* ignore */ }
  };
  client.on('message', async (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    try {
      switch (m.type) {
        case 'list': { const r = await screenCapture.list(); send({ type: 'monitors', monitors: r.monitors || [] }); break; }
        case 'start': {
          owns = true;
          useBinary = m.binary === true;
          screenCapture.setFrameSink(sink);
          const r = await screenCapture.start({ monitor: m.monitor, fps: m.fps, maxWidth: m.maxWidth, maxHeight: m.maxHeight, quality: m.quality });
          send({ type: 'started', info: r });
          break;
        }
        case 'stop': { owns = false; await screenCapture.stop(); send({ type: 'stopped' }); break; }
        case 'input': { screenCapture.input(m.event); break; }
        default: break;
      }
    } catch (e) {
      send({ type: 'error', error: String((e && e.message) || e) });
    }
  });
  const cleanup = () => { if (owns) screenCapture.stop().catch(() => {}); owns = false; };
  client.on('close', cleanup);
  client.on('error', cleanup);
}

module.exports = { _handleSecondScreenClient };
