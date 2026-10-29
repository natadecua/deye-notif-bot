import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { advanceQuietHours, validateQuietHours, type QuietHoursPolicy, type QuietHoursState } from '../src/quiet-hours.ts';
import { config, harness, BASE_TIME } from './helpers.ts';
import { runMonitor } from '../src/monitor.ts';
import { prepareDeployment } from '../scripts/ci-deploy.ts';

// All policies, clocks, identifiers and transports here are synthetic, never owner settings.
const c = config(), at = (s: string) => Date.parse(s), last = 253402300799999;
const selected = { full: true, discharge: false, health: true, recap: false };
const none = { full: false, discharge: false, health: false, recap: false };
const policy = (extra: Partial<QuietHoursPolicy> = {}): QuietHoursPolicy => ({ enabled: true,
  timeZone: 'Asia/Manila', startMinute: 22 * 60, endMinute: 6 * 60, categories: { ...selected },
  suppressionConfirmed: true, ...extra });
function step(now: number, p: unknown = policy(), state: unknown = undefined) {
  const result = advanceQuietHours(c, p, state, now);
  assert.equal(result.status, 'ok'); assert(result.status === 'ok'); return result;
}
const invalidPolicy = (raw: unknown) => assert.throws(() => validateQuietHours(raw), /^SafeError: quiet_hours_config_invalid$/);

