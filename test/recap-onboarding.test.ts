import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { configureRecap } from '../scripts/recap-preferences.ts';
import { preferencesSummary, type PreferencePrompts } from '../scripts/preferences.ts';
import { setupHint } from '../scripts/setup-hints.ts';
import { applyTelegramCommand } from '../src/telegram-settings.ts';
import { handleTelegramRequest } from '../src/bot.ts';
import { renderBriefSnapshot } from '../src/snapshot.ts';
import { initialState } from '../src/alerts.ts';
import { config, harness } from './helpers.ts';
import type { Config } from '../src/types.ts';

// Synthetic settings/prompts, identifiers and intercepted transports only.
const policy = { enabled: true as const, timeZone: 'Asia/Manila', hour: 17, minute: 35, scheduleConfirmed: true as const };
const daytime = { timeZone: 'Asia/Manila', startHour: 6, endHour: 18, minimumMinutes: 15 };
function prompts(answers: unknown[]) {
  const remaining = [...answers], printed: string[] = [], questions: { message: string; initial: unknown }[] = [];
  const next = async (message: string, initial?: unknown) => {
    questions.push({ message, initial }); assert(remaining.length, 'Unexpected recap prompt');
    return remaining.shift() as never;
  };
  const p: PreferencePrompts = { choose: next, text: next, number: next, confirm: next, checklist: next,
    print: value => printed.push(value) };
  return { p, remaining, printed, questions };
}
test('recap opt-in explicitly enters zone/hour/minute, schedule consent and final local save', async () => {
  const source = config({ daytimeDischarge: daytime, notifications: { full: false, discharge: false } });
  const before = structuredClone(source), h = prompts([true, 'Asia/Manila', 17, 35, true, true]);
  const result = await configureRecap(source, h.p);
  assert.deepEqual(result.dailyRecap, policy); assert.deepEqual(source, before);
  assert.deepEqual({ ...result, dailyRecap: undefined }, { ...source, dailyRecap: undefined });
  assert.equal(h.remaining.length, 0);
  assert(h.questions.filter(q => /Enable|accept|Save/.test(q.message)).every(q => q.initial === false));
  assert(h.questions.filter(q => /timezone|hour|minute/.test(q.message)).every(q => q.initial === undefined));
  const text = h.printed.join('\n');
  assert.match(text, /17:35 Asia\/Manila/); assert.match(text, /skip.*current local date/i);
  assert.match(text, /15.minute.*opportunity/i); assert.match(text, /does not verify.*receipt/i);
  assert.match(text, /independent of battery notification switches/i);
  assert.match(h.questions.map(q => q.message).join('\n'), /night.*does not authorize overnight EV charging/i);
  assert.match(text, /npm run deploy/); assert.doesNotMatch(text, /stationId|latitude|longitude|123/);
});
test('recap schedule can be entered without a daytime policy or Telegram commands', async () => {
  const h = prompts([true, 'Asia/Kathmandu', 0, 0, true, true]);
  const result = await configureRecap(config(), h.p);
  assert.deepEqual(result.dailyRecap, { ...policy, timeZone: 'Asia/Kathmandu', hour: 0, minute: 0 });
  assert.equal(result.daytimeDischarge, undefined); assert.equal(result.telegram?.enabled, false);
});
test('recap opt-out removes only its block with explicit local-save consent', async () => {
  const source = config({ dailyRecap: policy }), h = prompts([false, true]);
  assert.deepEqual(await configureRecap(source, h.p), config());
  assert.deepEqual(source.dailyRecap, policy); assert.equal(h.remaining.length, 0);
  assert.match(h.printed.join('\n'), /Recap: off/);
  assert.match(h.printed.join('\n'), /cleanup.*scheduled.*monitoring.*enabled/i);
});
test('recap cancellation at schedule consent or save retains the previous settings', async () => {
  const source = config({ dailyRecap: policy }), before = structuredClone(source);
  for (const answers of [[true, 'UTC', 9, 0, false], [true, 'UTC', 9, 0, true, false], [false, false]]) {
    await assert.rejects(configureRecap(source, prompts(answers).p), /recap_setup_not_confirmed/);
    assert.deepEqual(source, before);
  }
});
test('recap invalid saved fields or consent fail before prompts without silent repair', async () => {
  for (const invalid of [{ ...policy, scheduleConfirmed: false }, { ...policy, minute: 4 },
    { ...policy, token: 'synthetic-private-value' }, { enabled: false, hour: 17 }]) {
    const h = prompts([]);
    await assert.rejects(configureRecap(config({ dailyRecap: invalid as never }), h.p), /daily_recap_config_invalid/);
    assert.equal(h.questions.length, 0);
  }
});
test('recap setup rejects invalid zone, mismatched installation zone and off-grid or malformed time', async () => {
  for (const zone of ['Bad/Synthetic', 'UTC', 'Asia/Manila\nsynthetic-private']) {
    await assert.rejects(configureRecap(config({ daytimeDischarge: daytime }),
      prompts([true, zone, 17, 35, true, true]).p), /daily_recap_config_invalid/);
  }
  for (const [hour, minute] of [[-1, 0], [24, 0], [17.5, 0], [17, 4], [17, 60], [17, NaN], ['17', 35]]) {
    await assert.rejects(configureRecap(config(), prompts([true, 'UTC', hour, minute, true, true]).p), /daily_recap_config_invalid/);
  }
});
test('pure preference summaries/settings separate recap off/on/paused from operation and receipt', () => {
  for (const summarize of [preferencesSummary, (c: Config) => applyTelegramCommand(c, '/settings').reply]) {
    assert.match(summarize(config()), /Recap: off.*recap:setup/);
    const text = summarize(config({ dailyRecap: policy, notifications: { full: false, discharge: false } }));
    assert.match(text, /Recap: on.*17:35 Asia\/Manila/);
    assert.match(text, /does not verify.*receipt/); assert.match(text, /independent of battery notification switches/i);
    assert.match(summarize(config({ dailyRecap: policy, enabled: false })), /Recap delivery paused.*monitoring is disabled/);
    assert.match(summarize(config({ dailyRecap: { ...policy, scheduleConfirmed: false } as never })), /Recap: invalid saved settings.*not ready/);
    assert.doesNotMatch(summarize(config({ dailyRecap: { ...policy, timeZone: 'synthetic-private-value' } })), /synthetic-private/);
  }
});
test('fixed recap recovery explains local block, consent/time rules and cancellation without reflecting errors', () => {
  const hint = setupHint('daily_recap_config_invalid') ?? '';
  assert.match(hint, /wrangler\.jsonc.*dailyRecap/); assert.match(hint, /omit.*recap:setup/);
  assert.match(hint, /timezone.*hour.*minute.*consent/i);
  assert.match(setupHint('recap_setup_not_confirmed') ?? '', /not saved.*manual/);
  assert.equal(setupHint('synthetic-private-recap-error'), undefined);
});
test('recap setup has an offline CLI entry point; the public template remains off', () => {
  const pkg = JSON.parse(readFileSync(new NodeURL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['recap:setup'], 'tsx scripts/cli.ts recap-setup');
  const template = JSON.parse(readFileSync(new NodeURL('../wrangler.example.jsonc', import.meta.url), 'utf8'));
  assert.equal(template.vars.MONITOR_CONFIG.dailyRecap, undefined);
});
test('authorized status/settings show recap configuration without touching lifecycle or adding IO', async () => {
  for (const command of ['/status', '/status brief', '/settings']) {
    for (const enabled of [true, false]) {
      const c = config({ enabled, dailyRecap: policy, telegram: { enabled: true } }), h = harness(c);
      const secret = 'synthetic-webhook-secret-1234567890';
      const env = { ...h.env, TELEGRAM_OWNER_ID: '789', TELEGRAM_WEBHOOK_SECRET: secret };
      const before = JSON.stringify({ ...initialState(c), dailyRecap: { raw: 'synthetic-private-lifecycle' } });
      h.kv.data.set('monitor:v1', before);
      const reads: string[] = [], get = h.kv.get.bind(h.kv);
      h.kv.get = async key => { reads.push(key); return get(key); };
      const request = (owner: number) => new Request('https://synthetic.invalid/telegram/webhook', { method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify({ update_id: 1,
          message: { date: Math.floor(h.clock.time / 1000), from: { id: owner }, chat: { id: 456 }, text: command } }) });
      assert.equal((await handleTelegramRequest(request(999), env, h.deps)).status, 403);
      assert.deepEqual(reads, []); assert.equal(h.calls.length, 0);
      assert.equal((await handleTelegramRequest(request(789), env, h.deps)).status, 200);
      assert.match(h.sent[0], command === '/status brief' ? enabled ? /Recap: on \(configured\)/ : /Recap: paused \(configured on\)/ :
        enabled ? /Recap: on.*17:35 Asia\/Manila/ : /Recap delivery paused.*monitoring is disabled/);
      assert.doesNotMatch(h.sent[0], /synthetic-private-lifecycle|resolvedDay|observedAt|stationId/);
      assert.deepEqual(reads, command === '/settings' ? ['telegram:v1'] : ['telegram:v1', 'monitor:v1']);
      assert.deepEqual(h.kv.puts.map(p => p.key), ['telegram:v1']); assert.equal(h.calls.length, 1);
      assert(h.calls[0].url.endsWith('/sendMessage')); assert.equal(h.kv.data.get('monitor:v1'), before);
    }
  }
});
test('brief recap visibility uses configuration only and omits dead links when commands are off', () => {
  for (const enabled of [true, false]) {
    const c = config({ enabled, dailyRecap: policy }), s = initialState(c);
    Object.defineProperty(s, 'dailyRecap', { get() { throw new Error('Synthetic forbidden lifecycle access'); } });
    const text = renderBriefSnapshot(s, c, 0);
    assert.match(text, enabled ? /Recap: on \(configured\)\./ : /Recap: paused \(configured on\)\./);
    assert.doesNotMatch(text, /\/settings|\/status|receipt verified/);
  }
});
