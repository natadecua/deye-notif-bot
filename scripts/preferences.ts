import type { ChargingProfile, Config, EVConfig, NotificationPreferences } from '../src/types.ts';
import { notificationPreferences, validateConfig } from '../src/config.ts';
import { SafeError } from '../src/errors.ts';
import { MAX_PROFILES, MAX_PROFILE_AMPS, profileSummary, validateChargingProfiles } from '../src/profiles.ts';

export type InputValidator<T> = (value: T) => true | string;
export interface PreferencePrompts {
  checklist(message: string, choices: { name: string; value: string; checked: boolean }[]): Promise<string[]>;
  choose(message: string, choices: { name: string; value: string }[], initial?: string): Promise<string>;
  confirm(message: string, initial: boolean): Promise<boolean>;
  number(message: string, initial?: number, validate?: InputValidator<number>): Promise<number>;
  text(message: string, initial?: string, validate?: InputValidator<string>): Promise<string>;
  print(message: string): void;
}

export async function configureNotifications(current: Config['notifications'], p: PreferencePrompts): Promise<NotificationPreferences> {
  const selected = await p.checklist('Which battery updates would you like? Space toggles an option; Enter continues.', [
    { name: 'House battery is full', value: 'full', checked: current?.full ?? true },
    { name: 'House battery is supplying sustained power', value: 'discharge', checked: current?.discharge ?? true },
  ]);
  if (!Array.isArray(selected) || selected.some(k => !['full', 'discharge'].includes(k))) {
    throw new SafeError('notification_preferences_invalid');
  }
  return { full: selected.includes('full'), discharge: selected.includes('discharge') };
}

export async function configureChargingProfiles(ev: EVConfig, p: PreferencePrompts): Promise<ChargingProfile[] | undefined> {
  const choices = [
    { name: 'Enter my own supported charging settings', value: 'custom' },
    { name: 'Use an 8 A / 13 A / MAX example, then confirm its nominal MAX power', value: '8-13-max' },
    { name: 'No fixed profiles; use the existing approximate reduction hint', value: 'none' },
  ];
  if (ev.profiles) choices.unshift({ name: 'Keep my existing confirmed profiles', value: 'keep' });
  const mode = await p.choose('Which charging settings can you actually select in your car or charger?', choices,
    ev.profiles ? 'keep' : 'custom');
  if (mode === 'none') return undefined;
  let profiles: ChargingProfile[];
  if (mode === 'keep') {
    if (!ev.profiles) throw new SafeError('charging_profiles_invalid');
    profiles = structuredClone(ev.profiles);
  } else if (mode === '8-13-max') {
    if (!ev.minimumAmps || ev.minimumAmps > 8) throw new SafeError('charging_profiles_invalid');
    const minimumMaxPower = 13 * ev.phases! * ev.voltage!;
    const nominalWatts = await p.number('MAX nominal/rated power (W), as documented for your setup. This is NOT measured charging power:',
      undefined, n => Number.isFinite(n) && n >= minimumMaxPower &&
        n <= MAX_PROFILE_AMPS * ev.phases! * ev.voltage! ||
          `MAX must be at least ${minimumMaxPower} W to support this preset's 13 A setting. Choose custom settings if it is lower.`);
    if (nominalWatts < minimumMaxPower) throw new SafeError('charging_profiles_invalid');
    profiles = [
      { id: '8a', label: '8 A', type: 'amps', amps: 8 },
      { id: '13a', label: '13 A', type: 'amps', amps: 13 },
      { id: 'max', label: 'MAX', type: 'power', nominalWatts },
    ];
  } else if (mode === 'custom') {
    const count = await p.number(`How many supported settings would you like to save (1–${MAX_PROFILES})?`, 3,
      n => Number.isInteger(n) && n >= 1 && n <= MAX_PROFILES || `Enter a whole number from 1 to ${MAX_PROFILES}.`);
    if (!Number.isInteger(count) || count < 1 || count > MAX_PROFILES) throw new SafeError('charging_profiles_invalid');
    profiles = [];
    for (let i = 0; i < count; i++) {
      const label = await p.text(`Name for setting ${i + 1}:`, `Setting ${i + 1}`,
        s => s.length >= 1 && s.length <= 40 && s === s.trim() && !/[\u0000-\u001f\u007f]/.test(s) ||
          'Use 1–40 characters on one line, without leading/trailing spaces.');
      const type = await p.choose('How is this setting specified?', [
        { name: 'Current in amperes (A)', value: 'amps' },
        { name: 'Nominal power in watts (W), such as MAX', value: 'power' },
      ]);
      if (type === 'amps') {
        const amps = await p.number(`Supported current for ${label} (A):`, ev.minimumAmps,
          n => Number.isFinite(n) && n >= ev.minimumAmps! && n <= MAX_PROFILE_AMPS ||
            'Enter a supported current at or above the confirmed minimum.');
        profiles.push({ id: `profile-${i + 1}`, label, type, amps });
      } else if (type === 'power') {
        const nominalWatts = await p.number(`Nominal/rated power for ${label} (W), not measured EV power:`,
          undefined, n => Number.isFinite(n) && n >= ev.minimumAmps! * ev.phases! * ev.voltage! &&
            n <= MAX_PROFILE_AMPS * ev.phases! * ev.voltage! || 'Enter a power rating within the confirmed electrical limits.');
        profiles.push({ id: `profile-${i + 1}`, label, type, nominalWatts });
      } else throw new SafeError('charging_profiles_invalid');
    }
  } else throw new SafeError('charging_profiles_invalid');
  validateChargingProfiles({ ...ev, profiles });
  p.print('Configured options (power is a nominal estimate, not actual EV telemetry):\n' +
    profiles.map(profile => `  ${profileSummary(profile, ev)}`).join('\n'));
  return profiles;
}

