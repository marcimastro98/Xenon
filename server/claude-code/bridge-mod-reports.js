'use strict';
// What the Xenon mod inside Claude Code may report, and which slash commands the tile may run:
// only the kinds listed here are taken, and a command only when it is one of the few known ones
// or one the session's own mod listed.

const { MAX_AGENT_TOKENS } = require('./bridge-limits.js');
const { str, num } = require('./bridge-clamp.js');
const { modMeasureAsStatus } = require('./bridge-mod.js');

function makeModReports({
  now, sessions, readings, modVersions, modCommandLists, modLastAt, commandsAsked, touchSession,
  agentEntry, endAgent, applyStatus, emit,
}) {
  const modCommands = (id) => {
    const m = /^(\d+)\.(\d+)/.exec(modVersions.get(id) || '');
    return !!m && (Number(m[1]) > 0 || Number(m[2]) >= 4);
  };

  function applyMod(data) {
    const d = (data && typeof data === 'object') ? data : {};
    if (d.v !== 1) return false;
    const id = str(d.sessionId, 80);
    if (!id) return false;
    readings.modSeen = { at: now(), version: str(d.version, 20) || (readings.modSeen ? readings.modSeen.version : '') };
    if (str(d.version, 20)) modVersions.set(id, str(d.version, 20));
    modLastAt.set(id, now());

    switch (d.kind) {
      case 'hello': {
        const model = str(d.model, 60);
        // The effort is what the session's last model request used, so it is
        // newer than any hook payload this server has kept (a restart loses those).
        const effort = EFFORT_LEVELS.has(str(d.effort, 20)) ? str(d.effort, 20) : '';
        touchSession(id, Object.assign(model ? { model } : {}, effort ? { effort } : {}));
        emit();
        return true;
      }
      case 'measure':
        // Same figures the statusline posts, in the mod's units; one reader.
        return applyStatus(modMeasureAsStatus(id, d));
      case 'commands': {
        const list = [];
        const seen = new Set();
        for (const c of Array.isArray(d.commands) ? d.commands : []) {
          const name = str(c && c.name, 80);
          if (!MOD_COMMAND_NAME.test(name) || seen.has(name) || NEVER_FROM_TILE.has(name)) continue;
          seen.add(name);
          list.push({ name, desc: str(c.description, 140) });
          if (list.length >= MAX_MOD_COMMANDS) break;
        }
        modCommandLists.set(id, { list, at: now() });
        emit();
        return true;
      }
      case 'agent': {
        const agentId = str(d.agentId, 60);
        const model = str(d.model, 60);
        if (!agentId || !model) return false;
        const s = touchSession(id, {});
        // The spawn can land before or after the SubagentStart hook: fill the
        // entry that exists, or start it so the hook finds it by id.
        const a = agentEntry(s, agentId, str(d.type, 40));
        a.model = model;
        const desc = str(d.description, 80);
        if (desc) a.desc = desc;
        emit();
        return true;
      }
      case 'agentStat': {
        // Numbers and levels only, as the mod promises.
        const agentId = str(d.agentId, 60);
        const s = agentId ? sessions.get(id) : null;
        if (!s) return false;
        // A report from an agent started before a restart opens its entry; a
        // late 'done' for one already gone does not bring it back.
        let a = s.subagents.find((x) => x.id === agentId);
        if (!a && d.done === true) return false;
        if (!a) a = agentEntry(s, agentId, '');
        const effort = str(d.effort, 10);
        if (EFFORT_LEVELS.has(effort)) a.effort = effort;
        const tokens = num(d.tokens);
        if (tokens != null && tokens > 0) a.tokens = Math.min(Math.round(tokens), MAX_AGENT_TOKENS);
        if (d.done === true) endAgent(a, '');
        emit();
        return true;
      }
      case 'delivery': {
        // A success only ends the "on its way" state a little sooner than
        // UserPromptSubmit would; a refusal offers the text back on the tile.
        // 'dropped' is a prompt hook's block, whose reason Claude Code shows in
        // the session; anything else is 'refused'.
        const s = sessions.get(id);
        if (!s || !s.handed) return false;
        const { text, started } = s.handed;
        s.handed = null;
        if (d.ok !== true) {
          s.undelivered = { text, reason: d.reason === 'dropped' ? 'dropped' : 'refused', at: now() };
          // Our own UserPromptSubmit hook fired alongside the one that blocked
          // it and marked a turn that never began. Nothing will send Stop.
          if (started && s.state === 'running') { s.state = 'idle'; s.turnOver = true; }
        }
        emit();
        return true;
      }
      default:
        return false;
    }
  }

  function modStatus() {
    return readings.modSeen ? { version: readings.modSeen.version, ageMs: now() - readings.modSeen.at } : null;
  }

  // The few commands the tile's header may run in an open session. The mod
  // (0.4.0) recognises the same shape and runs them with $.command.run; any
  // other "/" text is still just a message. Kept narrow on purpose: a model
  // name, an effort level, or a compact with optional focus text.
  const TILE_COMMAND = /^\/(?:(?:model|effort)[ ]+[A-Za-z0-9][A-Za-z0-9._\-\[\]]{0,39}|compact(?:[ ]+[^\r\n]{1,200})?)$/;
  // Any other command runs only when this session's own mod listed it (0.5.0+
  // sends the terminal's typeahead list), and never one that ends the session.
  const OTHER_COMMAND = /^\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,79})(?:[ ][^\r\n]{1,200})?$/;
  const MOD_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
  const NEVER_FROM_TILE = new Set(['exit', 'quit', 'logout', 'login']);
  const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
  const MAX_MOD_COMMANDS = 300;
  const isTileCommand = (id, text) => {
    if (TILE_COMMAND.test(text)) return true;
    const m = OTHER_COMMAND.exec(text);
    const have = modCommandLists.get(id);
    return !!(m && have && !NEVER_FROM_TILE.has(m[1]) && have.list.some((c) => c.name === m[1]));
  };
  // Ask a session's mod for its command list once per boot: a mod whose host has
  // no list (or an empty one) would otherwise be asked on every hello.
  function wantsCommandList(sessionId) {
    const id = str(sessionId, 80);
    if (!id || modCommandLists.has(id) || commandsAsked.has(id)) return false;
    commandsAsked.add(id);
    return true;
  }
  function commandListFor(sessionId) {
    const have = modCommandLists.get(str(sessionId, 80));
    return have ? have.list.slice() : null;
  }

  return { modCommands, applyMod, modStatus, isTileCommand, wantsCommandList, commandListFor };
}

module.exports = { makeModReports };
