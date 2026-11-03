import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { configureQuiet } from '../scripts/quiet-preferences.ts';
import { preferencesSummary, type PreferencePrompts } from '../scripts/preferences.ts';
import { setupHint } from '../scripts/setup-hints.ts';
import { applyTelegramCommand } from '../src/telegram-settings.ts';
import { handleTelegramRequest } from '../src/bot.ts';
import { renderBriefSnapshot } from '../src/snapshot.ts';
import { initialState } from '../src/alerts.ts';
import { config, harness } from './helpers.ts';
import type { Config } from '../src/types.ts';

// Synthetic settings, prompts, accounts and intercepted transports only.
const policy = { enabled: true as const, timeZone: 'Asia/Manila', startMinute: 1320, endMinute: 360,
  categories: { full: true, discharge: false, health: true, recap: false }, suppressionConfirmed: true as const };
const daytime = { timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 };
const answers = [true, 'Asia/Manila', '22:00', '06:00', 'mute', 'keep', 'mute', 'keep', true, true];
function prompts(values: unknown[]) {
  const remaining = [...values], printed: string[] = [], questions: { message: string; initial: unknown }[] = [];
  const next = async (message: string, initial?: unknown) => {
    questions.push({ message, initial }); assert(remaining.length, 'Unexpected quiet prompt');
    return remaining.shift() as never;
  };
  const p: PreferencePrompts = { choose: next, text: next, number: next, confirm: next, checklist: next,
    print: value => printed.push(value) };
  return { p, remaining, printed, questions };
}
test('quiet setup explicitly enters zone, both times and every category without defaults', async () => {
  const source = config({ daytimeDischarge: daytime, notifications: { full: false, discharge: false } });
  const before = structuredClone(source), h = prompts(answers);
  const result = await configureQuiet(source, h.p);
  assert.deepEqual(result.quietHours, policy); assert.deepEqual(source, before);
  assert.deepEqual({ ...result, quietHours: undefined }, { ...source, quietHours: undefined });
  assert.equal(h.remaining.length, 0);
  assert(h.questions.filter(q => /Enable|accept|Save/.test(q.message)).every(q => q.initial === false));
  const entered = h.questions.filter(q => /timezone|HH:MM|Type mute/.test(q.message));
  assert.equal(entered.length, 7); assert(entered.every(q => q.initial === undefined));
  const text = h.printed.join('\n'), consent = h.questions.map(q => q.message).join('\n');
  assert.match(text, /22:00–06:00 Asia\/Manila/); assert.match(text, /full, health/);
  assert.match(consent, /expire.*without catch.up/i); assert.match(consent, /does not authorize overnight EV charging/);
  assert.match(text, /private CI configuration snapshot/); assert.match(text, /does not verify.*receipt/);
});
test('quiet setup supports independent timezone and same-day times without enabling other features', async () => {
  const h = prompts([true, 'Asia/Kathmandu', '00:00', '00:05', 'keep', 'keep', 'keep', 'mute', true, true]);
  const result = await configureQuiet(config(), h.p);
  assert.deepEqual(result.quietHours, { ...policy, timeZone: 'Asia/Kathmandu', startMinute: 0, endMinute: 5,
    categories: { full: false, discharge: false, health: false, recap: true } });
  assert.equal(result.daytimeDischarge, undefined); assert.equal(result.dailyRecap, undefined);
  assert.equal(result.telegram?.enabled, false);
});
test('quiet opt-out removes only its block after final save and explains cleanup', async () => {
  const source = config({ quietHours: policy, daytimeDischarge: daytime }), h = prompts([false, true]);
  const result = await configureQuiet(source, h.p);
  assert.equal(result.quietHours, undefined); assert.deepEqual(source.quietHours, policy);
  assert.deepEqual({ ...result, quietHours: undefined }, { ...source, quietHours: undefined });
  assert.equal(h.remaining.length, 0); assert.match(h.printed.join('\n'), /cleanup.*scheduled.*monitoring.*enabled/i);
});
test('declining suppression, final save or opt-out save retains prior quiet settings', async () => {
  const source = config({ quietHours: policy }), before = structuredClone(source);
  for (const a of [[...answers.slice(0, 8), false], [...answers.slice(0, 9), false], [false, false]]) {
    await assert.rejects(configureQuiet(source, prompts(a).p), /^SafeError: quiet_setup_not_confirmed$/);
    assert.deepEqual(source, before);
  }
});
test('invalid saved quiet settings fail before prompts with fixed errors', async () => {
  for (const invalid of [{ ...policy, suppressionConfirmed: false }, { ...policy, endMinute: 4 },
    { ...policy, token: 'synthetic-private-value' }, { enabled: false, startMinute: 0 }]) {
    const h = prompts([]);
    await assert.rejects(configureQuiet(config({ quietHours: invalid as never }), h.p), /^SafeError: quiet_hours_config_invalid$/);
    assert.equal(h.questions.length, 0);
  }
});
test('injected invalid zone/time/category responses cannot silently create quiet consent', async () => {
  const variants: unknown[][] = [];
  for (const [index, invalid] of [[1, 'Bad/Synthetic'], [1, 'UTC'], [1, 'Asia/Manila\nprivate'],
    [2, '24:00'], [2, '6:00'], [2, '22:04'], [2, 1320], [3, '22:00'], [4, ''], [4, true], [5, 'MUTE']] as const) {
    const a: unknown[] = [...answers]; a[index] = invalid; variants.push(a);
  }
  variants.push([true, 'Asia/Manila', '22:00', '06:00', 'keep', 'keep', 'keep', 'keep', true, true]);
  for (const a of variants) await assert.rejects(configureQuiet(config({ daytimeDischarge: daytime }), prompts(a).p),
    /^SafeError: quiet_hours_config_invalid$/);
  await assert.rejects(configureQuiet(config({ dailyRecap: { enabled: true, timeZone: 'UTC', hour: 7, minute: 0, scheduleConfirmed: true } }),
    prompts(answers).p), /^SafeError: quiet_hours_config_invalid$/);
});
test('pure preferences and settings show quiet policy scope, off/on/paused and unverified receipt', () => {
  for (const summarize of [preferencesSummary, (c: Config) => applyTelegramCommand(c, '/settings').reply]) {
    assert.match(summarize(config()), /Quiet hours: off.*quiet:setup/);
    const text = summarize(config({ quietHours: policy }));
    assert.match(text, /Quiet hours: on.*22:00–06:00 Asia\/Manila/);
    assert.match(text, /Muted categories: full, health/); assert.match(text, /Unmuted categories: discharge, recap/);
    assert.match(text, /requested replies.*unaffected/i); assert.match(text, /does not verify.*receipt/);
    assert.match(summarize(config({ enabled: false, quietHours: policy })), /Quiet hours paused.*monitoring is disabled/);
    assert.match(summarize(config({ quietHours: { ...policy, suppressionConfirmed: false } as never })), /Quiet hours: invalid saved settings.*not ready/);
    assert.doesNotMatch(summarize(config({ quietHours: { ...policy, timeZone: 'synthetic-private-value' } })), /synthetic-private/);
    assert(text.length < 4096);
  }
});
test('fixed quiet recovery identifies only local block, strict choices and manual cleanup', () => {
  const hint = setupHint('quiet_hours_config_invalid') ?? '';
  assert.match(hint, /wrangler\.jsonc.*quietHours/); assert.match(hint, /omit.*quiet:setup/);
  assert.match(hint, /timezone.*five.minute.*categor.*consent/i); assert.match(hint, /cleanup.*rollback/i);
  assert.match(setupHint('quiet_setup_not_confirmed') ?? '', /not saved.*manual/);
  assert.equal(setupHint('synthetic-private-error'), undefined);
});
test('quiet setup has an offline CLI entry and public defaults remain off', () => {
  const pkg = JSON.parse(readFileSync(new NodeURL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['quiet:setup'], 'tsx scripts/cli.ts quiet-setup');
  const template = JSON.parse(readFileSync(new NodeURL('../wrangler.example.jsonc', import.meta.url), 'utf8'));
  assert.equal(template.vars.MONITOR_CONFIG.quietHours, undefined);
});
test('authorized views show quiet configuration without monitor writes, provider calls or guard advancement', async () => {
  for (const command of ['/status', '/status brief', '/settings']) for (const enabled of [true, false]) {
    const c = config({ enabled, quietHours: policy, telegram: { enabled: true } }), h = harness(c);
    const secret = 'synthetic-webhook-secret-1234567890';
    const env = { ...h.env, TELEGRAM_OWNER_ID: '789', TELEGRAM_WEBHOOK_SECRET: secret };
    const before = JSON.stringify({ ...initialState(c), quietHours: { raw: 'synthetic-private-guard' } });
    h.kv.data.set('monitor:v1', before);
    const reads: string[] = [], get = h.kv.get.bind(h.kv);
    h.kv.get = async key => { reads.push(key); return get(key); };
    const request = (owner: number) => new Request('https://synthetic.invalid/telegram/webhook', { method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify({ update_id: 1,
        message: { date: Math.floor(h.clock.time / 1000), from: { id: owner }, chat: { id: 456 }, text: command } }) });
    assert.equal((await handleTelegramRequest(request(999), env, h.deps)).status, 403); assert.deepEqual(reads, []);
    assert.equal((await handleTelegramRequest(request(789), env, h.deps)).status, 200);
    assert.match(h.sent[0], command === '/status brief' ? enabled ? /Quiet hours: on \(configured\)/ : /Quiet hours: paused \(configured on\)/ :
      enabled ? /Quiet hours: on.*22:00–06:00 Asia\/Manila/ : /Quiet hours paused.*monitoring is disabled/);
    assert.doesNotMatch(h.sent[0], /synthetic-private|lastObservedAt|currently quiet/);
    assert.deepEqual(reads, command === '/settings' ? ['telegram:v1'] : ['telegram:v1', 'monitor:v1']);
    assert.deepEqual(h.kv.puts.map(p => p.key), ['telegram:v1']); assert.equal(h.calls.length, 1);
    assert(h.calls[0].url.endsWith('/sendMessage')); assert.equal(h.kv.data.get('monitor:v1'), before);
  }
});
test('brief quiet labels read configuration only and omit unavailable command links', () => {
  const c = config({ quietHours: policy }), s = initialState(c);
  Object.defineProperty(s, 'quietHours', { get() { throw new Error('Synthetic forbidden guard access'); } });
  const text = renderBriefSnapshot(s, c, 0);
  assert.match(text, /Quiet hours: on \(configured\)\./); assert.doesNotMatch(text, /\/settings|\/status|currently quiet/);
});
