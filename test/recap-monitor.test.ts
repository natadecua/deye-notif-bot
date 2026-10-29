import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { config, harness, json, BASE_TIME } from './helpers.ts';
import { runMonitor } from '../src/monitor.ts';
import { initialState, decodeState, transition } from '../src/alerts.ts';
import { validateConfig } from '../src/config.ts';
import { advanceDailyRecap } from '../src/daily-recap.ts';
import { advanceDataHealth } from '../src/data-health.ts';
import { decodeBotState, SESSION_MS } from '../src/bot-state.ts';
import { prepareDeployment } from '../scripts/ci-deploy.ts';
import type { Config } from '../src/types.ts';

// Synthetic installation, schedule, readings, metadata and intercepted services only.
const minute = 60000, day = 24 * 60 * minute, start = BASE_TIME;
const policy = { enabled: true as const, timeZone: 'UTC', hour: 12, minute: 0, scheduleConfirmed: true as const };
const settings = (extra: Partial<Config> = {}) => ({ ...config(extra), dailyRecap: { ...policy } });
function metadata(c = settings(), at = start) {
  const r = advanceDailyRecap(c, c.dailyRecap, undefined, at - day); assert.equal(r.status, 'ok'); return r.state;
}
function queued(c = settings(), at = start) {
  const r = advanceDailyRecap(c, c.dailyRecap, metadata(c, at), at); assert.equal(r.status, 'ok'); assert(r.candidate);
  return { state: r.state, alert: { kind: 'recap', slot: r.candidate,
    id: `recap:${r.candidate.localDate}:${r.candidate.dueAt}`, createdAt: r.candidate.dueAt, attempts: 0, nextAttemptAt: at } };
}
const saved = (h: ReturnType<typeof harness>) => JSON.parse(h.kv.data.get('monitor:v1')!);
function setup(c = settings(), at = start) {
  const h = harness(c); h.clock.time = at;
  const source = at - 700000;
  const state = { ...initialState(c), fullArmed: false, dischargeArmed: false,
    lastReadingAt: source, latestReading: { at: source, soc: 55, dischargeWatts: 315 },
    dailyRecap: metadata(c, at), apiRetryAt: at + 3600000 };
  h.kv.data.set('monitor:v1', JSON.stringify(state));
  const reads: string[] = [], times: number[] = [], get = h.kv.get.bind(h.kv), put = h.kv.put.bind(h.kv);
  h.kv.get = async key => { reads.push(key); return get(key); };
  h.kv.put = async (key, value) => { times.push(h.clock.time); return put(key, value); };
  return { ...h, reads, times };
}
function seed(h: ReturnType<typeof harness>, extra: Record<string, unknown>) {
  h.kv.data.set('monitor:v1', JSON.stringify({ ...saved(h), ...extra }));
}
const messages = (h: ReturnType<typeof harness>) => h.calls.filter(c => c.url.endsWith('/sendMessage'))
  .map(c => JSON.parse(String(c.init?.body)) as { text: string; reply_markup?: unknown });
function battery(kind: 'full' | 'discharge', at = start) {
  return { kind, id: `${kind}:${at}`, createdAt: at, attempts: 0, nextAttemptAt: at,
    reading: { at, soc: 100, dischargeWatts: 400 } };
}
function health(c: Config, at = start, due = true) {
  const first = advanceDataHealth(c, undefined, { kind: 'idle' }, at - (due ? 31 * minute : 0));
  assert.equal(first.status, 'ok');
  const r = due ? advanceDataHealth(c, first.state, { kind: 'idle' }, at) : first; assert.equal(r.status, 'ok');
  return r;
}
const healthSettings = () => settings({ dataHealth: { enabled: true, warnAfterMinutes: 30,
  delivery: 'all-hours', allHoursConfirmed: true } });

