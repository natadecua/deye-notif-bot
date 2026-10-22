import type { ChargingProfile, Config, EVConfig, NotificationPreferences } from '../src/types.ts';

export type InputValidator<T> = (value: T) => true | string;
export interface PreferencePrompts {
  checklist(message: string, choices: { name: string; value: string; checked: boolean }[]): Promise<string[]>;
  choose(message: string, choices: { name: string; value: string }[], initial?: string): Promise<string>;
  confirm(message: string, initial: boolean): Promise<boolean>;
  number(message: string, initial?: number, validate?: InputValidator<number>): Promise<number>;
  text(message: string, initial?: string, validate?: InputValidator<string>): Promise<string>;
  print(message: string): void;
}

// Existing setup behavior, exposed here before adding the preference flow.
export async function configureNotifications(_current: Config['notifications'], _p: PreferencePrompts): Promise<NotificationPreferences> {
  return { full: true, discharge: true };
}
export async function configureChargingProfiles(_ev: EVConfig, _p: PreferencePrompts): Promise<ChargingProfile[] | undefined> {
  return undefined;
}
export async function configurePreferences(c: Config, _p: PreferencePrompts): Promise<Config> {
  return structuredClone(c);
}