test('omitted/canonical off ignore optional metadata and clock without creating suppression', () => {
  const unreadable = Object.defineProperty({}, 'version', { get() { throw new Error('Synthetic forbidden read'); } });
  for (const raw of [undefined, { enabled: false }]) {
    assert.equal(validateQuietHours(raw), undefined);
    assert.deepEqual(advanceQuietHours(c, raw, unreadable, NaN), { status: 'off' });
  }
});
test('enabled policy requires explicit choices and returns independent allowlisted copies', () => {
  const p = policy(), before = structuredClone(p), validated = validateQuietHours(p);
  assert.deepEqual(validated, p); assert.notEqual(validated, p); assert.notEqual(validated?.categories, p.categories);
  validated!.categories.full = false; assert.deepEqual(p, before);
});
test('policy rejects partial consent, nonobjects and extra fields using a fixed safe error', () => {
  const p = policy();
  for (const raw of [null, [], true, 'synthetic-private-policy', {}, { enabled: 'true' },
    { ...p, suppressionConfirmed: false }, { ...p, suppressionConfirmed: undefined },
    { ...p, suppressionConfirmed: 'true' }, { ...p, enabled: undefined },
    { enabled: false, startMinute: 10 }, { ...p, token: 'synthetic-private-value' },
    { ...p, url: 'https://synthetic.invalid/?secret=private' }]) invalidPolicy(raw);
});
test('policy requires a bounded explicit valid timezone without trimming or offset inference', () => {
  for (const timeZone of [undefined, '', '+08:00', ' Asia/Manila', 'Asia/Manila\nsynthetic-private',
    'Synthetic/Invalid', 'x'.repeat(65), 8]) invalidPolicy({ ...policy(), timeZone });
  assert.equal(validateQuietHours(policy({ timeZone: 'UTC' }))?.timeZone, 'UTC');
});
test('local boundaries are distinct whole five-minute values, with midnight explicitly represented by zero', () => {
  for (const [startMinute, endMinute] of [[0, 0], [360, 360], [-5, 360], [1440, 360], [1, 360], [0, 1436],
    [0, 1440], [0, NaN], [0, Infinity], [2.5, 360], ['0', 360], [0, undefined]]) invalidPolicy({ ...policy(), startMinute, endMinute });
  assert.equal(validateQuietHours(policy({ startMinute: 1435, endMinute: 0 }))?.startMinute, 1435);
  assert.equal(validateQuietHours(policy({ startMinute: 0, endMinute: 5 }))?.endMinute, 5);
});
test('all four category choices must be explicit booleans with at least one selected and no future categories', () => {
  for (const categories of [undefined, [], null, {}, selected.full, none, { full: true },
    { ...selected, full: 'true' }, { ...selected, recap: undefined },
    { ...selected, reserve: true }, { ...selected, token: 'synthetic-private-value' }]) invalidPolicy({ ...policy(), categories });
  for (const kind of Object.keys(none)) {
    const categories = { ...none, [kind]: true };
    assert.deepEqual(validateQuietHours(policy({ categories }))?.categories, categories);
  }
});
test('zone consent must match both existing daytime and enabled recap without changing their policies', () => {
  const context = config({ daytimeDischarge: { timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 },
    dailyRecap: { enabled: true, timeZone: 'Asia/Manila', hour: 7, minute: 10, scheduleConfirmed: true } });
  const before = structuredClone(context);
  assert.deepEqual(validateQuietHours(policy(), context), policy());
  assert.throws(() => validateQuietHours(policy({ timeZone: 'UTC' }), context), /quiet_hours_config_invalid/);
  assert.throws(() => validateQuietHours(policy(), { dailyRecap: { ...context.dailyRecap!, timeZone: 'UTC' } as never }), /quiet_hours_config_invalid/);
  assert.deepEqual(validateQuietHours(policy(), { dailyRecap: { enabled: false } }), policy());
  assert.deepEqual(context, before);
});
test('same-day window uses start-inclusive/end-exclusive millisecond boundaries', () => {
  const p = policy({ timeZone: 'UTC', startMinute: 9 * 60, endMinute: 10 * 60 });
  for (const [time, quiet] of [['2026-10-29T08:59:59.999Z', false], ['2026-10-29T09:00:00Z', true],
    ['2026-10-29T09:59:59.999Z', true], ['2026-10-29T10:00:00Z', false]] as const) {
    const r = step(at(time), p); assert.equal(r.reason, quiet ? 'quiet' : 'open'); assert.deepEqual(r.muted, quiet ? selected : none);
  }
});
test('midnight-crossing Manila window covers both dates but opens exactly at the end', () => {
  for (const [time, quiet] of [['2026-10-29T13:59:59.999Z', false], ['2026-10-29T14:00:00Z', true],
    ['2026-10-29T15:59:59.999Z', true], ['2026-10-29T16:00:00Z', true],
    ['2026-10-29T21:59:59.999Z', true], ['2026-10-29T22:00:00Z', false]] as const) {
    assert.deepEqual(step(at(time)).muted, quiet ? selected : none);
  }
});
test('a zero-minute end and zero-minute start retain distinct midnight boundary meanings', () => {
  const midnight = at('2026-10-29T00:00:00Z');
  const untilMidnight = policy({ timeZone: 'UTC', startMinute: 1435, endMinute: 0 });
  assert.equal(step(midnight - 1, untilMidnight).reason, 'quiet'); assert.equal(step(midnight, untilMidnight).reason, 'open');
  const fromMidnight = policy({ timeZone: 'UTC', startMinute: 0, endMinute: 5 });
  assert.equal(step(midnight - 1, fromMidnight).reason, 'open'); assert.equal(step(midnight, fromMidnight).reason, 'quiet');
  assert.equal(step(midnight + 5 * 60_000, fromMidnight).reason, 'open');
});
test('fractional UTC offsets use installation minutes rather than the host timezone', () => {
  const p = policy({ timeZone: 'Asia/Kathmandu', startMinute: 9 * 60, endMinute: 9 * 60 + 5 });
  assert.equal(step(at('2026-10-29T03:14:59.999Z'), p).reason, 'open');
  assert.equal(step(at('2026-10-29T03:15:00Z'), p).reason, 'quiet');
  assert.equal(step(at('2026-10-29T03:20:00Z'), p).reason, 'open');
});
test('spring-forward reevaluates actual instants without inventing missing local minutes', () => {
  const p = policy({ timeZone: 'America/New_York', startMinute: 90, endMinute: 150 });
  const before = step(at('2026-03-08T06:59:59.999Z'), p); assert.equal(before.reason, 'quiet');
  assert.equal(step(at('2026-03-08T07:00:00Z'), p, before.state).reason, 'open');
  const missing = policy({ ...p, startMinute: 120 });
  assert.equal(step(at('2026-03-08T06:59:59.999Z'), missing).reason, 'open');
  assert.equal(step(at('2026-03-08T07:00:00Z'), missing).reason, 'open');
});
test('both repeated-hour occurrences follow local labels while the absolute guard stays monotonic', () => {
  const p = policy({ timeZone: 'America/New_York', startMinute: 60, endMinute: 90 });
  let state: QuietHoursState | undefined;
  for (const [time, quiet] of [['2026-11-01T05:15:00Z', true], ['2026-11-01T05:30:00Z', false],
    ['2026-11-01T06:15:00Z', true], ['2026-11-01T06:30:00Z', false]] as const) {
    const r = step(at(time), p, state); assert.equal(r.reason, quiet ? 'quiet' : 'open'); state = r.state;
  }
});
test('legacy initialization and serialized restart return copied bounded guards without changing input', () => {
  const first = step(BASE_TIME); assert.deepEqual(first.state, { version: 1, lastObservedAt: BASE_TIME });
  const saved = JSON.parse(JSON.stringify(first.state)), before = structuredClone(saved);
  const next = step(BASE_TIME + 1, policy(), Object.freeze(saved));
  assert.deepEqual(next.state, { version: 1, lastObservedAt: BASE_TIME + 1 });
  assert.notEqual(next.state, saved); assert.deepEqual(saved, before);
});
test('rollback suppresses only selected categories until catch-up, including after policy edits', () => {
  const future = { version: 1, lastObservedAt: BASE_TIME + 3600_000 };
  const changed = policy({ timeZone: 'UTC', startMinute: 0, endMinute: 5, categories: { ...none, recap: true } });
  const rollback = step(BASE_TIME, changed, future);
  assert.equal(rollback.reason, 'rollback'); assert.deepEqual(rollback.muted, changed.categories);
  assert.deepEqual(rollback.state, future); assert.notEqual(rollback.state, future);
  assert.equal(step(future.lastObservedAt, changed, rollback.state).reason, 'open');
  assert.deepEqual(future, { version: 1, lastObservedAt: BASE_TIME + 3600_000 });
});
test('malformed optional guards fail closed for selected categories without reflecting or repairing them', () => {
  for (const state of [null, [], {}, { version: 2, lastObservedAt: BASE_TIME }, { version: 1, lastObservedAt: '1' },
    { version: 1, lastObservedAt: -1 }, { version: 1, lastObservedAt: last + 1 },
    { version: 1, lastObservedAt: BASE_TIME, rawBody: 'synthetic-private-state' }]) {
    const before = JSON.stringify(state), result = advanceQuietHours(c, policy(), state, BASE_TIME);
    assert.deepEqual(result, { status: 'invalid', code: 'quiet_hours_state_invalid', muted: selected });
    assert.equal(JSON.stringify(state), before); assert.doesNotMatch(JSON.stringify(result), /synthetic-private|rawBody/);
  }
});
test('invalid caller clocks fail closed without fabricated metadata or reflected values', () => {
  for (const now of [-1, NaN, Infinity, last + 1, 1.5, '0', undefined]) {
    assert.deepEqual(advanceQuietHours(c, policy(), undefined, now as number),
      { status: 'invalid', code: 'quiet_hours_clock_invalid', muted: selected });
  }
});
test('clock range endpoints remain representable and allowed', () => {
  for (const now of [0, last]) {
    const r = step(now, policy({ timeZone: 'UTC' })); assert.equal(r.state.lastObservedAt, now);
    assert.equal(r.reason, 'quiet');
  }
});
test('whole-monitor pause does no optional policy/state decoding or clock work', () => {
  const unreadable = Object.defineProperty({}, 'enabled', { get() { throw new Error('Synthetic forbidden read'); } });
  assert.deepEqual(advanceQuietHours({ ...c, enabled: false }, unreadable, unreadable, NaN), { status: 'paused' });
});
test('formatter failures return fixed clock diagnostics rather than raw exceptions', () => {
  validateQuietHours(policy());
  const original = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  Intl.DateTimeFormat.prototype.formatToParts = function (...args) {
    calls++; if (calls > 1) throw new Error('synthetic-private-format-error'); return original.apply(this, args);
  };
  try {
    assert.deepEqual(advanceQuietHours(c, policy(), undefined, BASE_TIME),
      { status: 'invalid', code: 'quiet_hours_clock_invalid', muted: selected });
  } finally { Intl.DateTimeFormat.prototype.formatToParts = original; }
});
test('enabled preparation rejects invalid policy before inspecting optional state', () => {
  const unreadable = Object.defineProperty({}, 'version', { get() { throw new Error('Synthetic forbidden read'); } });
  assert.throws(() => advanceQuietHours(c, { ...policy(), suppressionConfirmed: false }, unreadable, BASE_TIME),
    /^SafeError: quiet_hours_config_invalid$/);
});
test('long gaps and repeated observations use constant formatter work, bounded state and no live IO', () => {
  const first = step(BASE_TIME).state, original = Intl.DateTimeFormat.prototype.formatToParts, originalFetch = globalThis.fetch;
  let calls = 0;
  Intl.DateTimeFormat.prototype.formatToParts = function (...args) { calls++; return original.apply(this, args); };
  globalThis.fetch = async () => { throw new Error('Synthetic forbidden live IO'); };
  try {
    let r = step(at('2036-10-29T15:00:00Z'), policy(), first);
    assert(calls <= 2); assert.equal(r.reason, 'quiet');
    for (let i = 1; i <= 256; i++) {
      r = step(at('2036-10-29T15:00:00Z') + i * 86400_000, policy(), r.state);
      assert(JSON.stringify(r.state).length < 128);
      assert.deepEqual(Object.keys(r.state).sort(), ['lastObservedAt', 'version']);
    }
    assert(calls <= 2 * 257);
  } finally { Intl.DateTimeFormat.prototype.formatToParts = original; globalThis.fetch = originalFetch; }
});
test('integrated quiet helper keeps public defaults, CI rejection and quiet-off monitor IO compatible', async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new NodeURL('../src/index.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, metafile: true });
  assert(Object.keys(bundle.metafile!.inputs).some(p => p.replaceAll('\\', '/').endsWith('/quiet-hours.ts')));
  const template = JSON.parse(readFileSync(new NodeURL('../wrangler.example.jsonc', import.meta.url), 'utf8'));
  assert.equal(template.vars.MONITOR_CONFIG.quietHours, undefined);
  const source = { ...template, name: 'synthetic-monitor', kv_namespaces: [{ binding: 'STATE', id: 'b'.repeat(32) }],
    vars: { MONITOR_CONFIG: { ...c, quietHours: policy() } } };
  assert.throws(() => prepareDeployment({ GITHUB_ACTIONS: 'true', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    CLOUDFLARE_API_TOKEN: 'synthetic-not-a-valid-token', WORKER_CONFIG_JSON: JSON.stringify(source) }), /ci_config_unsupported_field/);
  const h = harness(c); h.reading(80, 0); await runMonitor(h.env, h.deps);
  assert.equal(h.sent.length, 0); assert.equal(h.kv.puts.filter(p => p.key === 'monitor:v1').length, 1);
  assert(!h.kv.data.get('monitor:v1')!.includes('quietHours'));
});