test('recap runtime configuration validates explicit consent and rejects partial/mismatched policies', () => {
  const c = settings(); assert.equal(validateConfig(c), c);
  for (const dailyRecap of [null, { ...policy, scheduleConfirmed: false }, { ...policy, minute: 1 },
    { ...policy, token: 'synthetic-private-sentinel' }]) {
    assert.throws(() => validateConfig({ ...c, dailyRecap }), /^SafeError: daily_recap_config_invalid$/);
  }
  assert.throws(() => validateConfig({ ...c, daytimeDischarge: {
    timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 } }), /daily_recap_config_invalid/);
});

test('due recap during cooldown uses two spaced checkpoints and only one Telegram request', async () => {
  const c = settings({ weather: { enabled: true, latitude: 10, longitude: 20, nonCommercialConfirmed: true } }), h = setup(c);
  const before = saved(h); await runMonitor(h.env, h.deps);
  assert.equal(messages(h).length, 1); const message = messages(h)[0];
  assert.match(message.text, /Battery snapshot · daily recap/); assert.match(message.text, /stale — not current/);
  assert.match(message.text, /Charge: 55%/); assert.match(message.text, /EV charging: unknown/);
  assert.doesNotMatch(message.text, /\/(?:status|settings)|reduce|overnight exception|synthetic-private/);
  assert.equal(message.reply_markup, undefined); assert.deepEqual(h.reads, ['monitor:v1']);
  assert.equal(h.calls.length, 1); assert.equal(h.kv.puts.length, 2); assert(h.times[1] - h.times[0] >= 1100);
  assert.equal(saved(h).apiRetryAt, before.apiRetryAt); assert.equal(saved(h).fullArmed, false);
  assert.equal(saved(h).dailyRecap.resolvedDay, '2026-10-21'); assert.deepEqual(saved(h).pending, []);
  h.advance(5 * minute); await runMonitor(h.env, h.deps); assert.equal(messages(h).length, 1);
});

test('first recap activation silently consumes today and preserves legacy battery cycles', async () => {
  const h = setup(); const s = saved(h); delete s.dailyRecap; h.kv.data.set('monitor:v1', JSON.stringify(s));
  await runMonitor(h.env, h.deps); assert.equal(messages(h).length, 0);
  assert.equal(saved(h).dailyRecap.resolvedDay, '2026-10-21'); assert.equal(h.kv.puts.length, 1);
  assert.equal(saved(h).fullArmed, false); assert.equal(saved(h).dischargeArmed, false);
});

test('a failed Deye poll still sends a labelled cached recap without releasing queued battery advice', async () => {
  const h = setup(); seed(h, { apiRetryAt: 0, pending: [battery('full')] });
  h.hook(url => url.includes('/station/latest') ? json({ body: 'synthetic-private-upstream' }, 503) : undefined);
  await runMonitor(h.env, h.deps);
  assert.equal(messages(h).length, 1); assert.match(messages(h)[0].text, /daily recap/);
  assert.doesNotMatch(messages(h)[0].text, /House battery full|synthetic-private|reduce/);
  assert.equal(saved(h).pending[0].kind, 'full'); assert(saved(h).apiRetryAt > start);
  assert(h.kv.puts.length <= 3); assert(h.calls.length <= 9);
});

test('fresh normal polling sends battery first and a current recap second inside shared operation caps', async () => {
  const h = setup(); seed(h, { apiRetryAt: 0, fullArmed: true }); h.reading(100, 0);
  await runMonitor(h.env, h.deps);
  assert.equal(messages(h).length, 2); assert.match(messages(h)[0].text, /House battery full/);
  assert.match(messages(h)[1].text, /daily recap/); assert.match(messages(h)[1].text, /Charge: 100%/);
  assert.match(messages(h)[1].text, /within freshness limit/);
  assert.equal(h.kv.puts.filter(p => p.key === 'monitor:v1').length, 2); assert(h.kv.puts.length <= 3);
  assert.equal(saved(h).fullArmed, false); assert.deepEqual(saved(h).pending, []);
});

