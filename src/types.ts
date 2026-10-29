export type ChargingProfile = {
  id: string;
  label: string;
} & ({ type: 'amps'; amps: number } | { type: 'power'; nominalWatts: number });
export interface NotificationPreferences {
  full: boolean;
  discharge: boolean;
}
export interface EVConfig {
  enabled: boolean;
  confirmed?: boolean;
  phases?: 1 | 3;
  voltage?: number; // Line-to-neutral, also for balanced three-phase.
  minimumAmps?: number;
  profiles?: ChargingProfile[];
}
export interface DaytimeDischarge {
  timeZone: string;
  startHour: number;
  endHour: number;
  minimumMinutes: number;
}
export interface WeatherConfig {
  enabled: boolean;
  latitude?: number;
  longitude?: number;
  nonCommercialConfirmed?: boolean;
}
// Default off; independent explicit duration and delivery consent through local setup.
export interface DataHealthConfig {
  enabled: boolean;
  warnAfterMinutes?: number;
  delivery?: 'all-hours' | 'daytime';
  allHoursConfirmed?: boolean;
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
  // Omitted in older installations: both notification categories remain enabled.
  notifications?: NotificationPreferences;
  telegram?: { enabled: boolean };
  daytimeDischarge?: DaytimeDischarge;
  weather?: WeatherConfig;
  dataHealth?: DataHealthConfig;
  // Default off; owner setup/CI enablement remain a separate release gate.
  dailyRecap?: import('./recap-config.ts').DailyRecapPolicy | { enabled: false };
  // Default off; owner setup/visibility/CI enablement are separate gates.
  quietHours?: import('./quiet-hours.ts').QuietHoursPolicy | { enabled: false };
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
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_OWNER_ID?: string;
  TELEGRAM_BOT_USERNAME?: string;
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
interface PendingDelivery {
  id: string;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
}
export interface Alert extends PendingDelivery {
  kind: 'full' | 'discharge';
  reading: Reading;
}
export interface HealthAlert extends PendingDelivery {
  kind: 'health';
  notice: import('./data-health.ts').HealthCandidate;
}
export interface RecapAlert extends PendingDelivery {
  kind: 'recap';
  slot: import('./daily-recap.ts').DailyRecapSlot;
}
export type PendingAlert = Alert | HealthAlert | RecapAlert;
export interface State {
  version: 1;
  identity: string;
  lastReadingAt?: number;
  latestReading?: Reading;
  fullArmed: boolean;
  dischargeArmed: boolean;
  highCount: number;
  highStartedAt?: number;
  dischargeDay?: string;
  dischargePolicyIdentity?: string;
  // Optional context is decoded independently so corrupt weather cannot stop alerts.
  weather?: unknown;
  dataHealth?: unknown;
  dailyRecap?: unknown;
  quietHours?: unknown;
  pending: PendingAlert[];
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
