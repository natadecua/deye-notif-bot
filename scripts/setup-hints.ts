import { telegramSetupHint } from './telegram-onboarding.ts';

export function setupHint(code: string): string | undefined {
  switch (code) {
    case 'deye_auth_rejected':
    case 'deye_secrets_invalid':
      return 'Check the Deye developer-app credentials and account region privately, then rerun npm run setup. Keep passwords, hashes and raw responses private.';
    case 'no_stations_in_selected_region_or_company':
      return 'Check the selected Deye region, account access and personal/company context, then rerun npm run setup. Do not guess a station ID.';
    case 'measurement_missing_or_invalid':
      return 'Stop setup and consult docs/DEYE-API.md for the station adapter. Missing battery fields must be verified before enabling monitoring.';
    case 'measurements_not_confirmed':
      return 'Verify power units, discharge direction, SOC scale and UTC reading time against the Deye app/documentation before rerunning npm run setup.';
    case 'timestamp_ambiguous':
    case 'timestamp_invalid':
    case 'reading_future':
      return 'Verify the API timestamp format and UTC offset in docs/DEYE-API.md. Do not hide a timezone error by extending the freshness limit.';
    case 'reading_stale':
      return 'Wait for a fresh Deye reading and compare its source time with the app, then retry setup. Keep the existing freshness limit.';
    case 'weather_eligibility_not_confirmed':
      return 'Rerun npm run weather:setup and leave weather off unless this installation qualifies for free non-commercial access. Battery alerts can work without weather.';
    case 'weather_config_invalid':
      return 'Rerun npm run weather:setup with a valid approximate latitude and longitude; city-level coordinates are sufficient. No API key is required.';
    case 'weather_setup_not_confirmed':
    case 'daytime_setup_not_confirmed':
      return 'This preference change was not saved. Rerun its setup command when ready; deployment remains a separate manual step.';
    default:
      return telegramSetupHint(code);
  }
}