test('health precedes recap during cooldown with two sends and one shared result checkpoint', async () => {
  const c = healthSettings(), h = setup(c), first = advanceDataHealth(c, undefined, { kind: 'idle' }, start - 31 * minute);
  assert.equal(first.status, 'ok'); seed(h, { dataHealth: first.state });
  await runMonitor(h.env, h.deps);
  assert.equal(messages(h).length, 2); assert.match(messages(h)[0].text, /Battery updates delayed/);
  assert.match(messages(h)[1].text, /daily recap/); assert.equal(h.kv.puts.length, 2);
  assert(h.calls.every(c => c.url.endsWith('/sendMessage'))); assert.equal(saved(h).dataHealth.staleAcknowledged, true);
});

test('full battery capacity skips a recap date rather than waiting or reminting when capacity clears', async () => {
  const h = setup(); seed(h, { pending: [battery('full'), battery('discharge')] });
  await runMonitor(h.env, h.deps); assert.equal(messages(h).length, 0);
  assert.equal(saved(h).dailyRecap.resolvedDay, '2026-10-21'); assert.equal(saved(h).pending.length, 2);
  seed(h, { pending: [] }); h.advance(5 * minute); await runMonitor(h.env, h.deps);
  assert.equal(messages(h).length, 0); assert.deepEqual(saved(h).pending, []);
});

test('health admission evicts an older recap before battery and never recreates its consumed date', async () => {
  const c = healthSettings(), h = setup(c), q = queued(c), first = advanceDataHealth(c, undefined, { kind: 'idle' }, start - 31 * minute);
  assert.equal(first.status, 'ok'); seed(h, { pending: [battery('full'), q.alert], dailyRecap: q.state, dataHealth: first.state });
  await runMonitor(h.env, h.deps); assert.equal(messages(h).length, 1);
  assert.match(messages(h)[0].text, /Battery updates delayed/); assert.equal(saved(h).pending[0].kind, 'full');
  seed(h, { pending: [] }); h.advance(5 * minute); await runMonitor(h.env, h.deps);
  assert.equal(messages(h).length, 1);
});

test('battery admission evicts recap before health, and two new battery events keep both slots', () => {
  const c = healthSettings(), q = queued(c), hp = health(c); assert(hp.candidate);
  const notice = hp.candidate;
  const healthAlert = { kind: 'health', notice, id: `health:${notice.kind}:${notice.episodeAt}:${notice.qualifiedAt}`,
    createdAt: notice.qualifiedAt, attempts: 0, nextAttemptAt: start };
  for (const discharge of [0, 400]) {
    const s = JSON.parse(JSON.stringify({ ...initialState(c), lastReadingAt: start - 5 * minute, highCount: 1,
      latestReading: { at: start - 5 * minute, soc: 99, dischargeWatts: 400 },
      dailyRecap: q.state, dataHealth: hp.state, pending: [q.alert, healthAlert] }));
    transition(s, { at: start, soc: 100, dischargeWatts: discharge }, c, start);
    assert.deepEqual(s.pending.map((a: { kind: string }) => a.kind).sort(), discharge ? ['discharge', 'full'] : ['full', 'health']);
    assert.equal(s.dailyRecap.resolvedDay, q.state.resolvedDay);
  }
});

test('queued recap has strict independent decoding with no fabricated reading or duplicate slot', () => {
  const c = settings(), q = queued(c), state = { ...initialState(c), dailyRecap: q.state, pending: [q.alert] };
  assert.deepEqual(decodeState(JSON.stringify(state), c).pending, [q.alert]);
  for (const alert of [{ ...q.alert, reading: { at: start, soc: 55, dischargeWatts: 315 } },
    { ...q.alert, id: 'synthetic-invalid-id' }, { ...q.alert, createdAt: start + 1 }, { ...q.alert, attempts: 4 },
    { ...q.alert, slot: { ...q.alert.slot, expiresAt: start + 30 * minute } },
    { ...q.alert, slot: { ...q.alert.slot, body: 'synthetic-private' } }]) {
    assert.throws(() => decodeState(JSON.stringify({ ...state, pending: [alert] }), c), /state_invalid/);
  }
  assert.throws(() => decodeState(JSON.stringify({ ...state, pending: [q.alert, q.alert] }), c), /state_invalid/);
});

