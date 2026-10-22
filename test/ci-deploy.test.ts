import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { prepareDeployment, runDeployment } from '../scripts/ci-deploy.ts';
import { config } from './helpers.ts';

// All account, namespace, Worker and token values in these tests are synthetic.
const template = JSON.parse(readFileSync(new NodeURL('../wrangler.example.jsonc', import.meta.url), 'utf8'));
const account = 'a'.repeat(32);
function settings() {
  return { ...structuredClone(template), name: 'synthetic-monitor',
    kv_namespaces: [{ binding: 'STATE', id: 'b'.repeat(32) }],
    vars: { MONITOR_CONFIG: config({ fullSoc: 98, fullRearmSoc: 95 }) } };
}
function environment() {
  return { GITHUB_ACTIONS: 'true', CLOUDFLARE_ACCOUNT_ID: account,
    CLOUDFLARE_API_TOKEN: 'synthetic-not-a-valid-token', WORKER_CONFIG_JSON: JSON.stringify(settings()) };
}

test('CI deployment keeps confirmed owner settings and bindings without provider credentials', () => {
  const result = prepareDeployment(environment());
  assert.equal(result.name, 'synthetic-monitor');
  assert.equal(result.account_id, account);
  assert.deepEqual(result.vars.MONITOR_CONFIG, settings().vars.MONITOR_CONFIG);
  assert.deepEqual(result.kv_namespaces, settings().kv_namespaces);
  assert.equal(result.workers_dev, false);
  assert.equal(result.preview_urls, false);
  assert.deepEqual(result.triggers, { crons: ['*/5 * * * *'] });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-not-a-valid-token/);
});

test('CI deployment requires explicit account, token and configuration', () => {
  for (const key of ['WORKER_CONFIG_JSON', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']) {
    assert.throws(() => prepareDeployment({ ...environment(), [key]: '' }), /ci_deployment_secrets_missing/);
  }
  assert.throws(() => prepareDeployment({ ...environment(), WORKER_CONFIG_JSON: '{synthetic-invalid' }), /ci_config_invalid_json/);
});

test('CI deployment rejects disabled/unconfirmed monitors and incomplete or mismatched bindings', () => {
  for (const change of [
    (s: ReturnType<typeof settings>) => { s.vars.MONITOR_CONFIG.enabled = false; },
    (s: ReturnType<typeof settings>) => { s.vars.MONITOR_CONFIG.measurementsConfirmed = false; },
    (s: ReturnType<typeof settings>) => { s.kv_namespaces[0].id = 'REPLACE_WITH_YOUR_KV_NAMESPACE_ID'; },
    (s: ReturnType<typeof settings>) => { s.account_id = 'c'.repeat(32); },
  ]) {
    const s = settings(); change(s);
    assert.throws(() => prepareDeployment({ ...environment(), WORKER_CONFIG_JSON: JSON.stringify(s) }));
  }
  assert.throws(() => prepareDeployment({ ...environment(), CLOUDFLARE_ACCOUNT_ID: 'synthetic-invalid' }), /ci_account_invalid/);
});

test('CI deployment refuses provider credentials and unsupported configuration instead of publishing them', () => {
  for (const change of [
    (s: ReturnType<typeof settings>) => { s.vars.DEYE_APP_SECRET = 'synthetic-secret'; },
    (s: ReturnType<typeof settings>) => { s.vars.MONITOR_CONFIG.TELEGRAM_BOT_TOKEN = 'synthetic-secret'; },
    (s: ReturnType<typeof settings>) => { s.vars.MONITOR_CONFIG.ev.password = 'synthetic-secret'; },
    (s: ReturnType<typeof settings>) => { s.routes = ['synthetic.invalid/*']; },
  ]) {
    const s = settings(); change(s);
    assert.throws(() => prepareDeployment({ ...environment(), WORKER_CONFIG_JSON: JSON.stringify(s) }), /ci_config_unsupported_field/);
  }
});

test('CI deployment cannot enable a public URL, another entry point or a faster Cron', () => {
  for (const change of [
    (s: ReturnType<typeof settings>) => { s.workers_dev = true; },
    (s: ReturnType<typeof settings>) => { s.preview_urls = true; },
    (s: ReturnType<typeof settings>) => { s.main = 'synthetic-other.ts'; },
    (s: ReturnType<typeof settings>) => { s.triggers.crons = ['* * * * *']; },
  ]) {
    const s = settings(); change(s);
    assert.throws(() => prepareDeployment({ ...environment(), WORKER_CONFIG_JSON: JSON.stringify(s) }), /ci_config_policy_invalid/);
  }
});

test('CI deployment validates before writing and deploys only after the configuration is saved', async () => {
  const calls: string[] = [];
  const io = {
    writeConfig: async (value: unknown) => { assert.deepEqual(value, prepareDeployment(environment())); calls.push('write'); },
    deploy: async () => { calls.push('deploy'); return 0; },
  };
  await runDeployment(environment(), io);
  assert.deepEqual(calls, ['write', 'deploy']);
  calls.length = 0;
  await assert.rejects(runDeployment({ ...environment(), WORKER_CONFIG_JSON: '' }, io), /ci_deployment_secrets_missing/);
  assert.deepEqual(calls, []);
  await assert.rejects(runDeployment({ ...environment(), GITHUB_ACTIONS: '' }, io), /ci_only_command/);
  assert.deepEqual(calls, []);
});

test('failed deployment exits as failure and persistence failure never starts deployment', async () => {
  await assert.rejects(runDeployment(environment(), {
    writeConfig: async () => {}, deploy: async () => 1,
  }), /ci_deploy_failed/);
  let deployed = false;
  await assert.rejects(runDeployment(environment(), {
    writeConfig: async () => { throw new Error('synthetic-write-failure'); },
    deploy: async () => { deployed = true; return 0; },
  }));
  assert.equal(deployed, false);
});
