export interface EVConfig {
  enabled: boolean;
  confirmed?: boolean;
  phases?: 1 | 3;
  voltage?: number; // Line-to-neutral, also for balanced three-phase.
  minimumAmps?: number;
}
export interface Config {
  enabled: boolean;
  region: 'eu' | 'am' | 'india';
  stationId: number;
  powerUnit: 'W' | 'kW';
  measurementsConfirmed: boolean;
  timestampMode: 'iso-offset' | 'unix-seconds' | 'unix-milliseconds';
  fullSoc: number;
  fullRearmSoc: number;
  dischargeWatts: number;
  dischargeRearmWatts: number;
  maxAgeSeconds: number;
  maxGapSeconds: number;
  ev: EVConfig;
}
export interface Secrets {
  DEYE_APP_ID: string;
  DEYE_APP_SECRET: string;
  DEYE_ACCOUNT: string;
  DEYE_ACCOUNT_FIELD?: string;
  DEYE_PASSWORD_SHA256: string;
  DEYE_COMPANY_ID?: string;
  DEYE_COUNTRY_CODE?: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
}
export interface KVStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}
export interface Env extends Secrets {
  STATE: KVStore;
  MONITOR_CONFIG: unknown;
}
export interface Reading { at: number; soc: number; dischargeWatts: number }
export interface Alert {
  id: string;
  kind: 'full' | 'discharge';
  reading: Reading;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
}
export interface State {
  version: 1;
  identity: string;
  lastReadingAt?: number;
  fullArmed: boolean;
  dischargeArmed: boolean;
  highCount: number;
  pending: Alert[];
  apiFailures: number;
  apiRetryAt: number;
}
export interface Token { authorization: string; expiresAt: number }
export type Fetcher = typeof fetch;
export interface Dependencies {
  fetch: Fetcher;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}
export const defaults: Dependencies = {
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  random: () => Math.random(),
};
