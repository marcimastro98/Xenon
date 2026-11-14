'use strict';
// A permission or a plan held open until a person decides: asked, decided only by a tap that
// names it, and every other ending (time out, too many waiting, cancelled, handed back to the
// terminal) is no decision.

const {
  APPROVAL_TTL_MS, URGENT_AFTER_MS, MAX_PENDING, MAX_INPUT_CHARS, MAX_PLAN_CHARS, PLAN_MODES,
} = require('./bridge-limits.js');
const { str, num, projectName } = require('./bridge-clamp.js');
const { isDestructive, describeRisk } = require('./bridge-risk.js');
const { describeTool } = require('./bridge-describe.js');
const { describeQuestions, planFeedbackMessage } = require('./bridge-questions.js');
const { HANDBACK_MS, handBackKey } = require('./bridge-mod.js');

function makeApprovals({ options, now, sessions, pending, issued, setWait, clearWait, emit }) {
  // Claude Code's configured permissions.defaultMode, when the caller can read
  // it. Only used to decide whether a plan card offers auto mode for a session
  // that entered plan mode before we heard anything else from it.
  const defaultMode = () => {
    try { return typeof options.defaultMode === 'function' ? str(options.defaultMode(), 30) : ''; } catch { return ''; }
  };

  const handBacks = new Map();  // `session|tool` → when a mod approval was handed back

  // The "Yes" rows of Claude Code's plan dialog, in its order: auto mode when it
  // is available (else auto-accept edits), then manual approval. The terminal
  // knows for certain whether auto is available and a hook is not told, so the
  // evidence is what this session has shown us, then the user's default mode.
  function planChoices(s) {
    const autoOk = !!(s && (s.sawAuto || s.prePlanMode === 'auto')) || defaultMode() === 'auto';
    return [autoOk ? 'auto' : 'acceptEdits', 'default'];
  }

  // ── blocking permission requests ───────────────────────────────────────────
  // Returns { id, promise }. The promise resolves to 'allow' | 'deny' | 'timeout'.
  // 'timeout' means WE decline to answer, so the caller must respond in a way
  // that hands the choice back to Claude Code's own terminal prompt — never an
  // implicit allow.
  // `opts.ttlMs` shortens the wait (the mod's approvals hand back to the
  // terminal after it); `opts.fromMod` marks a request whose expiry must not
  // become a second card when Claude Code's own PermissionRequest hook, which
  // runs right after the mod gives up, asks about the same call (takeHandBack).
  function requestPermission(data, opts) {
    const o = opts || {};
    const ttlMs = Math.max(5000, Math.min(APPROVAL_TTL_MS, num(o.ttlMs) || APPROVAL_TTL_MS));
    const d = (data && typeof data === 'object') ? data : {};
    const sessionId = str(d.session_id, 80);
    const tool = str(d.tool_name, 60) || 'tool';
    const isPlanTool = tool === 'ExitPlanMode';
    const questions = tool === 'AskUserQuestion' ? describeQuestions(d.tool_input) : null;
    // What is being approved, in full. When it does not fit on the card, the
    // card would show a harmless start while the rest ran unseen (an 800
    // character `echo` followed by `; curl … | sh`), so the decision goes
    // back to Claude Code's own terminal prompt, which shows all of it. The
    // risk labels and the hold-to-confirm judge the full text, never the cut.
    const full = describeTool(tool, d.tool_input, Number.MAX_SAFE_INTEGER, true);
    if (!isPlanTool && !questions && full.length > MAX_INPUT_CHARS) return null;
    const detail = full;

    // Too many already waiting → refuse to queue another. The caller hands this
    // back to the terminal rather than letting the tile become a backlog.
    if (pending.size >= MAX_PENDING) return null;

    const s = sessions.get(sessionId);
    const isPlan = tool === 'ExitPlanMode';
    if (s) { setWait(s, 'permission', isPlan ? 'plan' : (detail || tool)); s.lastAt = now(); }

    const id = 'p' + (++issued.seq) + '-' + now().toString(36);
    const createdAt = now();
    const rec = {
      id,
      sessionId,
      // 'plan' is a permission with the terminal's plan-dialog choices instead
      // of Allow/Deny: approving one is only possible with the input echoed and
      // a mode chosen (header note 2), so it is its own kind, not a flag.
      kind: isPlan ? 'plan' : 'permission',
      project: (s && s.project) || projectName(d.cwd),
      tool,
      detail,
      questions,
      // ExitPlanMode's whole payload is the plan the user is being asked to
      // approve. Showing "ExitPlanMode" and an Allow button over it asked the
      // user to approve something they could not read.
      plan: isPlan ? str(d.tool_input && d.tool_input.plan, MAX_PLAN_CHARS) : '',
      choices: isPlan ? planChoices(s) : null,
      // Server-side only: the input exactly as Claude Code sent it, to echo back.
      input: isPlan && d.tool_input && typeof d.tool_input === 'object' && !Array.isArray(d.tool_input) ? d.tool_input : {},
      risks: describeRisk(tool, detail, (s && s.cwd) || str(d.cwd, 400)),
      task: (s && s.task) || '',
      model: (s && s.model) || '',
      createdAt,
      expiresAt: createdAt + ttlMs,
      urgentAt: isDestructive(tool, detail) ? createdAt : createdAt + Math.min(URGENT_AFTER_MS, ttlMs / 2),
      handBackKey: o.fromMod ? handBackKey(sessionId, tool) : '',
      resolve: null,
      timer: null,
    };

    const promise = new Promise((resolve) => { rec.resolve = resolve; });
    rec.timer = setTimeout(() => {
      if (pending.get(id) !== rec) return;
      pending.delete(id);
      clearWait(s, 'permission');
      if (rec.handBackKey) handBacks.set(rec.handBackKey, now());
      rec.resolve({ verdict: 'timeout' });
      emit();
    }, ttlMs);
    if (typeof rec.timer.unref === 'function') rec.timer.unref();

    pending.set(id, rec);
    emit();
    return { id, promise };
  }

  // The user tapped. Returns true when this actually settled a live request —
  // a stale tap (already expired, or answered on another surface) returns false
  // so the caller can tell the surface its decision arrived too late.
  //
  // For a plan, `opts.mode` is the row the user picked (one of rec.choices; an
  // unknown or missing one means the first, which is also the terminal's
  // default row) and `opts.feedback` is what to change when they send it back.
  function decide(id, behavior, opts) {
    const rec = pending.get(str(id, 80));
    if (!rec) return false;
    // A question is not a permission and is never settled by Allow/Deny — it
    // has its own answer path, which carries the choice. Routing it here would
    // reintroduce exactly the card that could not do what it showed.
    if (rec.kind === 'question') return false;
    const o = opts && typeof opts === 'object' ? opts : {};
    const verdict = behavior === 'allow' ? 'allow' : 'deny';
    let out = { verdict };
    if (rec.kind === 'plan') {
      if (verdict === 'allow') {
        const want = str(o.mode, 30);
        const mode = PLAN_MODES.has(want) && rec.choices.indexOf(want) !== -1 ? want : rec.choices[0];
        out = {
          verdict,
          updatedInput: rec.input,
          updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }],
        };
      } else {
        out = { verdict, message: planFeedbackMessage(o.feedback) };
      }
    }
    pending.delete(rec.id);
    if (rec.timer) clearTimeout(rec.timer);
    const s = sessions.get(rec.sessionId);
    clearWait(s, 'permission');
    if (s) s.lastAt = now();
    rec.resolve(out);
    emit();
    return true;
  }

  // Claude Code went away while we were waiting (Ctrl-C, or it cancelled the
  // hook). Drop the request without resolving a decision — nobody is listening
  // for one, and leaving it on the tile would invite a tap that goes nowhere.
  function cancel(id) {
    const rec = pending.get(str(id, 80));
    if (!rec) return false;
    pending.delete(rec.id);
    if (rec.timer) clearTimeout(rec.timer);
    if (rec.handBackKey) handBacks.set(rec.handBackKey, now());
    const s = sessions.get(rec.sessionId);
    clearWait(s, rec.kind === 'question' ? 'question' : 'permission');
    if (rec.resolve) rec.resolve({ verdict: rec.kind === 'question' ? 'skip' : 'timeout' });
    emit();
    return true;
  }

  // The mod asked about this call and got no answer in its short wait, so it
  // let Claude Code go on, and the next thing Claude Code runs is the
  // PermissionRequest hook link() installed, about the same call. Answering
  // that one with "no decision" is the hand back to the terminal the user was
  // promised; a second card waiting 9 minutes would break it. PermissionRequest
  // carries no call id, so the session and tool, seconds apart, identify it.
  // A mod card still pending for that pair (the mod gave up first) is withdrawn.
  function takeHandBack(data) {
    const d = (data && typeof data === 'object') ? data : {};
    const key = handBackKey(str(d.session_id, 80), str(d.tool_name, 60) || 'tool');
    for (const rec of pending.values()) if (rec.handBackKey === key) cancel(rec.id);
    const t = now();
    for (const [k, at] of handBacks) if (t - at > HANDBACK_MS) handBacks.delete(k);
    if (!handBacks.has(key)) return false;
    handBacks.delete(key);
    return true;
  }

  return { requestPermission, decide, cancel, takeHandBack };
}

module.exports = { makeApprovals };
