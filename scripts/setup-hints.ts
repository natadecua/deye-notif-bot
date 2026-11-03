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
    case 'health_setup_not_confirmed':
    case 'recap_setup_not_confirmed':
    case 'quiet_setup_not_confirmed':
    case 'grid_setup_not_confirmed':
      return 'This preference change was not saved. Rerun its setup command when ready; deployment remains a separate manual step.';
    case 'grid_config_invalid':
      return 'Review ignored wrangler.jsonc privately: correct or omit only MONITOR_CONFIG.gridImport, then rerun npm run grid:setup. Verify the device point, W units, direction, timestamp and metering scope independently; enter separate grid thresholds/duration and all-hours consent. Keep battery settings. Cleanup requires monitoring enabled before rollback.';
    case 'grid_device_required':
      return 'Set GRID_DEVICE_SN privately in ignored .dev.vars for the independently verified device, then upload secrets manually. Never guess a device or copy a synthetic identifier.';
    case 'quiet_hours_config_invalid':
      return 'Review ignored wrangler.jsonc privately: correct or omit only MONITOR_CONFIG.quietHours, then rerun npm run quiet:setup. Enter a matching explicit timezone, distinct five-minute local boundaries, all four category choices and suppression consent. Apply manually; keep monitoring enabled and verify quiet-only cleanup before rollback; preserve battery/health/recap settings.';
    case 'data_health_config_invalid':
      return 'Review ignored wrangler.jsonc privately: correct or omit only MONITOR_CONFIG.dataHealth, then rerun npm run health:setup. Duration must be 15–120 whole minutes and longer than freshness; daytime requires an existing window and all-hours requires nighttime consent. Apply changes manually; keep monitoring enabled for health-only cleanup before rollback.';
    case 'daily_recap_config_invalid':
      return 'Review ignored wrangler.jsonc privately: correct or omit only MONITOR_CONFIG.dailyRecap, then rerun npm run recap:setup. Enter an explicit valid timezone matching any daytime rule, whole hour 0–23, minute 0–55 in five-minute steps and schedule consent. Apply manually; keep monitoring enabled for recap-only cleanup before rollback.';
    default:
      return telegramSetupHint(code);
  }
}
