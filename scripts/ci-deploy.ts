import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { validateConfig } from '../src/config.ts';
import { SafeError } from '../src/errors.ts';
import type { Config } from '../src/types.ts';

type Environment = Record<string, string | undefined>;
const template = JSON.parse(readFileSync(new NodeURL('../wrangler.example.jsonc', import.meta.url), 'utf8'));
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SafeError('ci_config_invalid');
  return value as Record<string, unknown>;
}
function only(value: unknown, keys: string[]): Record<string, unknown> {
  const result = object(value);
  if (Object.keys(result).some(key => !keys.includes(key))) throw new SafeError('ci_config_unsupported_field');
  return result;
}
export interface DeploymentConfig {
  name: string; main: string; compatibility_date: string; account_id: string;
  workers_dev: boolean; preview_urls: false; send_metrics: false;
  triggers: { crons: string[] }; observability: { enabled: false };
  kv_namespaces: { binding: 'STATE'; id: string }[];
  vars: { MONITOR_CONFIG: Config };
}
export function prepareDeployment(env: Environment): DeploymentConfig {
  if (['WORKER_CONFIG_JSON', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'].some(key => !env[key]?.trim())) {
    throw new SafeError('ci_deployment_secrets_missing');
  }
  const account = env.CLOUDFLARE_ACCOUNT_ID!;
  if (!/^[a-f0-9]{32}$/.test(account)) throw new SafeError('ci_account_invalid');
  let parsed: unknown;
  try { parsed = JSON.parse(env.WORKER_CONFIG_JSON!); } catch { throw new SafeError('ci_config_invalid_json'); }
  const source = only(parsed, [...Object.keys(template), 'account_id', 'send_metrics']);
  if (source.account_id !== undefined && source.account_id !== account) throw new SafeError('ci_account_mismatch');
  const vars = only(source.vars, ['MONITOR_CONFIG']);
  const monitor = only(vars.MONITOR_CONFIG, [...Object.keys(template.vars.MONITOR_CONFIG), 'daytimeDischarge', 'weather', 'dataHealth', 'dailyRecap']);
  const ev = only(monitor.ev, ['enabled', 'confirmed', 'phases', 'voltage', 'minimumAmps', 'profiles']);
  if (Array.isArray(ev.profiles)) for (const profile of ev.profiles) {
    only(profile, ['id', 'label', 'type', 'amps', 'nominalWatts']);
  }
  if (monitor.notifications !== undefined) only(monitor.notifications, ['full', 'discharge']);
  if (monitor.telegram !== undefined) only(monitor.telegram, ['enabled']);
  if (monitor.daytimeDischarge !== undefined) only(monitor.daytimeDischarge, ['timeZone', 'startHour', 'endHour', 'minimumMinutes']);
  if (monitor.weather !== undefined) only(monitor.weather, ['enabled', 'latitude', 'longitude', 'nonCommercialConfirmed']);
  if (monitor.dataHealth !== undefined) only(monitor.dataHealth, ['enabled', 'warnAfterMinutes', 'delivery', 'allHoursConfirmed']);
  if (monitor.dailyRecap !== undefined) only(monitor.dailyRecap, ['enabled', 'timeZone', 'hour', 'minute', 'scheduleConfirmed']);
  const config = validateConfig(monitor);
  if (!config.enabled) throw new SafeError('ci_monitor_disabled');
  const triggers = only(source.triggers, ['crons']);
  const observability = only(source.observability, ['enabled']);
  if (typeof source.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(source.name) ||
      source.main !== template.main || source.compatibility_date !== template.compatibility_date ||
      source.workers_dev !== (config.telegram?.enabled === true) || source.preview_urls !== false || observability.enabled !== false ||
      JSON.stringify(triggers.crons) !== JSON.stringify(template.triggers.crons)) {
    throw new SafeError('ci_config_policy_invalid');
  }
  if (!Array.isArray(source.kv_namespaces) || source.kv_namespaces.length !== 1) throw new SafeError('ci_kv_invalid');
  const kv = only(source.kv_namespaces[0], ['binding', 'id']);
  if (kv.binding !== 'STATE' || typeof kv.id !== 'string' || !/^[a-f0-9]{32}$/.test(kv.id)) {
    throw new SafeError('ci_kv_invalid');
  }
  return { name: source.name, main: template.main, compatibility_date: template.compatibility_date,
    account_id: account, workers_dev: config.telegram?.enabled === true, preview_urls: false, send_metrics: false,
    triggers: { crons: [...template.triggers.crons] }, observability: { enabled: false },
    kv_namespaces: [{ binding: 'STATE', id: kv.id }], vars: { MONITOR_CONFIG: config } };
}
export async function runDeployment(env: Environment,
  io: { writeConfig(value: DeploymentConfig): Promise<void>; deploy(): Promise<number | null> }): Promise<void> {
  if (env.GITHUB_ACTIONS !== 'true') throw new SafeError('ci_only_command');
  const config = prepareDeployment(env);
  await io.writeConfig(config);
  if (await io.deploy() !== 0) throw new SafeError('ci_deploy_failed');
}
