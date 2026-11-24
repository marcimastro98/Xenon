// Breaks each rule of Airflow's drivers and watchdog once and checks the tests notice:
//   node tools/mutate/mutate.mjs tools/airflow-sim/drivers-mutations.mjs
// Rerun after any change to server/airflow/driver-*.js (the LINK hub too), fan-files*.js, watchdog.js,
// server/engine/thread-pool.js or the sensor service's reader.js; every mutation must be caught.
const LHM = 'server/airflow/driver-lhm.js';
const HW = 'server/airflow/driver-hwmon.js';
const WD = 'server/airflow/watchdog.js';
const LINK = 'server/airflow/driver-link.js';
const BUSY = 'server/airflow/link-busy.js';
const FILES = 'server/airflow/fan-files.js';
const FILES_WORKER = 'server/airflow/fan-files-worker.js';
const POOL = 'server/engine/thread-pool.js';
const READER = 'server/sensor-service/reader.js';
const m = (file, name, from, to) => ({ name, file, from, to });

export default {
  tests: [
    'server/test/airflow-driver-lhm.test.mjs',
    'server/test/airflow-driver-hwmon.test.mjs',
    'server/test/airflow-watchdog.test.mjs',
    'server/test/airflow-driver-link.test.mjs',
    'server/test/airflow-fan-files.test.mjs',
    'server/test/engine-thread-pool.test.mjs',
  ],
  mutations: [
    m(LHM, 'lhm: a card fan at 0 written as its minimum', '|| (c.zeroByDefault && v.duty <= 0)) continue;', ') continue;'),
    // Windows: the names the service obeys.
    // service.reading's own age filter is only a second guard since 23 Nov 2026: the age check in poll()
    // decides (the two mutations on stillWriting below), so loosening the filter changes nothing.
    // A read the antivirus holds (23 Nov 2026): never waited on, one at a time, the last answer kept while the service writes.
    m(LHM, 'lhm: a slow read holds the tick', 'await within(read(), readWaitMs);', 'await read();'),
    m(LHM, 'lhm: reads stacked', 'reading ??= files.readJson(', 'reading = files.readJson('),
    m(LHM, 'lhm: a late answer kept forever', '    if (now() - last.at > LATE_OK_MS) return false;\n', ''),
    m(LHM, 'lhm: kept although the service stopped writing', 'return now() - (await files.stat(fanJson)).mtimeMs <= FRESH_MS;', 'return true;'),
    m(LHM, 'lhm: an old fan.json read as new', 'parseStatus(sensorService.freshData(o, FRESH_MS, now()))', 'parseStatus(o?.data)'),
    m(LHM, 'lhm: guarded readings unmarked', '...(GUARDED_TEMPS.includes(key) ? { guarded: true } : {})', ''),
    m(LHM, 'lhm: every reading guarded', 'GUARDED_TEMPS.includes(key) ? { guarded: true } : {}', '{ guarded: true }'),
    m(LHM, 'lhm: any id', ' || !LHM_ID_RE.test(c.id) ||', ' ||'),
    m(LHM, 'lhm: floor over ceiling', ' || min > max ||', ' ||'),
    m(LHM, 'lhm: firmware sent as a duty', "if (v?.action !== 'set' || !Number.isFinite(v.duty) || (c.zeroByDefault && v.duty <= 0)) continue;", 'if (!Number.isFinite(v?.duty)) continue;'),
    m(LHM, 'lhm: duty out of range', 'Math.min(100, Math.max(0, Math.round(', '((Math.round('),
    m(LHM, 'lhm: a name past the limit', 'if (name.length + part.length > MAX_NAME) break;', ''),
    m(LHM, 'lhm: old names pile up', 'if (old && old !== name) await files.unlink(path.join(fanDir, old)).catch(() => {});', ''),
    // Its commands on a thread of their own (fan-files.js): a full libuv pool and a held read of
    // fan.json never hold a command (23 Nov 2026); the thread lives only while asked.
    m(FILES, 'files: fan.json read on the commands\' thread', '(/** @type {string} */ file) => readJsonFile(file),', "(/** @type {string} */ file) => thread.call('list', file).then(() => readJsonFile(file), () => readJsonFile(file)),"),
    m(FILES, 'files: a command through the pool', "create: (/** @type {string} */ file) => thread.call('create', file),", "create: (/** @type {string} */ file) => require('node:fs').promises.writeFile(file, '', { flag: 'wx' }),"),
    m(FILES, 'files: a stopped thread never replaced', '    worker = null;\n    for (const p of pending.values())', '    for (const p of pending.values())'),
    m(FILES, 'files: close leaves the thread', '      if (w) await w.terminate();\n', ''),
    m(FILES, 'files: an idle thread kept', '      worker = null;\n      void w.terminate();\n', ''),
    m(FILES, 'files: a call leaves the idle clock running', '      if (idle) { clearTimeout(idle); idle = null; }\n      if (!worker) worker = start();', '      if (!worker) worker = start();'),
    m(FILES_WORKER, 'files: a name already there written through', "fs.writeFileSync(file, '', { flag: 'wx' });", "fs.writeFileSync(file, '');"),
    m(READER, 'files: any size read', 'if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;', 'if (!st.isFile()) return null;'),
    // The engine's shared pool sized before its first use (thread-pool.js).
    m(POOL, 'pool: left at four', 'process.env.UV_THREADPOOL_SIZE = String(poolSize());\n', ''),
    m(POOL, 'pool: any size from the environment', 'Number.isInteger(own) && own >= 1 && own <= 1024 ? own : POOL_SIZE', 'own || POOL_SIZE'),
    m(LHM, 'lhm: clear deletes anything', 'names.filter((n) => NAME_RE.test(n))', 'names'),
    // Linux: the pwm files.
    m(HW, 'hwmon: write without a save', 'if (!saved) { held.delete(c.id); return false; }', ''),
    m(HW, 'hwmon: a card stopped by Xenon', 'zeroByDefault: gpu,', 'zeroByDefault: false,'),
    m(HW, 'hwmon: mode not given back', '      await fsp.writeFile(h.files.enable, String(h.enable));\n', ''),
    m(HW, 'hwmon: a failed value stops the mode', "try { await fsp.writeFile(h.files.pwm, String(h.raw)); } catch { /* the mode below matters more */ }", 'await fsp.writeFile(h.files.pwm, String(h.raw));'),
    m(HW, 'hwmon: a failed write keeps the fan', '    } catch {\n      await giveBack(c.id);\n      return false;', '    } catch {\n      return false;'),
    m(HW, 'hwmon: same duty rewritten', 'if (raw !== c.raw) {', 'if (true) {'),
    m(HW, 'hwmon: renumbering not noticed', 'for (const c of chips) if ((await realDir(fsp, c.dir)) !== c.real) { await rescan(); break; }', ''),
    m(HW, 'hwmon: renumbering not followed', 'for (const ch of found) if (held.has(ch.id)) held.get(ch.id).files = ch.files;', ''),
    m(HW, 'hwmon: release without a look', 'if (held.size) await poll();', ''),
    m(HW, 'hwmon: a gone chip kept', 'for (const id of [...held.keys()]) if (!listed.has(id)) { held.delete(id); watchdog?.free(id); }', ''),
    m(HW, 'hwmon: clear on any boot', 'saved.boot === (await bootId())', 'true'),
    m(HW, 'hwmon: clear to any file', 'if (!isPwmFile(root, h?.files?.pwm) || !isPwmFile(root, h?.files?.enable)) continue;', ''),
    m(HW, 'hwmon: clear any value', 'h.raw > 255', 'h.raw > 9999'),
    m(HW, 'hwmon: any file under the root', String.raw`/^hwmon\d{1,3}\/pwm\d{1,2}(?:_enable)?$/`, String.raw`/^hwmon\d{1,3}\/.+$/`),
    // The watchdog.
    m(WD, 'watchdog: any file', 'isPwmFile(root, p[0])', "typeof p[0] === 'string'"),
    m(WD, 'watchdog: any value', 'p[1] >= 0 && p[1] <= 255', 'p[1] >= 0'),
    m(WD, 'watchdog: one bad pair lets the rest in', 'if (pairs.length !== msg.restore.length) return false;', ''),
    m(WD, 'watchdog: unbounded', 'if (!held.has(id) && held.size >= MAX_HELD) return false;', ''),
    m(WD, 'watchdog: stops at the first failed write', 'try { write(file, String(value)); } catch { /* the next one may still go back */ }', 'write(file, String(value));'),
    m(WD, 'watchdog: a closed pipe ignored', "  process.stdin.on('end', finish);\n  process.stdin.on('close', finish);\n", ''),
    m(WD, 'watchdog: not started again', 'if (!child && held.size) start();', ''),
    m(WD, 'watchdog: started again knowing nothing', 'for (const [id, restore] of held) send({ op: \'hold\', id, restore });', ''),
    m(WD, 'watchdog: started again in a tight loop', 'now() - startedAt < RESPAWN_MS', 'false'),
    // The iCUE LINK hub.
    m(LINK, 'link: a pump under its floor', "Math.max(c.kind === 'pump' ? PUMP_FLOOR : 0, v.duty)", 'Math.max(0, v.duty)'),
    m(LINK, 'link: no liquid reading kept low', '  if (!Number.isFinite(liquid)) return 100;\n', ''),
    m(LINK, 'link: a hot liquid leaves the pump low', 'return liquid >= STAND_IN.fullC ? 100 : STAND_IN.pump;', 'return STAND_IN.pump;'),
    m(LINK, 'link: kept when no longer wanted', '      if (s) await release();\n', ''),
    m(LINK, 'link: taken while iCUE runs', 'if (yielding(inTheWay) || inTheWay.length)', 'if (yielding(inTheWay))'),
    m(LINK, 'link: fights another program', '    if (!other) return false;\n', '    return false;\n'),
    m(LINK, 'link: taken again at once', '    yieldUntil = at + YIELD_MS;\n', ''),
    m(LINK, 'link: released in software mode', '    if (s) await s.hardware().catch(() => {});\n', ''),
    m(LINK, 'link: speeds not given to the check', 'tachs: Object.fromEntries(channels.map((c) => [c.tach, c.rpm])),', 'tachs: {},'),
    m(LINK, 'link: no slow settle', ' tach, settleMs: LINK_SETTLE_MS,', ' tach,'),
    m(LINK, 'link: radiator with any number of fans', 'pumps === 1 && fans <= RADIATOR_MAX_FANS', 'pumps === 1'),
    m(LINK, 'link: radiator without a pump', 'pumps === 1 && fans <= RADIATOR_MAX_FANS', 'pumps <= 1 && fans <= RADIATOR_MAX_FANS'),
    m(LINK, 'link: an unknown device driven', "    if (info.kind === 'other') continue;\n", ''),
    m(LINK, "link: the hub's own air read as the liquid", "linkDevice(d.type, d.model).kind === 'pump' && temps.has(d.channel)", 'temps.has(d.channel)'),
    m(LINK, 'link: iCUE starting while held not looked for', '      if (await tookBack(link, at) || await othersStarted(at)) return null;', '      if (await tookBack(link, at)) return null;'),
    m(LINK, 'link: looked for at every poll', 'if (!checking && at - checkedAt >= HELD_CHECK_MS) {', 'if (!checking) {'),
    m(LINK, 'link: a failed look lets go', "others = seen.filter((app) => app !== 'unknown');", 'others = seen;'),
    m(LINK, 'link: a slow look holds the poll', 'if (checking) await within(checking, HELD_CHECK_WAIT_MS);', 'if (checking) await checking;'),
    m(LINK, 'link: iCUE started, hub not given back', '    others = [];\n    await release();', '    others = [];'),
    m(LINK, 'link: iCUE started, no step aside', '    yieldUntil = now() + YIELD_MS;\n    yieldTo = others;', '    yieldTo = others;'),
    m(BUSY, 'busy: the table ignored', 'if (Array.isArray(rows) && rows.length) {', 'if (false) {'),
    m(BUSY, 'busy: an empty table read as nobody', 'if (Array.isArray(rows) && rows.length) {', 'if (Array.isArray(rows)) {'),
    m(BUSY, 'busy: the table names compared raw', 'names.has(processKey(app))', 'names.has(app)'),
  ],
};
