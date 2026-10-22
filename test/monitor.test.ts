import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMonitor } from '../src/monitor.ts';
import worker from '../src/index.ts';
import { config, harness, json } from './helpers.ts';
import type { State } from '../src/types.ts';
const state = (h: ReturnType<typeof harness>) => JSON.parse(h.kv.data.get('monitor:v1')!) as State;

test('end-to-end synthetic cycle persists state, avoids duplicate polls and rearms', async () => {
  const h = harness();
  h.reading(100, 400); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 1);
  await runMonitor(h.env, h.deps); assert.equal(h.sent.length, 1);
  h.advance(); h.reading(100, 500); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 2); assert.match(h.sent[1], /If the EV is charging/);
  h.advance(); h.reading(96, 99); await runMonitor(h.env, h.deps);
  h.advance(); h.reading(100, 400); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 3);
  h.advance(); h.reading(100, 500); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 4);
});
test('Telegram transient failures retry through persisted outbox, once per cycle', async () => {
  const h = harness(); let failures = 0;
  h.hook(url => url.includes('/sendMessage') && failures++ === 0 ? json({}, 503) : undefined);
  h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 0); assert.equal(state(h).pending[0].attempts, 1);
  h.advance(); h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 1); assert.equal(state(h).pending.length, 0);
  h.advance(); h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 1);
});
test('Telegram permanent failure is abandoned without retrying every poll', async () => {
  const h = harness();
  h.hook(url => url.includes('/sendMessage') ? json({}, 403) : undefined);
  h.reading(100, 0);
  assert((await runMonitor(h.env, h.deps)).includes('notification_abandoned'));
  assert.equal(state(h).pending.length, 0); assert.equal(state(h).fullArmed, false);
  h.advance(); h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(h.calls.filter(c => c.url.includes('/sendMessage')).length, 1);
});
test('persistent notification retries stop after three attempts', async () => {
  const h = harness();
  h.hook(url => url.includes('/sendMessage') ? json({}, 503) : undefined);
  for (const ms of [0, 300_000, 600_000, 300_000]) {
    h.advance(ms); h.reading(100, 0); await runMonitor(h.env, h.deps);
  }
  assert.equal(h.calls.filter(c => c.url.includes('/sendMessage')).length, 3);
  assert.equal(state(h).pending.length, 0);
});
test('Telegram backoff survives restarts and skips calls until Retry-After', async () => {
  const h = harness();
  h.hook(url => url.includes('/sendMessage') ? json({ parameters: { retry_after: 900 } }, 429) : undefined);
  h.reading(100, 0); await runMonitor(h.env, h.deps);
  h.advance(); h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(h.calls.filter(c => c.url.includes('/sendMessage')).length, 1);
  h.advance(600_000); h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(h.calls.filter(c => c.url.includes('/sendMessage')).length, 2);
});
test('persist-before-send prevents Telegram when initial KV state write fails', async () => {
  const h = harness(); h.kv.failOnPut = key => key === 'monitor:v1';
  h.reading(100, 0);
  await assert.rejects(runMonitor(h.env, h.deps));
  assert.equal(h.calls.filter(c => c.url.includes('/sendMessage')).length, 0);
});
test('crash after Telegram before checkpoint can duplicate: no exactly-once claim', async () => {
  const h = harness(); let writes = 0;
  h.kv.failOnPut = key => key === 'monitor:v1' && ++writes === 2;
  h.reading(100, 0); await assert.rejects(runMonitor(h.env, h.deps));
  assert.equal(h.sent.length, 1);
  h.kv.failOnPut = undefined;
  h.advance(); h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 2);
});
test('stale, missing and out-of-order telemetry never sends notifications', async () => {
  const h = harness();
  h.reading(90, 400); await runMonitor(h.env, h.deps);
  h.advance(); h.reading(100, 500, h.clock.time - 900_000);
  assert((await runMonitor(h.env, h.deps)).includes('reading_stale'));
  assert.equal(h.sent.length, 0); assert.equal(state(h).highCount, 0);
  h.advance(); h.reading(100, 500); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 1); // Fresh full alert, first discharge confirmation only.
  h.advance(); h.reading(96, 0, h.clock.time - 400_000);
  assert((await runMonitor(h.env, h.deps)).includes('reading_out_of_order'));
  assert.equal(state(h).fullArmed, false);
});
test('Deye failures use persistent backoff, do not send old outbox alerts', async () => {
  const h = harness();
  h.hook(url => url.includes('/station/latest') ? json({}, 429, { 'Retry-After': '900' }) : undefined);
  const events = await runMonitor(h.env, h.deps);
  assert(events.includes('deye_http_rate_limited'));
  const count = h.calls.length;
  h.advance(); assert.deepEqual(await runMonitor(h.env, h.deps), ['api_backoff']);
  assert.equal(h.calls.length, count);
});
test('delayed notifications drop if conditions clear before delivery', async () => {
  const h = harness();
  h.hook(url => url.includes('/sendMessage') ? json({}, 503) : undefined);
  h.reading(100, 0); await runMonitor(h.env, h.deps);
  h.advance(); h.reading(99, 0); await runMonitor(h.env, h.deps);
  assert.equal(state(h).pending.length, 0);
  assert.equal(h.calls.filter(c => c.url.includes('/sendMessage')).length, 1);
});
test('retry amperage hints use the latest confirmed fresh power', async () => {
  const h = harness(config({ ev: { enabled: true, confirmed: true, phases: 1, voltage: 230, minimumAmps: 6 } }));
  h.reading(90, 2000); await runMonitor(h.env, h.deps);
  h.hook(url => url.includes('/sendMessage') ? json({}, 503) : undefined);
  h.advance(); h.reading(90, 2000); await runMonitor(h.env, h.deps);
  h.hook(undefined);
  h.advance(); h.reading(90, 400); await runMonitor(h.env, h.deps);
  assert.match(h.sent[0], /reduction: 2 A/);
});
test('Free-plan KV budget: <= 3 writes, 2 reads per scheduled invocation', async () => {
  const h = harness();
  let reads = 0; const originalGet = h.kv.get.bind(h.kv);
  h.kv.get = async key => { reads++; return originalGet(key); };
  h.reading(100, 400); await runMonitor(h.env, h.deps);
  assert.equal(h.kv.puts.length, 3); assert.equal(reads, 2);
  const before = h.kv.puts.length;
  h.advance(); h.reading(100, 500); await runMonitor(h.env, h.deps);
  assert.equal(h.kv.puts.length - before, 2);
});
test('disabled template does no API/KV work; HTTP endpoint cannot trigger monitor', async () => {
  const h = harness(config({ enabled: false }));
  assert.deepEqual(await runMonitor(h.env, h.deps), ['monitor_disabled']);
  assert.equal(h.calls.length, 0); assert.equal(h.kv.puts.length, 0);
  const response = await worker.fetch(); assert.equal(response.status, 404);
});
test('KV checkpoints respect the one-write-per-second same-key limit', async () => {
  const h = harness();
  const times: number[] = [];
  const put = h.kv.put.bind(h.kv);
  h.kv.put = async (key, value) => {
    if (key === 'monitor:v1') times.push(h.clock.time);
    return put(key, value);
  };
  h.reading(100, 0); await runMonitor(h.env, h.deps);
  assert.equal(times.length, 2);
  assert(times[1] - times[0] >= 1100);
});
test('Telegram HTTP 408 timeout keeps the alert pending for a bounded later retry', async () => {
  const h = harness(); let timedOut = false;
  h.hook(url => {
    if (url.includes('/sendMessage') && !timedOut) {
      timedOut = true;
      return json({}, 408);
    }
  });
  h.reading(100, 0);
  const events = await runMonitor(h.env, h.deps);
  assert.equal(state(h).pending.length, 1);
  assert.equal(state(h).pending[0].attempts, 1);
  assert(!events.includes('notification_abandoned'));
  assert.equal(h.sent.length, 0);
  h.advance(); h.reading(100, 0);
  await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 1);
  assert.equal(state(h).pending.length, 0);
});
