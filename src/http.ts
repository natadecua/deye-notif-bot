import type { Dependencies } from './types.ts';
import { SafeError } from './errors.ts';

export function retryTime(value: string | number | null | undefined, now: number): number {
  if (value === null || value === undefined) return 0;
  const seconds = typeof value === 'number' ? value : /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  const at = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : Date.parse(String(value));
  return Number.isFinite(at) ? Math.max(now, at) : 0;
}

export async function jsonPost(url: string, body: unknown, headers: Record<string, string>,
  deps: Dependencies, service: 'deye' | 'telegram', attempts: 1 | 2): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let error: SafeError;
    try {
      const response = await deps.fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body), signal: AbortSignal.timeout(8000), redirect: 'manual',
      });
      let retryAt = retryTime(response.headers.get('Retry-After'), deps.now());
      if (!response.ok) {
        if (service === 'telegram' && response.status === 429) {
          try {
            const limited = await response.json() as { parameters?: { retry_after?: number } };
            retryAt = Math.max(retryAt, retryTime(limited.parameters?.retry_after, deps.now()));
          } catch { /* Malformed error bodies never cross the logging boundary. */ }
        } else {
          await response.body?.cancel();
        }
        throw new SafeError(`${service}_http_${response.status === 429 ? 'rate_limited' :
          response.status === 401 ? 'unauthorized' : response.status === 408 ? 'timeout' :
            response.status >= 500 ? 'server_error' : 'rejected'}`,
          response.status === 408 || response.status === 429 || response.status >= 500,
          retryAt, response.status === 401);
      }
      const raw = await response.text();
      if (raw.length > 256_000) throw new SafeError(`${service}_response_too_large`);
      let data: unknown;
      try { data = JSON.parse(raw); } catch { throw new SafeError(`${service}_invalid_json`, true); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new SafeError(`${service}_invalid_response`);
      return data as Record<string, unknown>;
    } catch (e) {
      error = e instanceof SafeError ? e : new SafeError(`${service}_network_error`, true);
    }
    const wait = Math.max(500 * 2 ** attempt + Math.floor(deps.random() * 250), error.retryAt - deps.now());
    // Honor long Retry-After across scheduled invocations, never shorten it to retry now.
    if (!error.retryable || attempt + 1 === attempts || wait > 2000) throw error;
    await deps.sleep(wait);
  }
  throw new SafeError(`${service}_retry_exhausted`);
}
