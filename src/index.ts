import { runMonitor } from './monitor.ts';
import { errorCode } from './errors.ts';
import type { Env } from './types.ts';
import { handleTelegramRequest } from './bot.ts';

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      // Fixed event codes only; no request URLs, telemetry, identifiers, or secrets.
      console.log(JSON.stringify({ events: await runMonitor(env) }));
    } catch (error) {
      console.error(JSON.stringify({ event: errorCode(error) }));
    }
  },
  async fetch(request?: Request, env?: Env): Promise<Response> {
    if (!request || !env) return new Response('Not found', { status: 404 });
    return handleTelegramRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