test('failed first checkpoint prevents sending, while a failed result checkpoint can still duplicate', async () => {
  const h = setup(), original = h.kv.data.get('monitor:v1'); h.kv.failOnPut = () => true;
  await assert.rejects(runMonitor(h.env, h.deps)); assert.equal(h.calls.length, 0);
  assert.equal(h.kv.data.get('monitor:v1'), original);
  let writes = 0; h.kv.failOnPut = () => ++writes === 2;
  await assert.rejects(runMonitor(h.env, h.deps)); assert.equal(messages(h).length, 1);
  h.kv.failOnPut = undefined; await runMonitor(h.env, h.deps); assert.equal(messages(h).length, 2);
  assert.equal(saved(h).dailyRecap.resolvedDay, '2026-10-21');
});

test('recap transient retries retain original deadline and abandon when the next retry meets expiry', async () => {
  const h = setup(); h.hook(() => json({ ok: false, error_code: 503 }));
  await runMonitor(h.env, h.deps); const pending = saved(h).pending[0];
  assert.equal(pending.kind, 'recap'); assert.equal(pending.attempts, 1);
  assert.equal(pending.slot.expiresAt, start + 15 * minute);
  h.advance(5 * minute); await runMonitor(h.env, h.deps);
  assert.equal(messages(h).length, 2); assert.deepEqual(saved(h).pending, []);
  h.advance(5 * minute); await runMonitor(h.env, h.deps); assert.equal(messages(h).length, 2);
});

test('permanent and long Retry-After failures consume the date without a new candidate', async () => {
  for (const body of [{ ok: false, error_code: 400 }, { ok: false, error_code: 429, parameters: { retry_after: 3600 } }]) {
    const h = setup(); h.hook(() => json(body)); await runMonitor(h.env, h.deps);
    assert.equal(messages(h).length, 1); assert.deepEqual(saved(h).pending, []);
    h.advance(5 * minute); await runMonitor(h.env, h.deps); assert.equal(messages(h).length, 1);
  }
});

test('expiry and attempt exhaustion remove existing queued recaps without reminting', async () => {
  for (const [time, attempts] of [[start + 15 * minute, 0], [start, 3]]) {
    const c = settings(), h = setup(c), q = queued(c); q.alert.attempts = attempts;
    seed(h, { dailyRecap: q.state, pending: [q.alert] }); h.clock.time = time;
    await runMonitor(h.env, h.deps); assert.equal(messages(h).length, 0); assert.deepEqual(saved(h).pending, []);
  }
});

test('delivery rechecks original expiry after the first checkpoint rather than extending admission time', async () => {
  const h = setup(), put = h.kv.put.bind(h.kv); let first = true;
  h.kv.put = async (key, value) => { await put(key, value); if (first) { first = false; h.clock.time = start + 15 * minute; } };
  await runMonitor(h.env, h.deps); assert.equal(messages(h).length, 0); assert.deepEqual(saved(h).pending, []);
  assert.equal(saved(h).dailyRecap.resolvedDay, '2026-10-21'); assert.equal(h.kv.puts.length, 2);
});

test('schedule changes and clock rollback cancel queued recap only and do not reset battery cycles', async () => {
  for (const change of ['schedule', 'rollback']) {
    const c = settings(), h = setup(c), q = queued(c);
    seed(h, { dailyRecap: { ...q.state, observedAt: start + 5 * minute }, pending: [battery('full'), q.alert] });
    if (change === 'schedule') { h.clock.time = start + 5 * minute; h.env.MONITOR_CONFIG = { ...c, dailyRecap: { ...policy, minute: 5 } }; }
    await runMonitor(h.env, h.deps); assert.equal(messages(h).length, 0);
    assert.deepEqual(saved(h).pending, [battery('full')]); assert.equal(saved(h).fullArmed, false);
    assert.equal(saved(h).dailyRecap.observedAt, start + 5 * minute);
  }
});

