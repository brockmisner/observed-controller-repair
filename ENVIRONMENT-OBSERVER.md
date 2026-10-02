# Stakeout environment playback and Android readback

## What this implementation is

Two new Android APKs plus a controller integration for the existing Observatory project.
It reuses the existing route player, radio model, city datasets, serving-cell logic and
arrival lifecycle. It does not replace or deploy the production controller.

- **Environment Lab** (`net.stakeout.environment.lab`, loopback TCP 9996): an authenticated,
  leased store of synthetic application test frames. The lab UI displays the current frame.
  This is not an Android radio injector. Successful delivery is `STAGED_TEST_STATE`, with
  `applied: false`. It changes neither Android Wi-Fi/cellular APIs nor network associations.
- **Android Observer** (`net.stakeout.environment.observer`, loopback TCP 9997): a separate,
  read-only app that reads Android location, Wi-Fi scan cache, associated Wi-Fi BSSID,
  LTE/NR cell cache and explicitly requested BLE scans. Unknown values remain null.
  Location mock status is reported unchanged. No suppression or process hooks are included.

The protocol is `stakeout.environment`, version 1. It does **not** implement or replace the
repository's frozen `duoplus.radio` v1 applier protocol. Do not change `radioPluginPresent`
to true or use this receiver as evidence that the missing radio injector exists.

## Build

Requirements: Node 22 (or supported Node >=20), npm, Java 17, Gradle 8.7, Android SDK 34.
The GitHub workflow provisions Java/Gradle and builds both debug flavors.

```sh
npm ci
npm run prisma:generate
npm test
npm run build
bash scripts/test-environment-java.sh
gradle -p android/environment-observer test assembleDebug
```

APKs:

```
android/environment-observer/app/build/outputs/apk/lab/debug/app-lab-debug.apk
android/environment-observer/app/build/outputs/apk/observer/debug/app-observer-debug.apk
```

Debug builds intentionally support app-private provisioning via `run-as`. These are test
artifacts, not signed production releases. Do not place credentials in Git, URLs or APKs.

## Install on one explicitly selected DuoPlus image

Use the controller host that already has authorized ADB access. Configure the existing
`DUOMOVE_PLAYER_TARGETS` mapping with a dedicated endpoint for each image and its existing
player configuration. No shared ADB target fallback is added. Preserve existing player
settings and its control port. The lab and observer ports must not conflict with them.
Set `DUOMOVE_STATE_DIR` to the controller's persistent private directory.

```sh
npm run environment:provision -- --image IMAGE_ID --role lab --apk /absolute/path/app-lab-debug.apk
npm run environment:provision -- --image IMAGE_ID --role observer --apk /absolute/path/app-observer-debug.apk
```

Each command installs only the provided APK, writes the selected role's per-image key over
stdin into app-private storage, and opens that APK's activity. On the phone, grant observer
permissions, enable Android location as appropriate, and tap **Start receiver** in each app.
The apps require an explicit user-started foreground service and display a notification.
They do not start automatically after reboot. The observer does not hide mock flags.

The script does not select a mock provider, change scan throttling, launch Google apps,
modify SIM identifiers, or use a global device target. Selecting the wrong APK flavor is
an operator error; provisioning will fail if the requested package is absent.

## Use the existing controller UI

Sign into the correct workspace and select the phone. The new **Android environment
observer** panel has **Read Android APIs**. It shows the latest observed coordinates,
location age and mock flag, Wi-Fi scan ages and associated BSSID, and cellular/Bluetooth
availability. Failed reads retain the previous sample's age and are labeled failures.
Raw observations are returned by the endpoint and the latest report is stored privately
under `DUOMOVE_STATE_DIR/environment-observations`. This is a latest-report record, not an
unbounded historical archive. The process-local UI cache starts empty after a restart.

Wi-Fi and Bluetooth scan requests are manual buttons inside the observer APK. Reading a
cached scan never refreshes its timestamp. Unsupported cellular technologies and missing
hardware/permissions are reported, not converted into empty successful observations.
Only the default subscription and LTE/NR representations are handled.

For **Application test playback**, start an existing modeled trip, then choose **Start test
playback**. The follower sends its existing model frames to the lab APK, without altering
the GPS player. Model sequences are not invented by the browser. Duplicate frames do not
renew the Android lease. **Stop test playback** explicitly closes that lab session.
The latest route model remains labeled synthetic even when stored successfully on Android.

