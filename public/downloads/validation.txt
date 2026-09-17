# Hooking 1.3.1 validation — 2026-09-15

## Release change

Pause at the instant of automatic completion now preserves the completed state
and removes the foreground notification under the latest run generation. A
normal paused run retains its Resume/Stop notification. The shared dispatcher,
sensor models, and phone/Auto routing are unchanged from 1.3.

## Build and regression checks

- Version code 5, version name 1.3.1; installed in place on the selected Pixel 6.
- Normal `:app:assembleProbeDebug` and Android test APK assembly passed.
- 91 Java unit tests and 70 Python compiler/import/schema tests passed.
- Android lint: zero errors, 28 warnings.
- APK inspection found no native library, module config, bridge, Entry, FixFile,
  or HookDiagnosticsActivity. The normal build does not require a module token.
- A separate source export also built, tested and linted successfully with
  `plugin/dplus`, `dpbridge.jar`, and local SDK/token configuration absent.
- Eleven on-device tests passed without skips: two completion tests, three
  console tests, and six AndroidX Auto fake-host/surface tests.
- The deterministic Pause/completion regression failed against the previous
  1.3 APK and passed against 1.3.1. Latches selected the exact ordering where
  completion cleanup is queued and a late Pause invalidates its generation.
- Completion checks cover a 1,050 ms route ending between normal pose slots,
  exact terminal position, released wake lock/foreground status, preserved
  completion message, and no subsequent samples.
- Console tests cover immediate movement, pause/resume/stop, activity recreation,
  and dial-intent prefill. They do not make calls or change calling permissions.

## Runtime and environment limits

The selected DuoPlus Pixel 6 does not enter screen-off state after the Sleep
command. Android Auto is not installed on it. Desktop Head Unit 2.0 is available
on the laptop, but a phone with Android Auto is needed to verify projection.
Fake-host tests do not prove head-unit compatibility. No battery optimization
exemption, real call, default-dialer change, or third-party sensor injection was
used during verification.

The earlier exact-APK 1.3 endurance results remain documented separately in
[1.3 validation](CONSOLE-1.3-VALIDATION.md).

APK SHA-256:

```text
1da8e6e050c38e78c0ae9a84ce24b120d65292b0c42e06f6e6242f9429492e32
```

## Final exact-APK device run

The installed 1.3.1 APK above passed 600 seconds of background playback; the
full exercise including setup/actions took 611.884 seconds. It delivered
46,173 frames and omitted 2; maximum scheduler lateness was
58.034944 ms and mean lateness 0.651574 ms.
The bounded history retained 2,048 frames and evicted 44,125.

| Channel | Delivered | Omitted | Max lateness (ms) |
| --- | ---: | ---: | ---: |
| gnss | 607 | 0 | 2.717 |
| wifi | 61 | 0 | 1.124 |
| cell | 607 | 0 | 2.717 |
| ble | 607 | 0 | 2.717 |
| imu | 30,334 | 2 | 18.035 |
| magnetic | 6,068 | 0 | 58.035 |
| pressure | 607 | 0 | 2.717 |
| power | 607 | 0 | 2.717 |
| activity | 607 | 0 | 2.717 |
| pose | 6,068 | 0 | 58.035 |

Notification Pause/Resume/Stop, UI reopening, wake-lock release and report-schema
validation passed. The instrumentation process was active; these are scheduler
entry timestamps, not UI latency or a hard real-time guarantee. Screen-off was
not achieved and is not implied by this background run.

The current APK also passed date-line catalog and malformed/oversized import
checks. Its private Flamingo import prepared 452 of 454 source records
using `sqlite_bbox_btree`, preserved metadata, and froze delivery on Stop.
A visible-UI start followed by force-stop and cold reopening produced a new
process in EMPTY state, with Start disabled and no foreground playback. It never
silently resumed the previous run. No calling role or permission was changed.

## WiGLE data handoff

Observatory's **Download for Hooking** action is live. It exports the complete
saved-upload wrapper, preserving query/observation dates, opaque cellular/BLE
metadata and incomplete-coverage warnings. Table filtering/pagination does not
truncate the download. The action makes no API write or device-location change.

Fourteen focused download/UI tests and the dashboard build passed. The deployed
JavaScript matches the reviewed source byte for byte. An export-to-compiler
round trip passed runtime and JSON Schema validation. Use the downloaded
catalog with a route, then import the resulting scenario through Hooking.

## Production distribution update — 2026-09-16

The Observatory dashboard's **Saved WiGLE data** panel links the Hooking APK,
scenario builder/source ZIP, demo scenario and this validation report under the
same Railway production origin. The Android APK remains the exact 1.3.1 binary
validated above; the scenario builder now supports the current saved-query
summary fields (`source`, `queriedAt`), optional `siteId`, and query `radiusM`.
Conflicting timestamps and malformed metadata remain rejected. Coverage and
per-record observation provenance are preserved.

The updated builder passes all 74 Python tests, including four new compatibility
cases. The current Observatory parser/summary and browser export were passed
through compilation and formal scenario validation. Dashboard download tests
pass (14 cases). Checksums are published in `/downloads/SHA256SUMS`; the release
file list is `/downloads/release.json` on the production origin.