test('corrupt optional recap metadata suppresses only recap with a fixed code and preserves battery state', async () => {
  const h = setup(), q = queued(); seed(h, { dailyRecap: { private: 'synthetic-private-sentinel' }, pending: [battery('full'), q.alert] });
  const events = await runMonitor(h.env, h.deps);
  assert(events.includes('daily_recap_state_invalid')); assert(!JSON.stringify(events).includes('synthetic-private'));
  assert.equal(messages(h).length, 0); assert.deepEqual(saved(h).pending, [battery('full')]);
  assert.equal(saved(h).fullArmed, false); assert.equal(h.kv.puts.length, 1);
});

test('recap-only off cleanup during cooldown preserves health and battery in one checkpoint', async () => {
  const c = healthSettings(), h = setup(c), q = queued(c), hp = health(c, start, false);
  seed(h, { dailyRecap: q.state, pending: [battery('full'), q.alert], dataHealth: hp.state });
  h.env.MONITOR_CONFIG = { ...c, dailyRecap: { enabled: false } };
  await runMonitor(h.env, h.deps); assert.equal(saved(h).dailyRecap, undefined);
  assert.deepEqual(saved(h).pending, [battery('full')]); assert.deepEqual(saved(h).dataHealth, hp.state);
  assert.equal(h.kv.puts.length, 1); assert.equal(h.calls.length, 0);
});

test('recap reuses existing bot read/manual evidence without renewing reports or adding buttons', async () => {
  for (const age of [1000, SESSION_MS]) {
    const c = settings({ telegram: { enabled: true } }), h = setup(c), bot = decodeBotState(null, c), at = start - age;
    bot.session = { source: 'manual', status: 'charging', at, expiresAt: at + SESSION_MS };
    const before = JSON.stringify(bot); h.kv.data.set('telegram:v1', before);
    await runMonitor(h.env, h.deps); assert.equal(messages(h).length, 1);
    assert.match(messages(h)[0].text, age < SESSION_MS ? /Source: manual confirmation/ : /EV charging: unknown/);
    assert.equal(messages(h)[0].reply_markup, undefined); assert.equal(h.kv.data.get('telegram:v1'), before);
    assert.deepEqual(h.reads, ['telegram:v1', 'monitor:v1']); assert(h.kv.puts.every(p => p.key === 'monitor:v1'));
  }
});

test('legacy recap-off cooldown and disabled monitoring retain zero extra work', async () => {
  const h = harness(config()), s = { ...initialState(config()), apiRetryAt: start + 3600000 };
  const before = JSON.stringify(s); h.kv.data.set('monitor:v1', before);
  await runMonitor(h.env, h.deps); assert.equal(h.kv.data.get('monitor:v1'), before); assert.equal(h.kv.puts.length, 0);
  const paused = harness({ ...settings(), enabled: false }); paused.kv.get = async () => { throw new Error('Synthetic forbidden read'); };
  assert.deepEqual(await runMonitor(paused.env, paused.deps), ['monitor_disabled']); assert.equal(paused.calls.length, 0);
});

test('CI recap configuration is accepted only after explicit consent and the public template stays off', () => {
  const template = JSON.parse(readFileSync(new NodeURL('../wrangler.example.jsonc', import.meta.url), 'utf8'));
  assert.equal(template.vars.MONITOR_CONFIG.dailyRecap, undefined);
  const source = { ...template, name: 'synthetic-monitor', kv_namespaces: [{ binding: 'STATE', id: 'b'.repeat(32) }],
    vars: { MONITOR_CONFIG: settings() } };
  assert.deepEqual(prepareDeployment({ GITHUB_ACTIONS: 'true', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    CLOUDFLARE_API_TOKEN: 'synthetic-not-a-valid-token', WORKER_CONFIG_JSON: JSON.stringify(source) }).vars.MONITOR_CONFIG.dailyRecap,
    source.vars.MONITOR_CONFIG.dailyRecap);
});