export function preferencesSummary(c: Config): string {
  const n = notificationPreferences(c);
  const lines = [
    `Battery full: ${n.full ? `on at ${c.fullSoc}% SOC; re-arm below ${c.fullRearmSoc}%` : 'off'}`,
    `Battery supplying power: ${n.discharge ? `on above ${c.dischargeWatts} W in two distinct fresh readings; re-arm below ${c.dischargeRearmWatts} W` : 'off'}`,
    `Manual EV hints: ${c.ev.enabled ? n.discharge ? 'on; EV status/current remain unknown' :
      'saved, but discharge notifications are off' : 'off'}`,
  ];
  if (c.ev.enabled && c.ev.profiles?.length) {
    lines.push('Supported settings: ' + c.ev.profiles.map(profile => profileSummary(profile, c.ev)).join('; '));
  }
  if (!n.full && !n.discharge) lines.push('All battery notifications are off. Cycles will still be tracked while the monitor runs.');
  lines.push('Advice only; no inverter or charger controls. Forecast planning and Telegram settings menus are not active.');
  return lines.join('\n');
}

export async function configurePreferences(source: Config, p: PreferencePrompts): Promise<Config> {
  const c = structuredClone(source);
  c.notifications = await configureNotifications(c.notifications, p);
  if (await p.confirm('Customize notification thresholds and reading freshness? (Advanced)', false)) {
    p.print('Changing thresholds or freshness interpretation starts new battery alert cycles after deployment.');
    c.fullSoc = await p.number('Full-charge SOC threshold (%):', c.fullSoc,
      n => Number.isFinite(n) && n > 0 && n <= 100 || 'Enter a percentage above 0 and at most 100.');
    c.fullRearmSoc = await p.number('Re-arm the full alert strictly below SOC (%):', c.fullRearmSoc,
      n => Number.isFinite(n) && n >= 0 && n < c.fullSoc || 'The re-arm SOC must be below the full threshold.');
    c.dischargeWatts = await p.number('Discharge must exceed this many watts in two distinct fresh readings:', c.dischargeWatts,
      n => Number.isFinite(n) && n > 0 || 'Enter a positive watt threshold.');
    c.dischargeRearmWatts = await p.number('Re-arm the discharge alert strictly below (W):', c.dischargeRearmWatts,
      n => Number.isFinite(n) && n >= 0 && n < c.dischargeWatts || 'The re-arm watts must be below the discharge threshold.');
    c.maxAgeSeconds = await p.number('Reject readings older than (seconds):', c.maxAgeSeconds,
      n => Number.isFinite(n) && n >= 60 && n <= 3600 || 'Choose 60–3600 seconds; do not use this to hide timezone errors.');
    c.maxGapSeconds = await p.number('Reset confirmation after a reading gap of (seconds):', c.maxGapSeconds,
      n => Number.isFinite(n) && n >= 300 && n <= 3600 || 'Choose 300–3600 seconds.');
  }
  if (!await p.confirm('Would you like manual EV charging hints in discharge notifications?', c.ev.enabled)) {
    c.ev = { ...c.ev, enabled: false };
  } else {
    const reuse = c.ev.confirmed === true && await p.confirm('Keep your previously confirmed phase, voltage and minimum-current settings?', true);
    if (!reuse) {
      const phases = await p.choose('Confirm the actual charging configuration:', [
        { name: 'Single-phase', value: '1' }, { name: 'Balanced three-phase', value: '3' },
      ]);
      if (!['1', '3'].includes(phases)) throw new SafeError('ev_config_unconfirmed');
      const voltage = await p.number('Confirmed line-to-neutral voltage (V), e.g. 230 rather than 400:',
        undefined, n => Number.isFinite(n) && n >= 100 && n <= 300 || 'Enter the confirmed line-to-neutral voltage, between 100 and 300 V.');
      const minimumAmps = await p.number('Lowest supported/selectable current shared by your car and charger (A):',
        undefined, n => Number.isFinite(n) && n > 0 && n <= MAX_PROFILE_AMPS || 'Enter the documented positive minimum current.');
      c.ev = { enabled: true, confirmed: true, phases: Number(phases) as 1 | 3, voltage, minimumAmps };
    } else c.ev.enabled = true;
    c.ev.profiles = await configureChargingProfiles(c.ev, p);
    c.ev.confirmed = await p.confirm('I verified phases, line-to-neutral voltage, minimum current and any saved profiles. I will check the car before changing its setting.', false);
    if (!c.ev.confirmed) throw new SafeError('ev_config_unconfirmed');
  }
  validateConfig(c);
  p.print('\nYour notification preferences:\n' + preferencesSummary(c));
  return c;
}
