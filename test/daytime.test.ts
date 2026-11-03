import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertText, decodeState, initialState, resetAfterGap, transition } from '../src/alerts.ts';
import { validateConfig } from '../src/config.ts';
import { runMonitor } from '../src/monitor.ts';
import { config, harness, json } from './helpers.ts';
import { applyTelegramCommand } from '../src/telegram-settings.ts';

// Synthetic dates and installation; the timezone is explicit, never taken from the host.
const at = (local: string) => Date.parse(`2026-10-22T${local}:00+08:00`);
const policy = { timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 };
const daytime = () => ({ ...config(), daytimeDischarge: { ...policy } });
function sample(s: ReturnType<typeof initialState>, c: ReturnType<typeof daytime>, local: string, watts = 500, soc = 80) {
  const time = at(local);
  return transition(s, { at: time, soc, dischargeWatts: watts }, c, time);
}

test('daytime policy validates timezone, a same-day window and bounded whole-minute confirmation', () => {
  validateConfig(daytime());
  for (const invalid of [null, [], {}, { ...policy, timeZone: 'Invalid/Zone' },
    { ...policy, startHour: -1 }, { ...policy, endHour: 25 }, { ...policy, endHour: 6 },
    { ...policy, startHour: 6.5 }, { ...policy, minimumMinutes: 0 },
    { ...policy, minimumMinutes: 121 }, { ...policy, minimumMinutes: 1.5 }]) {
    assert.throws(() => validateConfig({ ...config(), daytimeDischarge: invalid }), /daytime_discharge_invalid/);
  }
});

test('daytime discharge waits for 15 minutes of distinct high samples and survives restart', () => {
  const c = daytime(); let s = initialState(c);
  sample(s, c, '10:00'); sample(s, c, '10:05'); sample(s, c, '10:10');
  assert.equal(s.pending.length, 0);
  s = decodeState(JSON.stringify(s), c);
  sample(s, c, '10:15');
  assert.deepEqual(s.pending.map(a => a.kind), ['discharge']);
  assert.match(alertText(s.pending[0], c), /Daytime battery use/);
  assert.match(alertText(s.pending[0], c), /spanning at least 15 minutes/);
  assert.match(alertText(s.pending[0], c), /06:00–18:00 Asia\/Manila/);
  assert.doesNotMatch(alertText(s.pending[0], c), /EV|weather|forecast/i);
  sample(s, c, '10:20'); assert.equal(s.pending.length, 1);
});

test('a brief cloud dip clears without alerting and later discharge needs a new full duration', () => {
  const c = daytime(), s = initialState(c);
  sample(s, c, '10:00'); sample(s, c, '10:05'); sample(s, c, '10:10', 0);
  sample(s, c, '10:15'); sample(s, c, '10:20'); sample(s, c, '10:25');
  assert.equal(s.pending.length, 0);
  sample(s, c, '10:30'); assert.equal(s.pending.length, 1);
});

test('duplicates, closely spaced samples and long gaps cannot satisfy 15 minutes', () => {
  const c = daytime(), s = initialState(c);
  sample(s, c, '10:00'); sample(s, c, '10:01');
  for (let n = 0; n < 5; n++) assert.equal(sample(s, c, '10:01'), 'duplicate');
  assert.equal(sample(s, c, '09:59'), 'out_of_order');
  assert.equal(s.pending.length, 0);
  sample(s, c, '10:20'); sample(s, c, '10:25');
  assert.equal(s.pending.length, 0);
  resetAfterGap(s, c, at('10:40'));
  sample(s, c, '10:40'); sample(s, c, '10:45');
  assert.equal(s.pending.length, 0);
});

test('nighttime is quiet, full alerts still work, and each new daytime window starts fresh', () => {
  const c = daytime(), s = initialState(c);
  sample(s, c, '05:40'); sample(s, c, '05:45'); sample(s, c, '05:50'); sample(s, c, '05:55');
  assert.equal(s.pending.length, 0);
  sample(s, c, '06:00'); sample(s, c, '06:05'); sample(s, c, '06:10');
  assert.equal(s.pending.length, 0);
  sample(s, c, '06:15'); assert.equal(s.pending.length, 1);
  s.pending = [];
  sample(s, c, '17:50', 0); sample(s, c, '17:55'); sample(s, c, '18:00', 500, 100);
  assert.deepEqual(s.pending.map(a => a.kind), ['full']);
  for (const minute of [0, 5, 10, 15]) {
    const time = Date.parse(`2026-10-23T06:${String(minute).padStart(2, '0')}:00+08:00`);
    transition(s, { at: time, soc: 80, dischargeWatts: 500 }, c, time);
  }
  assert.equal(s.pending.filter(a => a.kind === 'discharge').length, 1);
});

test('changing only daytime policy preserves the full latch and cancels old discharge advice', () => {
  const old = config(), s = initialState(old);
  transition(s, { at: at('10:00'), soc: 100, dischargeWatts: 500 }, old, at('10:00'));
  transition(s, { at: at('10:05'), soc: 100, dischargeWatts: 500 }, old, at('10:05'));
  assert.equal(s.pending.length, 2);
  const c = daytime(), restored = decodeState(JSON.stringify(s), c);
  assert.equal(restored.fullArmed, false);
  assert.deepEqual(restored.pending.map(a => a.kind), ['full']);
  sample(restored, c, '10:10', 500, 100); sample(restored, c, '10:15', 500, 100);
  assert.equal(restored.pending.filter(a => a.kind === 'discharge').length, 0);
  const removed = decodeState(JSON.stringify(restored), old);
  assert.equal(removed.fullArmed, false);
});

test('failed daytime deliveries do not retry after the configured window closes', async () => {
  const h = harness(daytime()); h.clock.time = at('17:40');
  let sends = 0;
  h.hook(url => url.endsWith('/sendMessage') ? (sends++, json({}, 503)) : undefined);
  for (let i = 0; i < 4; i++) {
    h.reading(80, 500); await runMonitor(h.env, h.deps); h.advance();
  }
  assert.equal(sends, 1);
  h.clock.time = at('18:00'); h.reading(80, 500, at('17:59'));
  await runMonitor(h.env, h.deps);
  assert.equal(sends, 1);
  assert.equal(JSON.parse(h.kv.data.get('monitor:v1')!).pending.length, 0);
});

test('a failed or invalid poll resets elapsed discharge confirmation', async () => {
  const h = harness(daytime()); h.clock.time = at('10:00');
  h.reading(80, 500); await runMonitor(h.env, h.deps);
  h.advance(); h.reading(80, 500); await runMonitor(h.env, h.deps);
  h.advance(); h.reading(80, Number.NaN); await runMonitor(h.env, h.deps);
  h.advance(); h.reading(80, 500); await runMonitor(h.env, h.deps);
  h.advance(); h.reading(80, 500); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 0);
});

test('settings expose the selected daytime window and actual confirmation duration', () => {
  const text = applyTelegramCommand(daytime(), '/settings').reply;
  assert.match(text, /06:00–18:00 Asia\/Manila/);
  assert.match(text, /15 minutes/);
});

test('a KV checkpoint crossing the end of daytime prevents delivery', async () => {
  const h = harness(daytime()); h.clock.time = at('17:44');
  for (let n = 0; n < 3; n++) {
    h.reading(80, 500); await runMonitor(h.env, h.deps); h.advance();
  }
  const put = h.kv.put.bind(h.kv);
  h.kv.put = async (key, value) => { await put(key, value); h.advance(60_000); };
  h.reading(80, 500); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 0);
  assert.equal(JSON.parse(h.kv.data.get('monitor:v1')!).pending.length, 0);
});
