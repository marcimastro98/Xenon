// Who just stopped working, and the Clawd marker in the topbar island that says a session works,
// finished or waits for you.
'use strict';

window.ClaudeWidgetTopbar = (wrapper) => {
  const { ui, paint, openAsk } = wrapper;

  const { t } = window.ClaudeWidgetWords;
  const { widgetState, sessions } = window.ClaudeWidgetKnown;
  const { el } = window.ClaudeWidgetLines;
  const { tiles, topbarOn, approvals } = window.ClaudeWidgetDecisionsShown;

  // ── presence: who just stopped working ─────────────────────────────────────
  // One place decides "a session went from working to done", and two surfaces
  // read it: the notice inside an open chat panel, and the marker in the topbar
  // island. Both exist for the same reason — a session that finishes while you
  // are looking somewhere else currently announces itself nowhere, so you find
  // out by going back and checking.
  const DONE_TTL_MS = 10 * 60 * 1000;   // how long a finish stays worth showing

  function trackPresence() {
    const list = sessions();
    const now = Date.now();
    const next = new Map();
    list.forEach(s => {
      const was = widgetState.lastStates.get(s.id);
      next.set(s.id, s.state);
      // Only a real transition counts. Seeding (was === undefined) must not
      // announce every session that happens to be idle when the page loads.
      //
      // And only a real FINISH. "Not running" used to be enough, which meant a
      // session that stopped to ask for a permission was announced as having
      // finished answering — the opposite of what had happened, at the one
      // moment the user most needed to know the difference. A session that was
      // killed is not an announcement either: it has nothing to show and
      // nothing to continue.
      const finished = was === 'running' && s.state === 'idle' && !s.waitFor
        && !(s.ended && s.endedReason === 'gone');
      if (finished) {
        ui.doneNotices = ui.doneNotices.filter(n => n.id !== s.id);
        ui.doneNotices.push({ id: s.id, project: s.project || '', at: now });
      }
    });
    widgetState.lastStates = next;
    ui.doneNotices = ui.doneNotices.filter(n => (now - n.at) < DONE_TTL_MS && next.has(n.id));
    if (ui.doneNotices.length > 4) ui.doneNotices = ui.doneNotices.slice(-4);
  }

  // Notices about a session OTHER than the one being written to. Seeing "this
  // session finished" while typing into that very session is noise.
  function otherNotices() {
    return ui.doneNotices.filter(n => n.id !== widgetState.askResumeId);
  }
  function clearNotice(id) {
    ui.doneNotices = ui.doneNotices.filter(n => n.id !== id);
    ui.topbarSig = '';        // the chip's meaning just changed; let it redraw
    syncTopbar();
    paint();
  }


  // ── the topbar marker ──────────────────────────────────────────────────────
  // Clawd, Claude Code's own mascot (js/claude-code/claude-clawd.js). It replaced a text
  // pill and then a generic sparkle: neither said whose session this was.
  function clawd() { return window.ClaudeClawd.make('cw-tb-mark'); }

  function syncTopbar() {
    const host = document.getElementById('clock-claude');
    if (!host) return;
    // Switched off in Settings → the island gets its space back and stays that
    // way. The signature is cleared too, so re-enabling redraws immediately
    // instead of matching a stale one and staying blank.
    if (!topbarOn()) {
      if (!host.hidden) { host.hidden = true; host.replaceChildren(); }
      ui.topbarSig = '';
      return;
    }
    // A session filed under Finished contributes nothing to any of these. It is
    // not working, it is not blocked, and it cannot become either without an
    // event that would move it back out — a 47-minute-old session was putting
    // the bar into its loudest state while two others were actually running.
    const list = sessions().filter(s => !s.ended && !s.resting);
    const working = list.filter(s => s.state === 'running').length;
    const done = otherNotices().length ? ui.doneNotices.length : 0;
    // A card the user can answer, or a session blocked with no card to answer.
    const pending = approvals().length || list.filter(s => s.waitFor).length;

    // Rebuilding on every payload would restart the animation several times a
    // second while a session is busy — exactly when it must look calm. Only
    // redraw when what the chip MEANS changes.
    const sig = `${working}|${done}|${pending}`;
    if (sig === ui.topbarSig) return;
    ui.topbarSig = sig;

    // Nothing happening → the island gives the space back rather than holding an
    // empty chip. An approval always shows: it is the one thing that blocks.
    if (!working && !done && !pending) { host.hidden = true; host.replaceChildren(); return; }

    host.hidden = false;
    // These are not alternatives, and writing them as a ladder is what made the
    // bar read "finished" while the widget next to it said "1 running": one
    // session ending outranked another that was still working, and the two
    // surfaces contradicted each other on screen at the same time.
    //
    // They are two different questions, so they get two different channels.
    // MOTION says what is happening — walking, hopping, still. The DOT says
    // whether something is for you — amber blocked, accent a result you have not
    // read. A session finishing while another works is Clawd walking with an
    // accent dot, which is both facts at once instead of the louder one winning.
    const state = pending ? 'is-waiting' : (working ? 'is-working' : 'is-done');
    const chip = el('button', 'cw-tb ' + state);
    chip.type = 'button';
    // The mark, not a word. A pill reading "wants your OK" spent the width of
    // six characters saying something the colour says instantly, and it said it
    // next to a clock, where nobody reads sentences. State is carried by colour
    // and by how the mark moves: it turns slowly while Claude works, holds still
    // when there is an answer to read, and knocks when it is blocked on you.
    // The words stay in the tooltip, which is where a word belongs here.
    chip.appendChild(clawd());
    // The tooltip lists everything that is true, for the same reason: it is read
    // right next to a widget that lists it all, and the two must not disagree.
    const parts = [];
    if (pending) parts.push(t('claude_bar_waiting', 'wants your OK'));
    if (working) parts.push(t('claude_bar_working', 'working'));
    if (done) parts.push(t('claude_bar_done', 'finished'));
    const label = parts.join(' · ');
    // A dot rather than a recolour: at this size, repainting Clawd costs the one
    // thing he is there for, which is being recognisably Claude.
    //
    // And the dot is what makes the state legible WITHOUT MOTION, which matters
    // more than it looks. Four dashboard states pause every animation — a dialog
    // open, a minute without touches, game mode, Performance Mode — and on a
    // machine with any of them on, a design that says "working" only by walking
    // says nothing at all: standing still, working and finished were the same
    // picture. Motion is the enhancement here; the dot is the signal.
    //   nothing   Clawd alone, quiet
    //   accent    finished, and you have not looked
    //   amber     blocked on you
    if (pending) chip.appendChild(el('span', 'cw-tb-alert'));
    else if (done) chip.appendChild(el('span', 'cw-tb-alert is-done'));
    if (working > 1 && !pending) chip.appendChild(el('span', 'cw-tb-n', String(working)));
    chip.title = label;
    chip.setAttribute('aria-label', label);
    chip.addEventListener('click', () => {
      const n = ui.doneNotices[ui.doneNotices.length - 1];
      // The tile is where the sessions are: take the user to its page first.
      const tile = tiles()[0];
      const moved = !!(tile && window.DashboardPager && window.DashboardPager.goToPageOf(tile));
      if (!n) return;
      // The panel is drawn inside the tile. With no tile on any page there is
      // nowhere to open it, so the tap acknowledges the marker instead.
      if (!moved && !tiles().length) { clearNotice(n.id); ui.topbarSig = ''; syncTopbar(); return; }
      clearNotice(n.id);
      widgetState.askText = '';
      openAsk(n.id, n.project || '', '');
    });
    host.replaceChildren(chip);
  }

  return { trackPresence, syncTopbar };
};
