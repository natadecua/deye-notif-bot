import type { ChargingProfile, EVConfig } from './types.ts';
import { SafeError } from './errors.ts';

export const MAX_PROFILES = 12;
export const MAX_PROFILE_AMPS = 100;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function nominalProfileWatts(profile: ChargingProfile, ev: EVConfig): number {
  if (ev.confirmed !== true || ![1, 3].includes(ev.phases!) || !finite(ev.voltage) ||
      ev.voltage < 100 || ev.voltage > 300) throw new SafeError('ev_config_unconfirmed');
  // A named MAX power rating never becomes an inferred actual amperage.
  return profile.type === 'amps' ? profile.amps * ev.phases! * ev.voltage : profile.nominalWatts;
}

export function validateChargingProfiles(ev: EVConfig): void {
  if (ev.profiles === undefined) return;
  if (ev.confirmed !== true || ![1, 3].includes(ev.phases!) || !finite(ev.voltage) ||
      ev.voltage < 100 || ev.voltage > 300 || !finite(ev.minimumAmps) ||
      ev.minimumAmps <= 0 || ev.minimumAmps > MAX_PROFILE_AMPS) {
    throw new SafeError('ev_config_unconfirmed');
  }
  if (!Array.isArray(ev.profiles) || ev.profiles.length < 1 || ev.profiles.length > MAX_PROFILES) {
    throw new SafeError('charging_profiles_invalid');
  }
  const ids = new Set<string>(), labels = new Set<string>();
  for (const profile of ev.profiles) {
    if (!profile || typeof profile !== 'object' ||
        typeof profile.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile.id) ||
        typeof profile.label !== 'string' || profile.label.length < 1 || profile.label.length > 40 ||
        profile.label !== profile.label.trim() || /[\u0000-\u001f\u007f]/.test(profile.label) ||
        ids.has(profile.id) || labels.has(profile.label.toLowerCase())) {
      throw new SafeError('charging_profiles_invalid');
    }
    ids.add(profile.id); labels.add(profile.label.toLowerCase());
    const raw = profile as unknown as Record<string, unknown>;
    if (profile.type === 'amps') {
      if (!finite(profile.amps) || profile.amps < ev.minimumAmps || profile.amps > MAX_PROFILE_AMPS ||
          Object.hasOwn(raw, 'nominalWatts')) throw new SafeError('charging_profiles_invalid');
    } else if (profile.type === 'power') {
      const wattsPerAmp = ev.phases! * ev.voltage;
      if (!finite(profile.nominalWatts) || profile.nominalWatts < ev.minimumAmps * wattsPerAmp ||
          profile.nominalWatts > MAX_PROFILE_AMPS * wattsPerAmp || Object.hasOwn(raw, 'amps')) {
        throw new SafeError('charging_profiles_invalid');
      }
    } else throw new SafeError('charging_profiles_invalid');
  }
}

export function profileSummary(profile: ChargingProfile, ev: EVConfig): string {
  const kw = (nominalProfileWatts(profile, ev) / 1000).toFixed(2).replace(/\.?0+$/, '');
  if (profile.type === 'power') return `${profile.label}: ~${kw} kW (nominal power, amperage unspecified)`;
  const amps = `${profile.amps} A`;
  const label = profile.label === amps ? amps : `${profile.label}: ${amps}`;
  return `${label} (~${kw} kW${ev.phases === 3 ? ' total, balanced three-phase' : ''})`;
}

export function chargingProfileReference(ev: EVConfig): string {
  if (!ev.enabled || !ev.profiles?.length) return '';
  return 'Your configured settings (nominal estimates):\n' +
    ev.profiles.map(p => profileSummary(p, ev)).join('\n') +
    '\nBattery discharge does not measure EV power; solar or grid may supply part of charging demand.';
}
