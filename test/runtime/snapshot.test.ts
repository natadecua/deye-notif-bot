import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';
import { config, BASE_TIME } from '../helpers.ts';
import { initialState } from '../../src/alerts.ts';

test('workerd pure snapshot uses explicit local labels with commands off and zero outbound IO', async () => {
  // Synthetic renderer harness only. This is not a production recap endpoint/dispatch test.
  const c = config({ telegram: { enabled: false }, dataHealth: {
    enabled: true, warnAfterMinutes: 30, delivery: 'all-hours', allHoursConfirmed: true } });
  const at = BASE_TIME - 600001, state = { ...initialState(c), lastReadingAt: at,
    latestReading: { at, soc: 55, dischargeWatts: 315 }, apiRetryAt: BASE_TIME + 60000,
    weather: { private: 'synthetic-private-weather' }, dataHealth: { private: 'synthetic-private-health' } };
  const source = `import { renderBriefSnapshot } from './snapshot.ts';
    export default { fetch() { return new Response(renderBriefSnapshot(${JSON.stringify(state)},
      ${JSON.stringify(c)}, ${BASE_TIME}, undefined, { kind: 'recap', timeZone: 'Asia/Manila' })); } };`;
  const bundled = await build({ stdin: { contents: source, resolveDir: fileURLToPath(new NodeURL('../../src/', import.meta.url)),
    sourcefile: 'snapshot.synthetic.ts', loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  let outbound = 0;
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text,
    cf: false, compatibilityDate: '2026-10-01', log: new Log(LogLevel.NONE),
    outboundService: async () => { outbound++; throw new Error('Unexpected synthetic outbound request'); },
  }));
  try {
    const response = await runtime.dispatchFetch('https://synthetic.invalid/');
    assert.equal(response.status, 200); const text = await response.text();
    assert.match(text, /Battery snapshot · daily recap/); assert.match(text, /Charge: 55%/);
    assert.match(text, /stale — not current/); assert.match(text, /Asia\/Manila \(UTC\+08:00\)/);
    assert.match(text, /Updates: cooldown.*Cause unknown/); assert.match(text, /EV charging: unknown/);
    assert.doesNotMatch(text, /\/(?:status|settings)|synthetic-private|stationId|https?:\/\//);
    assert(text.length <= 1000); assert.equal(outbound, 0);
  } finally { await runtime.dispose(); }
});
