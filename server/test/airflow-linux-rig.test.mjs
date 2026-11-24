// The pretend board behind Airflow's Linux rig (tools/airflow-live/fake-hwmon.mjs) and
// how the rig mounts it. The rig is only as true as this board: a fan that answers
// its pwm, a 3-pin one that does not, a chip curve that runs while pwm_enable is not 1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO, MANUAL, FANS, chipDuty, initialBoard, step, targetRpm } from '../../tools/airflow-live/fake-hwmon.mjs';
import { DOCKER_ARGS, HWMON, containerScript } from '../../tools/airflow-live/linux-rig.mjs';

const still = () => 0.5;
const none = { pwm: [null, null, null], enable: [null, null, null], load: 0.25, hot: false };
const run = (board, wrote, seconds) => {
  let b = board;
  let out = null;
  for (let t = 0; t < seconds * 4; t += 1) { out = step(b, wrote, 0.25, still); b = out.board; }
  return out;
};

test('rig board: the chip curve is 30 % cool and 100 % hot', () => {
  assert.equal(chipDuty(30), 30);
  assert.equal(chipDuty(40), 30);
  assert.equal(chipDuty(60), 65);
  assert.equal(chipDuty(80), 100);
  assert.equal(chipDuty(95), 100);
});

test('rig board: on its own curve the chip writes pwm from the heat', () => {
  const out = step(initialBoard(), none, 0.25, still);
  assert.deepEqual(out.board.enable, [AUTO, AUTO, AUTO]);
  const expected = Math.round((chipDuty(initialBoard().temp) * 255) / 100);
  assert.deepEqual(out.shown.pwm, [expected, expected, expected]);
});

test('rig board: in manual a 4-pin fan follows its pwm at its own pace, a 3-pin one does not', () => {
  const wrote = { ...none, pwm: [255, 0, 0], enable: [MANUAL, MANUAL, MANUAL] };
  const first = step(initialBoard(), wrote, 1, still);
  assert.ok(first.board.rpm[0] - initialBoard().rpm[0] <= 400, 'no faster than 400 rpm a second');
  const out = run(initialBoard(), wrote, 20);
  assert.equal(out.shown.rpm[0], FANS[0].max, 'full duty, full speed');
  assert.equal(out.shown.rpm[1], 0, 'under its start duty a fan stops');
  assert.equal(out.shown.rpm[2], FANS[2].max, 'a 3-pin fan ignores pwm');
  assert.equal(targetRpm(FANS[1], 50), FANS[1].max * (0.15 + 0.85 * 0.5));
});

test('rig board: the CPU heats with load, cools with air, and runs at 95 when told hot', () => {
  const slow = run(initialBoard(), { ...none, load: 0.9, pwm: [0, 0, 0], enable: [MANUAL, MANUAL, MANUAL] }, 90);
  const fast = run(initialBoard(), { ...none, load: 0.9, pwm: [255, 255, 255], enable: [MANUAL, MANUAL, MANUAL] }, 90);
  assert.ok(fast.board.temp < slow.board.temp - 10, `${fast.board.temp} vs ${slow.board.temp}`);
  const hot = run(initialBoard(), { ...none, hot: true }, 15);
  assert.ok(hot.board.temp > 94, String(hot.board.temp));
  assert.equal(hot.shown.temp, Math.round(hot.board.temp * 1000), 'millidegrees, as the kernel writes');
});

test('rig: the board sits where the kernel keeps it, owned by the container user, and the scenario runs as that user', () => {
  assert.equal(HWMON, '/sys/class/hwmon');
  assert.deepEqual([...DOCKER_ARGS], ['--tmpfs', '/sys/class/hwmon:uid=1000,gid=1000,mode=0755']);
  assert.match(containerScript(), /su node -c ".*linux-rig\.mjs --inside"/);
});
