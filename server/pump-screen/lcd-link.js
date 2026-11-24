'use strict';
// One pump screen Xenon draws on directly, with no vendor app in between (what may be sent:
// lcd-corsair.js). A new picture replaces the one waiting, so the screen always gets the newest
// and never a queue. While no new picture comes the last one is sent again every KEEP_MS: on our
// own 0C4E (23 Nov 2026, iCUE closed) a picture stayed about 31 s, then the screen went back to the
// CORSAIR logo by itself; that same fallback is what a user sees after Xenon stops. Every
// report is checked by isPictureReport before it leaves. A write that fails closes the link and
// says why; the owner opens it again on its next picture. Writes go through hid-reports
// (overlapped, bounded), so a wedged screen never holds the event loop.

const Lcd = require('./lcd-corsair.js');

const KEEP_MS = 10 * 1000;

/**
 * @param {{ panel: typeof Lcd.PANELS[number], hid: { list: (f: any) => Promise<any[]> },
 *   openReports: (ifaces: any[]) => Promise<{ write: (b: Buffer) => Promise<void>, close: () => Promise<void> }>,
 *   onError?: (e: Error) => void, setTimer?: typeof setInterval, clearTimer?: typeof clearInterval }} o
 */
function createLcdLink({ panel, hid, openReports, onError = () => {}, setTimer = setInterval, clearTimer = clearInterval }) {
  let link = null;
  let opening = null;
  let next = null;   // the reports of the newest picture not sent yet
  let last = null;   // the reports of the picture on the screen
  let sending = false;
  let keep = null;
  let closed = false;

  async function open() {
    const all = await hid.list({ vendorId: panel.vendorId, productIds: [panel.productId] });
    const ifaces = all.filter((d) => d.outputLength === panel.reportBytes);
    if (!ifaces.length) throw new Error('the pump screen is not plugged in');
    return openReports(ifaces.slice(0, 1));
  }

  async function linkNow() {
    if (link) return link;
    if (!opening) opening = open().finally(() => { opening = null; });
    link = await opening;
    if (closed) { await link.close().catch(() => {}); link = null; throw new Error('closed'); }
    return link;
  }

  async function sendAll(reports) {
    const l = await linkNow();
    for (const r of reports) {
      if (!Lcd.isPictureReport(r)) throw new Error('refused: not a picture part');
      await l.write(r);
    }
  }

  async function pump() {
    if (sending || closed) return;
    sending = true;
    try {
      while (next && !closed) {
        const reports = next;
        next = null;
        await sendAll(reports);
        last = reports;
      }
    } catch (e) {
      next = null;
      const l = link;
      link = null;
      if (l) await l.close().catch(() => {});
      if (!closed) onError(e);
    } finally {
      sending = false;
    }
  }

  /** @param {Buffer} jpeg a picture at the panel's size; throws when it is not one */
  function show(jpeg) {
    if (closed) return;
    next = Lcd.pictureReports(jpeg);
    if (!keep) keep = setTimer(() => { if (!next && last && link) { next = last; pump(); } }, KEEP_MS);
    pump();
  }

  // The screen goes back to its own picture a moment after the last one.
  async function close() {
    closed = true;
    next = null;
    if (keep) clearTimer(keep);
    keep = null;
    const l = link || (opening ? await opening.catch(() => null) : null);
    link = null;
    if (l) await l.close().catch(() => {});
  }

  return { show, close, isOpen: () => !!link };
}

module.exports = { createLcdLink, KEEP_MS };
