# Radio plugin protocol v1

`duoplus.radio` / `protocolVersion: 1`. This is the frozen wire contract between the controller
and the DuoPlus radio plugin. The controller implementation is `src/radio/contract.ts`
(message shapes, lifecycle rules) and `src/radio/policy.ts` (freshness, latency budget,
readback comparison). The reasoning behind each chosen value, and the two choices still
awaiting sign-off, are recorded in the project's radio contract decision record.

## What is here

- `manifest.json` — every fixture with the outcome a validator must produce: `ACCEPT`, or
  `REJECT` with a named `code` and, where the rule is specific, a `detail`.
- `fixtures/*.json` — complete messages, valid and invalid.

Both sides validate the same files. A disagreement is a test failure, not a discussion.
The controller side runs in `tests/radio-contract.test.ts` (`npm test`). Regenerate the
fixtures with `npm run fixtures:radio` after changing the generator.

## What the platform allows, and what follows from it

Android has a test-provider API for *location* and **no equivalent for radios**. A modeled Wi-Fi,
cell or Bluetooth environment can only be produced by hooking client APIs inside named packages,
which is what a DuoPlus `dplus` module does through its `config.json` `pattern` list. Three
consequences are built into this contract rather than left to convention:

- **The supported scope is a package list, not the device.** `pattern` is the scope;
  `scopeFingerprint` binds every frame and every readback to it. A frame computed for a different
  scope is rejected instead of silently widening or narrowing what the evidence covers.
- **A readback proves injection fidelity, not physical RF.** `evidenceClass` is the fixed literal
  `INJECTION_FIDELITY`. An observer *outside* the pattern is a negative control: it should see the
  host's real radios and not match, and that non-match is a correct result reported as
  `OUT_OF_SCOPE_CONFIRMED`. An out-of-scope observer that *does* see the injected values is a
  `SCOPE_LEAK`, because it contradicts the declared scope.
- **Three artifacts, three identities.** The applier is a `dplus` module with no process of its own,
  the agent is an ordinary APK owning the authenticated control channel, and the GPS player is
  unchanged. `bootId` (changes on reboot), `instanceId` (changes when the agent restarts) and
  `sessionId` (per run) are separate fields on every message.

## Message flow

| Message | Direction | Purpose |
| --- | --- | --- |
| `radio.hello` | controller → plugin | Ask for capabilities |
| `radio.capabilities` | plugin → controller | Declared build, image, injection scope and per-interface support |
| `radio.session.open` | controller → plugin | Open a session against an expected build |
| `radio.session.opened` | plugin → controller | Boot identity and the clock anchor |
| `radio.apply` | controller → plugin | One frame: per-interface HOLD / REPLACE / CLEAR |
| `radio.result` | plugin → controller | Lifecycle result for one sequence |
| `radio.status.query` / `radio.status` | both | Reconcile an uncertain or timed-out frame |
| `radio.readback` | observer → controller | Independently measured Android values |
| `radio.session.close` / `radio.session.closed` | both | Cleanup, with residual state named |

## Rules a validator must enforce

**Version before shape.** An unknown `protocol` or `protocolVersion` is rejected as
`PROTOCOL_VERSION_UNSUPPORTED` before any other field is read. Unknown fields are rejected;
extensions arrive through a new protocol version, not through silent tolerance.

**Three directives, kept apart.** `HOLD` carries `entries: null` and leaves existing state
alone. `REPLACE` carries a list, and `[]` positively asserts that nothing is present.
`CLEAR` carries `entries: null` and explicitly removes the controller's own injected state.
Bluetooth may only be replaced in the `ARRIVED` phase; a `CLEANUP` frame may only hold or clear.

**Receipt is not application.** `RECEIVED` and `VALIDATED` must report `PENDING` on every
interface and no `appliedAtBootMs`. `APPLIED` requires every interface settled plus the
boot-domain time of the write. `PARTIAL` requires both a settled and an unsettled interface.
`REJECTED` and `EXPIRED` must leave phone state unchanged. `FAILED` may be `UNCERTAIN`, and a
claimed `rolledBack` makes state `CERTAIN` by definition.

**Three clock domains.** `SIM` is session-relative milliseconds. `PHONE_BOOT` is
`SystemClock.elapsedRealtime()`, valid only within one `bootId`; Wi-Fi `ScanResult.timestamp`
is its microsecond form. `WALL` is UTC epoch milliseconds, for audit and display only.
Values are compared only within one domain and one identity. `radio.session.opened` carries
the single anchor that bridges `SIM` and `PHONE_BOOT`.

**Cached samples keep their age.** A `REPLACE` block carries `sampledSimElapsedMs` and
`cacheIntervalMs`. A sample is never restamped to the frame time, and a sample dated after
its frame is rejected.

**Availability is four states, not four degrees of failure.** `MEASURED` with `entries: []` means
read and nothing present. `NOT_YET_MEASURED` means no measurement exists yet — the expected state
while Wi-Fi scanning is throttled. `UNAVAILABLE` means it could not be read, with the reason named
(`NO_MODEM`, `PERMISSION_DENIED`, `LOCATION_TOGGLE_OFF`, …). `UNSUPPORTED_IN_SCOPE` means this build
does not hook the interface inside the injected packages. A mismatch is a fifth, separate result
decided by comparison. The observer's package, process, PID, UID and scope membership are mandatory,
and the applying process may not observe itself.

**Wi-Fi freshness depends on an image prerequisite.** `startScan()` is throttled to 4 scans per
2 minutes for a foreground app, so a fresh post-application scan requires
`settings put global wifi_scan_throttle_enabled 0` on the image. The readback reports
`wifiScanThrottleDisabled`; without it, stale Wi-Fi is `INCONCLUSIVE` with the prerequisite named,
never a mismatch. `collectionMethod` records whether a value came from a live scan, the platform
cache, a push callback or the module's own hook — a post-application timestamp on an
`INJECTED_HOOK` value proves the hook re-ran, not that a radio scanned.

**Privileged identifiers are out of scope entirely.** IMEI, IMSI and ICCID require
`READ_PRIVILEGED_PHONE_STATE` from Android 10 on, so no ordinary observer can read them back. The
readback schema is strict and rejects them; they are never part of a comparison.

**Declared scope is evidence-bound.** `injectionScope: 'PACKAGE_PATTERN'` must enumerate its
packages and its `scopeFingerprint` must be derivable from them. `SYSTEM_MODULE` requires a
`type: "system"` module plus observer evidence from a package outside the pattern. Declaring an
interface supported that the probed image cannot provide (no modem, no Bluetooth adapter) is
rejected.
