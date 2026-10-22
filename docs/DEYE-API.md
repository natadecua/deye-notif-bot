# Deye API verification and adapter boundaries

Reviewed **2026-10-21**. Public schemas/samples were retrieved; **no authenticated installation was available**. “Verified” here means confirmed against those published artifacts, not a successful live request.

## Sources and concrete findings

- [REST documentation](https://developer.deyecloud.com/api). Its public SPA loads Swagger v2 schemas at `https://{regional-developer-host}/v2/api-docs`.
- [Open MCP tool schemas](https://developer.deyecloud.com/openmcp/docs/deye-open-mcp-tools.html) corroborate response field names. This Worker calls REST directly, not MCP.
- [Best practices](https://developer.deyecloud.com/best-practices): logger uploads every one or five minutes depending on configuration/data type; plant summaries cached/refreshed at most every five minutes; reuse tokens and use backoff. More polling does not make data fresher. The portal also warns about forthcoming API metering, base quotas and rate controls; follow current terms.
- [Official client sample](https://github.com/DeyeCloudDevelopers/deye-openapi-client-sample-code), `master` branch: `clientcode/variable.py`, `account/obtain_token.py`, `station/obtain_station_latest.py`, `station/obtain_station_list.py`, and device latest/measurement-point samples. Only request schemas were consulted; sample control operations are not part of this project.

All three regional Swagger URLs were retrieved. The published schema contained a malformed example array (`[12583SS]` with an unquoted string); the developer's research parser corrected that one example locally to inspect the definitions. It is not a live response or an application workaround.

| Region | REST base URL |
| --- | --- |
| `eu` (EMEA/APAC) | `https://eu1-developer.deyecloud.com/v1.0` |
| `am` (Americas) | `https://us1-developer.deyecloud.com/v1.0` |
| `india` | `https://india-developer.deyecloud.com/v1.0` |

The developer portal's ordinary account host (e.g. `eu1.deyecloud.com`) is distinct from the developer REST host. The official Python sample explicitly lists EU and US developer hosts; the current portal configuration/Swagger also confirms India. The project does not accept arbitrary hosts or silently switch regions after an authentication failure.

| Endpoint | Method/body | Response consumed |
| --- | --- | --- |
| `/account/token?appId=…` | POST `{appSecret, email|username|mobile, password, companyId?, countryCode?}` | Top-level `success`, `accessToken`, `expiresIn` |
| `/station/list` | POST `{page, size}` | Top-level `success`, `stationList[]`, `total`; station `id`, `name`, `regionTimezone` |
| `/station/latest` | POST `{stationId}` | Top-level `success`, `batterySOC`, `dischargePower`, `lastUpdateTime` |
| `/device/measurePoints` | POST `{deviceSn, deviceType?}` | Discovery only: `measurePoints[]`, `timeZone` in documented response |
| `/device/latest` | POST `{deviceList: [deviceSn], deviceType?}` | Discovery/extension only: `deviceDataList[].collectionTime`, `dataList[]` |

Authentication hashes the UTF-8 plaintext password with SHA-256 and submits lowercase hex, matching the official sample. `companyId` selects business context and is submitted as a JSON integer per the current REST schema (the official Python sample uses a string); omitting it uses the personal user. Mobile login requires country code. Protected requests use the `Authorization: Bearer <token>` header. Token examples show both a bearer-prefixed accessToken and an expiresIn value of 5,183,999 seconds; runtime supports prefixed/unprefixed tokens, numeric or numeric-string expiry and actual returned lifetime.

Station latest explicitly exposes batterySOC, dischargePower, chargePower, batteryPower, generationPower, consumptionPower, purchasePower, gridPower and lastUpdateTime. The published response is **not nested in `data`**. The mock fixtures follow these top-level schemas but contain invented values.

## What the schema does not establish

The current `stationLatestDataResponse` definition gives power fields `number/double` types without units or direction descriptions. It gives `lastUpdateTime` type `string/date-time` without a timezone convention. Station-list examples also show epoch numbers in time fields despite string date-time declarations. These ambiguities prevent a defensible universal unit/time assumption.

Consequently:

- Setup requires the user to compare a representative non-zero API reading with the Deye app, installer documentation or independently understood device measurements, and choose **W or kW**. It prints normalized watts before asking for confirmation. Confirm SOC is percent, not a fraction.
- This v1 adapter uses only the dedicated, confirmed **non-negative `dischargePower`** as battery supply. It rejects negative values. It never applies `abs()` to `batteryPower`, assumes a signed direction, subtracts generation from consumption, or identifies EV demand from house power. Verify this field against actual charging/discharging behavior before enabling monitoring.
- Timestamp formats are explicitly configured. ISO input must include `Z` or a numeric UTC offset. Numeric epoch formats are supported only after explicit seconds/milliseconds selection; they are absolute UTC. There is no magnitude-based guessing or reliance on the laptop/Worker timezone.
- The selected station's timezone metadata is displayed for cross-checking. It is **not** applied to offset-less strings. A bare local date/time can be ambiguous during daylight-saving transitions; that format is currently unsupported and setup stops. Do not append `Z` to make it pass.
- Missing/null SOC or discharge makes the reading invalid. No device-specific fallback or multi-inverter/battery aggregation is automatically selected. If station SOC combines several batteries, verify it represents the battery you actually want to monitor.

## If station data is insufficient

The read-only `DeyeClient.read` allowlist supports `/device/measurePoints` and `/device/latest`. Use their documented schemas to inspect the device's actual point names, units, collection timestamps and meaning. `collectionTime` is explicitly documented as Unix seconds in device latest, unlike the ambiguous station date-time field. Unit/sign conventions still need device-specific evidence.

Do not auto-enable a guessed device mapping. A future device adapter should have an explicit device selection, verified point names, SOC scale, units, positive discharge direction, timestamp semantics, battery aggregation policy and synthetic regression tests. Add a sanitised/consented schema example before claiming live support. For now, a station that fails the strict adapter cannot be monitored with v1 without such an extension.

No custom-notification webhook was verified in the reviewed sources. The design polls. The REST client allowlist omits every inverter/charger control, order, configuration and strategy operation.
