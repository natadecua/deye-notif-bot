import { HOSTS } from './config.ts';
import { SafeError } from './errors.ts';
import { jsonPost } from './http.ts';
import { defaults, type Config, type Dependencies, type KVStore, type Secrets, type Token } from './types.ts';

export async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export function validateDeyeSecrets(s: Secrets): void {
  if (!s.DEYE_APP_ID || !s.DEYE_APP_SECRET || !s.DEYE_ACCOUNT ||
      !/^[a-fA-F0-9]{64}$/.test(s.DEYE_PASSWORD_SHA256 ?? '') ||
      !['email', 'username', 'mobile'].includes(s.DEYE_ACCOUNT_FIELD ?? 'email') ||
      ((s.DEYE_ACCOUNT_FIELD === 'mobile') && !/^\d+$/.test(s.DEYE_COUNTRY_CODE ?? '')) ||
      (s.DEYE_COMPANY_ID !== undefined && (!/^\d+$/.test(s.DEYE_COMPANY_ID) ||
        !Number.isSafeInteger(Number(s.DEYE_COMPANY_ID))))) {
    throw new SafeError('deye_secrets_invalid');
  }
}

// Explicit read-only allowlist. This client has no inverter/charger control API.
type ReadPath = '/station/list' | '/station/latest' | '/device/measurePoints' | '/device/latest';
export class DeyeClient {
  private token?: Token;
  private fromCache = false;
  private context?: string;
  constructor(private c: Config, private secrets: Secrets, private kv?: KVStore,
    private deps: Dependencies = defaults) { validateDeyeSecrets(secrets); }

  private async authenticate(force = false): Promise<Token> {
    if (!force && this.token && this.token.expiresAt > this.deps.now() + 60_000) return this.token;
    const s = this.secrets;
    this.context ??= await sha256(JSON.stringify([this.c.region, s.DEYE_APP_ID, s.DEYE_APP_SECRET,
      s.DEYE_ACCOUNT, s.DEYE_ACCOUNT_FIELD, s.DEYE_PASSWORD_SHA256, s.DEYE_COMPANY_ID, s.DEYE_COUNTRY_CODE]));
    if (!force && this.kv) {
      const raw = await this.kv.get('auth:v1');
      if (raw) {
        try {
          const cached = JSON.parse(raw);
          if (cached.context === this.context && typeof cached.authorization === 'string' &&
              /^Bearer [^\s]+$/.test(cached.authorization) && Number.isFinite(cached.expiresAt) &&
              cached.expiresAt > this.deps.now() + 60_000) {
            this.fromCache = true;
            return this.token = cached;
          }
        } catch { /* A malformed cache is replaceable; alert state is not. */ }
      }
    }
    const body: Record<string, unknown> = {
      appSecret: s.DEYE_APP_SECRET,
      [s.DEYE_ACCOUNT_FIELD ?? 'email']: s.DEYE_ACCOUNT,
      password: s.DEYE_PASSWORD_SHA256.toLowerCase(),
    };
    if (s.DEYE_COMPANY_ID !== undefined) body.companyId = Number(s.DEYE_COMPANY_ID);
    if (s.DEYE_ACCOUNT_FIELD === 'mobile') body.countryCode = s.DEYE_COUNTRY_CODE;
    const data = await jsonPost(`${HOSTS[this.c.region]}/account/token?appId=${encodeURIComponent(s.DEYE_APP_ID)}`,
      body, {}, this.deps, 'deye', 2);
    if (data.success !== true) throw new SafeError('deye_auth_rejected');
    const token = typeof data.accessToken === 'string' ? data.accessToken.replace(/^Bearer\s+/i, '') : '';
    const expiry = typeof data.expiresIn === 'number' ? data.expiresIn :
      typeof data.expiresIn === 'string' && /^\d+$/.test(data.expiresIn) ? Number(data.expiresIn) : NaN;
    if (!token || /\s/.test(token) || !Number.isFinite(expiry) || expiry <= 120 || expiry > 365 * 86400) {
      throw new SafeError('deye_auth_schema_invalid');
    }
    this.fromCache = false;
    this.token = { authorization: `Bearer ${token}`, expiresAt: this.deps.now() + expiry * 1000 };
    if (this.kv) await this.kv.put('auth:v1', JSON.stringify({ ...this.token, context: this.context }),
      { expirationTtl: Math.floor(expiry) });
    return this.token;
  }
  async read(path: ReadPath, body: unknown): Promise<Record<string, unknown>> {
    // Runtime guard also covers untyped JS consumers of this module.
    if (!['/station/list', '/station/latest', '/device/measurePoints', '/device/latest'].includes(path)) {
      throw new SafeError('deye_path_not_allowed');
    }
    await this.authenticate();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const data = await jsonPost(HOSTS[this.c.region] + path, body,
          { Authorization: this.token!.authorization }, this.deps, 'deye', 2);
        if (data.success !== true) throw new SafeError('deye_api_rejected');
        return data;
      } catch (error) {
        // Deye does not publish stable JSON auth error codes in the reviewed schema.
        // Once only, renew a cached token on 401 or an unsuccessful JSON envelope.
        // Never renew a token just acquired in this invocation, or retry 403/429 this way.
        if (attempt === 0 && this.fromCache && error instanceof SafeError &&
            (error.auth || error.code === 'deye_api_rejected')) {
          await this.authenticate(true);
          continue;
        }
        throw error;
      }
    }
    throw new SafeError('deye_retry_exhausted');
  }
  latest(): Promise<Record<string, unknown>> { return this.read('/station/latest', { stationId: this.c.stationId }); }
  async stations(page = 1): Promise<{ stations: Record<string, unknown>[]; total: number }> {
    const data = await this.read('/station/list', { page, size: 100 });
    if (!Array.isArray(data.stationList) || typeof data.total !== 'number' ||
        !Number.isSafeInteger(data.total) || data.total < 0 ||
        data.stationList.some(s => !s || typeof s !== 'object' || Array.isArray(s))) {
      throw new SafeError('deye_station_schema_invalid');
    }
    return { stations: data.stationList, total: data.total };
  }
}