Authenticated endpoints (device identifiers are resolved within the signed-in workspace):

```
GET  /api/environment-observer/devices/:id
POST /api/environment-observer/devices/:id/readback
POST /api/environment-observer/devices/:id/lab-start
POST /api/environment-observer/devices/:id/lab-stop
```

The lab follower runs on the same controller process as its existing in-memory trip runtime.
Use worker affinity for its UI requests in a multi-replica deployment. Redis assigns fencing
epochs and a 30-second ownership lock. An interrupted session fails closed and requires an
explicit restart. The phone clears staged frames after a five-second lease; an opened but
not-yet-staged session has a ten-second lease. A run has a 30-minute test limit. Stop/start
is the explicit pause/resume path; seamless reconnect and durable player-session recovery
are not implemented. A Redis epoch reset can require operator reconciliation with the
phone's persisted highest epoch; the receiver never silently accepts lower epochs.

## Modeling policies

`RadioEngine` now accepts `wifiEntryDbm`, `wifiExitDbm` and
`wifiExitRadiusMultiplier`, while keeping previous defaults (-90/-90 dBm, multiplier 1)
so existing callers do not change behavior. They control candidate visibility, not an
Android association. Wi-Fi scan-model cadence remains separate from GPS cadence.
For a deliberately illustrative software scenario, pass:

```ts
{ wifiRadiusM: 60, wifiExitRadiusMultiplier: 1.5,
  wifiEntryDbm: -88, wifiExitDbm: -92 }
```

These values exercise hysteresis; they are not calibrated physical ranges, carrier settings,
Google acceptance thresholds, or ranking guidance. Existing LTE/NR A3/A5-inspired serving-
cell selection remains in place. Network identities are stable; the model does not rotate
BSSIDs or CIDs randomly at fixed distance intervals.

`DestinationIntent` is an exported, tested policy helper in `src/radio/environmentPolicy.ts`.
It requires continuous fresh, terminal-phase observations, known speed and bounded accuracy
before producing a destination BSSID **intent**. It has separate arrival/departure radii
and dwell times. Instantiate it separately per image, session and boot. The helper is not
wired to an Android connection API and is not used to bypass the existing production
arrival gate. Actual BSSID association and a destination-association UI are **not built**.

## Authentication and evidence limits

Each socket has a fresh 32-byte nonce. Both request and response are HMAC-SHA256 over the
exact UTF-8 `direction + newline + nonce + newline + payload`. Identity includes image,
phone-derived boot identifier and process instance. Lab frames additionally bind session,
epoch and sequence. The receiver caps frames at 128 KiB and bounds clients/timeouts.
The phone's boot identity is derived from configured image ID plus Android BOOT_COUNT;
this is a test-channel identity, not hardware attestation. Reinstall/configuration changes
must be treated as reprovisioning. The process instance changes on receiver restart.

App-level API readback does not prove physical RF, global system-service coverage, absence
of other installed hooks, or real travel. Keep the observer outside any existing module
injection scope. No IMEI, IMSI, ICCID or user-account data are collected. An unavailable or
redacted value is not a verified match. No end-to-end modeled-vs-physical RF equivalence is
claimed. The existing radio applier still needs a supported, separately validated solution.

## Before production use

Build success and JVM/Node tests are not phone validation. On two actual DuoPlus images:
verify package installation and dedicated endpoints; observe different authorized locations;
check sample ages, redactions and missing modem/BLE cases; run model playback; confirm lease
expiry, per-image isolation, stop/start, disconnect and phone/controller restart behavior.
Independently verify the existing GPS player's route behavior. No phones were provisioned
or physically exercised by the build process itself.

Uninstall only these two packages to remove this addition. Their private credentials and
staged test state are separate from the existing player. Never delete the existing player,
its data, city datasets or production database to reset these test apps.

## Platform references

- https://developer.android.com/reference/android/location/Location
- https://developer.android.com/develop/connectivity/wifi/wifi-scan
- https://developer.android.com/reference/android/telephony/TelephonyManager
- https://help.duoplus.net/docs/Batch-Modify-Parameters
