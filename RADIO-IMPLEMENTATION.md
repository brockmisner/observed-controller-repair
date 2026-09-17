# Radio integration work in progress

## Current requirement

Each existing DuoPlus phone has its own live GPS marker and independent radio session.
Coordinates drive modeled Wi-Fi and cellular changes during movement. Bluetooth is
held unchanged during movement and replaced only after confirmed arrival. Shared
area data and code do not imply shared per-device runtime state. Nearby phones can
correctly observe overlapping real network identities.

## Built in this branch

- Rich, validated shared observation schema preserves frequency/channel, radio type,
  Bluetooth metadata, explicit LTE/NR identities, and optional propagation parameters.
  Unknown cell identifiers are not decoded into guessed carrier/sector information.
- Local spherical KD-tree handles longitude wrap and polar locations. No network
  requests occur in the model.
- Independent engine per tenant, physical image, session, and dataset revision.
  Deterministic per-device, per-network temporally smoothed signal variation; no random
  replacement of BSSIDs or cell IDs.
- Frequency-aware path loss with optional horizontal antenna pattern; LTE/NR power
  ranges, same-carrier selection, A3/A5-inspired hysteresis and time-to-trigger.
  These are scenario models, not a baseband implementation. No tilt, load, interference,
  roaming, dual connectivity, inter-RAT handover, RSRQ/SINR or timing-advance model is
  implemented. Unknown measurements remain null.
- Separate Wi-Fi cache cadence and sample ages. Frame times are simulation-relative
  milliseconds, explicitly NOT Android boot-time scan timestamps.
- Bluetooth action is HOLD/null during movement, REPLACE after arrival. A null result
  means leave current state alone; it must not clear the phone's existing Bluetooth state.
- Session ownership rejects a second owner of the same physical image. Runtime state
  is in memory; expired/restarted sessions require explicit re-creation. No silent replay.
- Arrival gate requires fresh, continuous stationary location fixes. Its readback
  contract rejects wrong phone/session/boot/hash, stale readings, unavailable radios,
  and differing network identities/measurements. It consumes authenticated adapter
  evidence; accepting a JSON report alone does not prove device-wide coverage.
- Tenant-scoped POST `/api/warmup/cities/:id/radio-preview` accepts `{deviceId, position?}`
  and returns an explicitly synthetic preview, with applied=false and androidVerified=false.
  It does not reserve a runtime session, move a marker, write a phone, or run a plugin.

## Not built / not verified

This is not a completed Android integration or deployment. The live marker is not yet
wired to these sessions. Existing movement/RPA production behavior is unchanged.
No new plugin APK, Android radio receiver, or independent radio observer has been built.
The existing checker-only module remains unchanged.

Required next steps are to verify a reachable test phone and supported Android radio
interfaces, implement the module/receiver and authenticated per-device transport,
wire movement acknowledgments to radio updates and Bluetooth arrival handling, and
validate through independent Android API readback. DuoPlus documentation describes
package-targeted injection; global/system-service coverage cannot be assumed from that.

Local ADB currently reports no connected devices. The Railway connector exposes
variable names but redacts values, including the configured ADB endpoint. The connected
browser is signed into Observatory, not a DuoPlus management session. No control token
or ADB endpoint was extracted from hidden browser state.

Existing city JSON remains compatible but lacks fields previously stripped at import.
Reimporting richer saved uploads can restore their existing metadata; it cannot invent
missing frequency, cell identity, antenna orientation, or coverage.

## Verification commands

`npm test`, `npm run test:warmup`, `npm run build`.

Sources: https://help.duoplus.net/docs/How-to-develop-plugin-modules
https://developer.android.com/develop/connectivity/wifi/wifi-scan
https://developer.android.com/reference/android/net/wifi/ScanResult
