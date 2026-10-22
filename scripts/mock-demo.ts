import { runMonitor } from '../src/monitor.ts';
import { harness } from '../test/helpers.ts';

console.log('SYNTHETIC demo only — all Deye, Telegram and KV calls are in-memory mocks.');
const h = harness();
for (const [soc, discharge] of [[99, 0], [100, 420], [100, 420], [96, 50], [99, 400], [99, 500]]) {
  h.reading(soc, discharge);
  console.log({ soc, dischargeWatts: discharge, events: await runMonitor(h.env, h.deps) });
  h.advance();
}
for (const text of h.sent) console.log('\nMock Telegram message:\n' + text);
