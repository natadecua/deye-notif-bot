import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import type { Config, Dependencies, Env, KVStore, Secrets } from '../src/types.ts';
export const BASE_TIME = Date.parse('2026-10-21T12:00:00Z');
export const fixture = JSON.parse(readFileSync(new NodeURL('./fixtures/station-latest.synthetic.json', import.meta.url), 'utf8'));
export const tokenFixture = JSON.parse(readFileSync(new NodeURL('./fixtures/token.synthetic.json', import.meta.url), 'utf8'));
const template = JSON.parse(readFileSync(new NodeURL('../wrangler.example.jsonc', import.meta.url), 'utf8'));
export function config(extra: Partial<Config> = {}): Config {
  return { ...structuredClone(template.vars.MONITOR_CONFIG), enabled: true, stationId: 123,
    measurementsConfirmed: true, ...extra };
}
export const syntheticSecrets: Secrets = {
  DEYE_APP_ID: 'synthetic-app', DEYE_APP_SECRET: 'synthetic-secret', DEYE_ACCOUNT: 'synthetic@example.invalid',
  DEYE_PASSWORD_SHA256: 'a'.repeat(64), TELEGRAM_BOT_TOKEN: '123:synthetic-token', TELEGRAM_CHAT_ID: '456',
};
export class MemoryKV implements KVStore {
  data = new Map<string, string>();
  puts: { key: string; value: string }[] = [];
  failOnPut?: (key: string, value: string) => boolean;
  async get(key: string): Promise<string | null> { return this.data.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> {
    if (this.failOnPut?.(key, value)) throw new Error('Synthetic KV failure');
    this.puts.push({ key, value }); this.data.set(key, value);
  }
}
export const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers });
export function harness(c = config()) {
  const kv = new MemoryKV();
  const clock = { time: BASE_TIME };
  let raw = { ...fixture };
  const calls: { url: string; init?: RequestInit }[] = [];
  const sleeps: number[] = [];
  const sent: string[] = [];
  let hook: ((url: string, init?: RequestInit) => Response | undefined) | undefined;
  const deps: Dependencies = {
    now: () => clock.time, random: () => 0,
    sleep: async ms => { sleeps.push(ms); clock.time += ms; },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      const result = hook?.(u, init);
      if (result) return result;
      if (u.includes('/account/token')) return json(tokenFixture);
      if (u.includes('/station/latest')) return json(raw);
      if (u.includes('/sendMessage')) { sent.push(JSON.parse(String(init?.body)).text); return json({ ok: true }); }
      throw new Error('Unexpected synthetic route');
    }) as typeof fetch,
  };
  const env: Env = { ...syntheticSecrets, MONITOR_CONFIG: c, STATE: kv };
  return { kv, clock, calls, sleeps, sent, deps, env,
    hook: (f: typeof hook) => { hook = f; },
    reading: (soc: number, power: number, time = clock.time) => {
      raw = { ...fixture, batterySOC: soc, dischargePower: power, lastUpdateTime: new Date(time).toISOString() };
    },
    advance: (ms = 300_000) => { clock.time += ms; },
  };
}
