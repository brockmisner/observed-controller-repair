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

**Readback availability is not emptiness.** `MEASURED` with `entries: []` means read and
nothing present. `UNAVAILABLE` means it could not be read. `OUT_OF_SCOPE` means the declared
plugin scope never covered it. The observer's package and process are mandatory so an echo of
the submitted payload is identifiable.

**Declared scope is evidence-bound.** `injectionScope: 'TARGET_PACKAGES'` must enumerate its
packages. `DEVICE_WIDE` requires observer evidence from a package the plugin does not own.
