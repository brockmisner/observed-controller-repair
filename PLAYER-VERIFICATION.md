# Installed phone verification

The uploaded `DuoMove-Drive-1.0.0-debug(1).apk` identifies itself as
`net.stakeout.duomove.player`, version 1.0.0 / versionCode 1, minSdk 29,
targetSdk 34. Its SHA-256 is
`620d7714280e98048a16d7fcd0320fed3d8925c7377997eadad4b99adfcd5dbf`.

This is the existing GPS playback application. Static inspection found its
ControlServer and supported mock-location APIs. The APK has no DuoPlus
`assets/config.json`, `com.android.dp.Entry` or dpbridge entrypoint, and no
`getAllCellInfo` or `BluetoothLeScanner` reference. This inspection does not
establish what a phone currently returns, or prove that the installed bytes match.

## Checking the installed application

Devices → Overview → **Verify player APK** calls the authenticated,
tenant-scoped `POST /devices/:id/player/verify` endpoint. Each registered phone
can be checked independently. Only the physical image configured by
`DUOMOVE_IMAGE_ID` and its existing `ADB_PREFLIGHT_ENDPOINT` mapping can use
direct ADB, and only when it has no assignment in another tenant. All other
phones use fixed read-only DuoPlus commands authorized by the requesting
workspace's provider API key. Shared ADB remains blocked. Provider
denial stops the check; it never falls back to the shared ADB token. Player socket
status is unavailable on this path. Device assignment is checked again before
returning results and inside the transaction that saves them.

The latest result survives page reloads and controller restarts. Checks and
failures are stored as `PHONE_VERIFICATION` events under the phone; the History
tab displays them in Controller events. Records are matched to the workspace,
device and physical image, so reassignment cannot expose an earlier owner's
verification. Raw command output and credentials are not saved. Repeated clicks
for the same phone share one pending check; other phones have independent checks.
A failed check supersedes the prior result rather than presenting it as current.

The inspection only reads the installed APK path, package metadata and SHA-256,
sends the existing authenticated player `status` command, and reads Android's
last-location diagnostics with device uptime. It neither installs an APK nor
changes permissions, starts playback, renews the playback lease, clears data,
changes coordinates or restarts the player. Concurrent ADB requests share one
inspection. Connection failure is an error; an unavailable package fingerprint
or stale/absent location remains explicitly unverified.

A matching APK hash means the installed bytes match the supplied artifact.
Player acknowledgement and its observer counters have application scope; they
do not verify other applications or radio APIs. Wi-Fi, cellular and Bluetooth
are explicitly `NOT_OBSERVED` in this check.

## Map readback

Fresh Android last-location fixes appear as a separate purple ring. Both the
manual GPS check, saved APK inspection and current device's trip readback can supply it. The
popup retains Android's mock indicator. The controller marker remains labeled
as controller coordinates.

The readback ring requires matching device/image identity, reported ON state,
valid coordinates and a GPS/fused fix whose age at receipt plus time since the
check is at most 30 seconds. A newer UNKNOWN result suppresses earlier evidence.
The ring expires even if the server stops returning snapshots, and all rings
are removed on logout. There is no interpolation or generated fix, and reading
the map never queries WiGLE or writes radio state.

## Remaining scope

On 2026-09-17 at 22:38:55 UTC, the deployed controller verified that Demo
(`N5YK6`) had the exact uploaded APK installed, using the workspace-authorized
DuoPlus command path. Its last GPS fix was stale; current location and radios
were not verified.

The radio model remains an explicitly synthetic preview. No Android radio
plugin is shipped by this change, and device-wide Wi-Fi/cellular/Bluetooth
verification is not established. No account-trust claim follows from an APK
match, location readback or campaign duration.

Validation: `npm test`, `npm run build`, `node --check public/app.js`,
`node --check public/phone-readback.js`.
