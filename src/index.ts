import { runMonitor } from './monitor.ts';
import { errorCode } from './errors.ts';
import type { Env } from './types.ts';

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      // Fixed event codes only; no request URLs, telemetry, identifiers, or secrets.
      console.log(JSON.stringify({ events: await runMonitor(env) }));
    } catch (error) {
      console.error(JSON.stringify({ event: errorCode(error) }));
    }
  },
  async fetch(): Promise<Response> {
    // No public endpoint for polling, config, secrets, health data, or manual sends.
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
