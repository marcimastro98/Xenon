// What the console holds between paints: the session picked or followed, the side panel's view and
// open agent, the folder box, the face, the held paint and the notices of finished sessions.
'use strict';

(() => {
  const ui = {
    askProjectsLoading: false,
    // One session at a time, beside the rail, never a separate screen: the old
    // modal panel is what made it easy to lose track of which chat was which.
    // `picked` is a choice the user made and sticks until they make another;
    // without one the console takes the session that needs you most, ONCE, and
    // keeps it while it lives, so it never jumps under a finger because another
    // session changed state.
    picked: '',
    pickedLabel: '',
    autoPicked: '',
    composing: false,       // the console holds a new session instead
    followRun: '',          // a new run whose session the console moves to once known
    pickAt: 0,
    // Which view the side panel shows. Plain state: it resets on a reload, and a
    // session without a plan always falls back to the tool log.
    asideView: '',
    // The agent open in the Agents view, plain state like ui.asideView. A new agent
    // starting opens the view once, the way a new plan opens Plan.
    agentSel: '',
    // Work anywhere: a folder typed or pasted here joins the list (the server
    // checks it is a real folder and keeps it). Not offered to a paired device,
    // where the server refuses it.
    folderOpen: false,
    face: null,
    laterTimer: null,
    doneNotices: [],                 // [{ id, project, at }] newest last
    // Lives in the clock island, so it is present in both the full and the minimal
    // bar and can be reordered or hidden like any other island element. Three
    // states and nothing more: absent when there is nothing to say, a quiet pulse
    // while a session works, and lit when one has finished and you have not looked
    // yet. Tapping it opens that session.
    topbarSig: '',
  };

  window.ClaudeWidgetConsoleState = { ui };
})();
