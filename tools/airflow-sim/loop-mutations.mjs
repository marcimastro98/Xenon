// Breaks each rule of Airflow's engine once and checks the tests notice:
//   node tools/mutate/mutate.mjs tools/airflow-sim/loop-mutations.mjs
// Rerun after any change to server/airflow/loop*.js (loop-drivers.js, loop-learning.js too), sense.js, shadow.js,
// situation.js or drivers.js; every mutation must be caught.
const LOOP = 'server/airflow/loop.js';
const CHECK = 'server/airflow/loop-check.js';
const STATUS = 'server/airflow/loop-status.js';
const SENSE = 'server/airflow/sense.js';
const SHADOW = 'server/airflow/shadow.js';
const SITUATION = 'server/airflow/situation.js';
const DRIVERS = 'server/airflow/drivers.js';
const MODEL = 'server/js/airflow/airflow-model.js';
const PRIORITY = 'server/airflow/priority.js';
const SAVE = 'server/airflow/loop-save.js';
const AVAIL = 'server/airflow/loop-available.js';
const INDEX = 'server/airflow/index.js';
const CALLS = 'server/airflow/loop-drivers.js';
const LEARN = 'server/airflow/loop-learning.js';
const m = (file, name, from, to) => ({ name, file, from, to });

export default {
  tests: [
    'server/test/airflow-loop.test.mjs', 'server/test/airflow-shadow.test.mjs',
    'server/test/airflow-platform.test.mjs', 'server/test/airflow-store.test.mjs',
    'server/test/airflow-priority.test.mjs', 'server/test/airflow-available.test.mjs',
    'server/test/airflow-loop-drivers.test.mjs', 'server/test/airflow-loop-learning.test.mjs',
    'server/test/airflow-actions.test.mjs',
  ],
  mutations: [
    // What the engine writes, and when.
    m(LOOP, 'watching writes', "(model.drive === 'on' && model.mode !== 'pc')", "(model.drive !== 'off' && model.mode !== 'pc')"),
    m(LOOP, '"leave it to the PC" still drives', "(model.drive === 'on' && model.mode !== 'pc')", "(model.drive === 'on')"),
    m(LOOP, 'never handed back when it stops driving', '          if (letGo) await d.release();\n', ''),
    m(LOOP, 'handed back every second', 'if (letGo) await d.release();', 'await d.release();'),
    m(LOOP, 'a failing driver reported every second', 'if (!st.failing.has(d.id)) warn(', 'warn('),
    m(LOOP, 'watching judged like driving', 'const judged = watching ? driven.map((c) => ({ ...c, hasTach: false })) : driven;', 'const judged = driven;'),
    m(LOOP, 'shadow scored while driving', "if (out && model.drive === 'shadow') st.shadow", 'if (out) st.shadow'),
    m(LOOP, 'wear learned from the BIOS', 'out && !watching ? driven : []', 'out ? driven : []'),
    m(AVAIL, 'a dropped driver keeps its fans', '      for (const d of before) if (!st.usable.includes(d)) letGo(d).catch(() => {});\n', ''),
    m(LOOP, 'learning not saved at rest', '    holding(false);\n    await saves.all(st, clock());', '    holding(false);'),
    m(SAVE, 'learning saved only at the end', '      if (now - learnedAt >= SAVE_EVERY_MS) await learned(st, now);\n', ''),
    m(LOOP, 'keeps ticking switched off', '      timers.clearInterval(st.timer);\n      st.timer = null;\n      st.restDue = true;', '      st.restDue = true;'),
    m(LOOP, 'starts again after stop', '    if (st.stopping) return;\n    const model = store.peek();', '    const model = store.peek();'),
    m(LOOP, 'ticks with no driver', 'const need = drivers.length > 0 && (', 'const need = ('),
    m(LOOP, 'a check with no fans never ends', '    if (!list.length && now - st.wantedAt < CHECK_WAIT_MS) return;\n', '    if (!list.length) return;\n'),
    m(LOOP, 'two checks at once', "      if (st.check || st.wantedAt != null) return { ok: false, why: 'running' };\n", ''),
    m(LOOP, 'the person cannot call it off', "      st.check?.cancel('cancel');\n", ''),
    // The check inside the engine.
    m(CHECK, 'the check outside the safety layer', '  if (!view.done && why) view = check.cancel(why);\n', ''),
    m(CHECK, 'the hands\' guard ignored', 'firmware?.why || snap.guard', 'firmware?.why'),
    m(CHECK, 'a lost sensor ignored', ': firmware?.why || snap.guard;', ': snap.guard;'),
    m(CHECK, 'a fan left to the PC is moved', ' && !model.fans[f.id]?.leave', ''),
    m(CHECK, 'a read-only control is moved', 'f.controllable && ', ''),
    m(CHECK, 'a pump checked as a fan', "kinds.get(f.id) === 'pump' ? 'pump' : 'fan'", "'fan'"),
    m(CHECK, 'the card\'s floor lost', 'floor: Number.isFinite(f.min) ? f.min : 0,', 'floor: 0,'),
    m(CHECK, 'measurements not kept', 'for (const [id, calib] of Object.entries(result.calibs)) fans[id] =', 'for (const [id, calib] of []) fans[id] ='),
    m(CHECK, 'the guessed place lost', '(fans[id] || { place: places.get(id) })', '(fans[id] || {})'),
    m(CHECK, 'a fan with a problem keeps old measurements', '    for (const id of Object.keys(result.problems)) if (fans[id]) fans[id] = { ...fans[id], calib: null };\n', ''),
    m(CHECK, 'the check time not kept', 'check: { at, problems: result.problems }', 'check: m.check'),
    // What the menu is told.
    m(STATUS, 'off hides the fix', "  if (!answering) return 'unavailable';\n  if (model.drive === 'off') return 'off';", "  if (model.drive === 'off') return 'off';\n  if (!answering) return 'unavailable';"),
    m(STATUS, 'Xenon shown driving while watching', 'xenon: driving && v?.action', 'xenon: v?.action'),
    // One reading from every driver.
    m(SENSE, 'an older temperature wins', ' && !(snap.temps[k]?.at >= r.at)) snap.temps[k] = r;', ') snap.temps[k] = r;'),
    m(SENSE, 'negative power kept', 'if (finite(w) && w >= 0)', 'if (finite(w))'),
    m(SENSE, 'no reading time', '    if (finite(p.at) && !(snap.readAt >= p.at)) snap.readAt = p.at;\n', ''),
    m(SENSE, 'the first guard lost', 'snap.guard ??= p.guard || null;', 'snap.guard = p.guard || null;'),
    // The shadow score.
    m(SHADOW, 'a sleep counted whole', 'Math.min(MAX_TICK_MS, Math.max(0, at - lastAt))', 'Math.max(0, at - lastAt)'),
    m(SHADOW, 'a swing counted every second', 'if (moved && !s.changing) s.changes += 1;', 'if (moved) s.changes += 1;'),
    m(SHADOW, 'the plan scored as the PC', 'planned.push(finite(d) && ch.curve?.length ?', 'planned.push(false ?'),
    m(SHADOW, 'warm on any degree over', 'predicted[n] > targets[n] + WARM_BY', 'predicted[n] > targets[n]'),
    m(SHADOW, 'energy not weighted by time', 'if (Number.isFinite(db)) s.energy += 10 ** (db / 10) * dt;', 'if (Number.isFinite(db)) s.energy += 10 ** (db / 10);'),
    m(SHADOW, 'a broken save trusted', ' && raw.energy >= 0 && Number.isInteger(raw.changes)', ''),
    // What the brain hears.
    m(SITUATION, 'facts asked while off', "    if (!m || m.drive === 'off') return [];", '    if (!m) return [];'),
    m(SITUATION, 'calls read with quiet calls off', "if (m.options?.callQuiet !== false) any.push", 'any.push'),
    m(SITUATION, 'any program taken for a game', 'game: facts.game === true ? front : null,', 'game: front,'),
    m(SITUATION, 'names read every second', 'if (!reading && clock() - at >= LABELS_EVERY_MS) {', 'if (!reading) {'),
    m(SITUATION, 'a failed read drops the names', ".catch(() => { /* the names stay as they were; tried again in a minute */ })", ".catch(() => { names = {}; })"),
    // Which drivers a PC gets.
    m(DRIVERS, 'a mouse battery makes a laptop', "(await read('scope')) !== 'Device'", 'true'),
    m(DRIVERS, 'laptop read every time', 'isLaptop ??= laptop()', 'isLaptop = laptop()'),
    m(DRIVERS, 'a Mac gets the Linux driver', "  if (platform !== 'win32' && platform !== 'linux') return { drivers: [], none: 'platform', stop: () => {}, hubLights: () => null };\n", ''),
    m(DRIVERS, 'a huge note written', '      if (text.length > HELD_MAX_BYTES) return false;\n', ''),
    // The last check, as saved.
    m(MODEL, 'any problem code kept', 'isFanId(id) && CHECK_PROBLEMS.includes(code)', 'isFanId(id)'),
    m(MODEL, 'problems on bad ids kept', 'isFanId(id) && CHECK_PROBLEMS.includes(code)', 'CHECK_PROBLEMS.includes(code)'),
    m(MODEL, 'a check with no time kept', '    if (at == null) return null;\n', ''),
    m(LOOP, 'a choice waits a minute for the drivers', 'recheck() { st.availAt = -Infinity; },', 'recheck() {},'),
    m(LOOP, 'a check waits a minute for the drivers', '      st.availAt = -Infinity;\n      refresh();', '      refresh();'),
    m(LOOP, 'a check not counted as work', 'checking: () => st.check != null || st.wantedAt != null,', 'checking: () => st.check != null,'),
    m(DRIVERS, 'LINK hub taken with Airflow off', "return model.drive !== 'off' || checking;", 'return true;'),
    m(DRIVERS, 'LINK hub taken for the check only', "return model.drive !== 'off' || checking;", "return model.drive !== 'off';"),
    m(DRIVERS, 'LINK hub taken in Back to the PC', " || model.mode === 'pc') return false;", ') return false;'),
    m(DRIVERS, 'LINK hub taken without the option', 'if (model?.options?.linkHub !== true || ', 'if ('),
    // While it holds the fans the engine runs above normal (priority.js).
    m(LOOP, 'holding never told', '    if (st.driving !== on) onDriving(on);\n', ''),
    m(LOOP, 'holding told every tick', 'if (st.driving !== on) onDriving(on);', 'onDriving(on);'),
    m(LOOP, 'letting go at rest never told', '.catch(() => {})));\n    holding(false);', '.catch(() => {})));\n    st.driving = false;'),
    m(PRIORITY, 'never moves up', '          system.setPriority(0, ABOVE);\n', ''),
    m(PRIORITY, 'a higher engine moved down', '          if (now <= ABOVE) return;\n', ''),
    m(PRIORITY, 'never goes back', '          if (system.getPriority(0) === ABOVE) system.setPriority(0, was);\n', ''),
    m(PRIORITY, 'a later choice overridden', 'if (system.getPriority(0) === ABOVE) system.setPriority(0, was);', 'system.setPriority(0, was);'),
    m(PRIORITY, 'a refusal said every time', 'if (!told) warn(', 'warn('),
    // A driver waiting on the sensor service is asked again within seconds (loop-available.js).
    m(LOOP, 'the service waited on for a minute', ' || await availability.soon(st, now, recheck)', ''),
    m(AVAIL, 'every driver asked every few seconds', 'drivers.filter((d) => SOON_WHYS.includes(st.unavailable[d.id]))', 'drivers'),
    m(AVAIL, 'the waiting driver asked every tick', 'if (!soonAsking && now - soonAt >= SOON_EVERY_MS) {', 'if (!soonAsking) {'),
    m(AVAIL, 'an answer never taken up', 'if (a.some((x) => x.ok)) soonYes = true;', ''),
    // A slow check (a busy PC, 23 Nov 2026) never holds the tick; only a look waits for it.
    m(AVAIL, 'a slow check holds the tick', 'const wait = (p, all) => (all ? p : within(p, waitMs));', 'const wait = (p, _all) => p;'),
    m(AVAIL, 'a check asked again every tick', '      if (asking) return;\n', ''),
    m(AVAIL, 'a late answer told every time', '      soonYes = false;\n', ''),
    m(LOOP, 'the tick waits on every check', 'await availability.settle(st, recheck);', 'await availability.settle(st, true);'),
    // Each driver in its own time (loop-drivers.js): a hub stuck on USB never holds the board's
    // commands, and calls to one driver never overlap (23 Nov 2026).
    m(LOOP, 'the tick waits for every driver', 'const polls = await calls.poll(st.usable, recheck);', 'const polls = await Promise.all(st.usable.map((d) => d.poll().catch(() => null)));'),
    m(LOOP, 'let go during its call at rest', 'const release = (d) => calls.run(d, (x) => x.release());', 'const release = (d) => d.release();'),
    m(LOOP, 'letting go skips a busy driver', '    }, letGo);', '    }, false);'),
    m(LOOP, 'a dropped driver let go during its call', 'createAvailability({ drivers, letGo: release })', 'createAvailability({ drivers })'),
    m(CALLS, 'calls to one driver overlap', '(lines.get(d) || Promise.resolve()).then(() => fn(d))', 'Promise.resolve().then(() => fn(d))'),
    m(CALLS, 'a busy driver asked again', 'if (!busy(d)) await within(read(d), waitMs);', 'await within(read(d), waitMs);'),
    m(CALLS, 'a slow reading holds the tick', 'if (!busy(d)) await within(read(d), waitMs);', 'if (!busy(d)) await read(d);'),
    m(CALLS, 'a reading kept forever', 'return r && clock() - r.at <= STALE_MS ? r.value : null;', 'return r ? r.value : null;'),
    m(CALLS, 'a late reading never taken up', '.then((value) => { last.set(d, { value, at: clock() }); return value; });', '.then((value) => value);'),
    m(CALLS, 'a slow command holds the tick', 'await within(Promise.all(flights), waitMs);', 'await Promise.all(flights);'),
    m(CALLS, 'a command piled on a busy driver', 'drivers.filter((d) => queue || !busy(d))', 'drivers'),
    m(CALLS, 'letting go skips a busy driver (calls)', 'drivers.filter((d) => queue || !busy(d))', 'drivers.filter((d) => !busy(d))'),
    m(INDEX, 'the engine not wired to it', 'onDriving: enginePriority.holding, cpuName', 'cpuName'),
    // When the learning stops being true (loop-learning.js, 25 Nov 2026).
    m(LEARN, 'a replaced fan never noticed', '...st.health.swapped(), ', ''),
    m(LEARN, 'a replaced fan keeps its check', 'fans[id] = { ...fans[id], calib: null }; ', ''),
    m(LEARN, 'a replaced fan not told', " problems[id] = 'changed';", ''),
    m(LEARN, 'the last check time lost', 'at: m.check?.at ?? now', 'at: now'),
    m(LOOP, 'new parts not looked for during the check', '    await learning.settle(st, channels, now);', '    if (!st.check) await learning.settle(st, channels, now);'),
    m(LEARN, "a new card's fans checked since lose it", ' && !(m.fans[id].calib.at >= (checkedSince[id] ?? Infinity))', ''),
    m(LEARN, "a new card's first sighting forgotten", 'const since = again && Number.isFinite(prev.at) ? prev.at : now;', 'const since = now;'),
    m(LEARN, 'a new part never noticed', '      if (gone.length) forgetParts(st, gone.map((g) => g.node), now);\n', ''),
    m(LEARN, 'a new card counts at once', 'gpu: 2 }', 'gpu: 1 }'),
    m(LEARN, 'a card named another way is a new one', '!a.includes(b) && !b.includes(a)', 'a !== b'),
    m(LEARN, 'a name with no model number compared', '/\\d/.test(a) && /\\d/.test(b) && ', ''),
    m(LEARN, 'a card seen once, then the old one, still waits', '      delete next.pending[n];\n', ''),
    m(LEARN, 'a new part forgets every part', 'for (const n of gone) { delete brain[n];', 'for (const n of PARTS) { delete brain[n];'),
    m(LEARN, 'a new part keeps the brain', "    st.brain = null;\n    st.brainKey = '';\n    const brain", '    const brain'),
    m(LEARN, 'game heat kept after a new part', 'brain, games: {} }', 'brain }'),
    m(LEARN, "a new card's fans keep their check", "const card = gone.find((g) => g.node === 'gpu');", 'const card = undefined;'),
    m(LEARN, "a new processor's fans lose their check", "const card = gone.find((g) => g.node === 'gpu');", 'const card = gone[0];'),
    m(LEARN, 'learning from scratch keeps the brain', 'st.learned = { parts: st.learned?.parts };', 'st.learned = { ...st.learned };'),
    m(LEARN, "learning from scratch forgets the parts' names", 'st.learned = { parts: st.learned?.parts };', 'st.learned = {};'),
    m(LEARN, 'learning from scratch keeps the health', '      st.health = createHealth();\n', ''),
    m(LOOP, 'learning from scratch not saved', '      learning.forgetAll(st);\n      await saves.learned(st, clock());', '      learning.forgetAll(st);'),
    m(INDEX, 'the processor not named to the engine', 'onDriving: enginePriority.holding, cpuName,', 'onDriving: enginePriority.holding,'),
    m(INDEX, "the parts' names not given to the engine", ', parts: () => ({ cpu: cpuName, gpu: sensorReads.gpuCache.gpuName })', ''),
  ],
};
