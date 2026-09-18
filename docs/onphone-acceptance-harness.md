# On-phone acceptance harness (checklist G01, G02, G03 attempt)

Two runners collect the same evidence by two different routes, plus a stub for self-testing them.
Both produce `evidence.json`; the ADB runner also produces a `report.md`.

| Script | Route | Use it when |
| --- | --- | --- |
| `scripts/duomove-acceptance-api.mjs` | HTTPS to the deployed controller, which does the ADB leg itself | Normally. The ADB hop then leaves the service egress the provider already accepts. |
| `scripts/duomove-acceptance.mjs` | Direct ADB from the host it runs on | When you are on a host the provider accepts — in practice inside the controller container. Gives near-complete sample coverage. |
| `scripts/duomove-stub-player.mjs` | Local TCP stub of the phone's `ControlServer` | Validating either runner without a phone. Produces no acceptance evidence. |

Supporting modules: `duomove-cadence-stats.mjs` (the G02 figures), `duomove-image-probe.mjs`
(the probe from `docs/radio-apk-build-brief.md` §11 and its verdicts), `duomove-apk-signer.mjs`
(signer certificate digests straight out of the APK signing block), `duomove-acceptance-plan.ts`
(the route, built with the controller's own `buildPlayerPlan`).

## Which route measures what

The player applies samples from an uploaded plan on its own 1 Hz clock, and each `status`
response carries `start_elapsed_nanos` and `observer_elapsed_nanos` — both device
boot-relative. Lateness is therefore always measured on the phone's clock, whichever route is
used. What the route changes is **how many sample indices get caught**:

- The controller re-checks the player roughly every 1.5 s (`playerRunner` sets `nextTickAt` to
  now + 1500). Against a 1 Hz plan that catches about two thirds of indices, and the interval
  series only contains pairs where two refreshes happened to land on adjacent indices. Polling
  the API faster does not help: the underlying record only refreshes on the controller's tick.
- The ADB runner polls the socket directly at 150 ms by default and catches essentially every
  index.

Both report `unobservedSeqs` so a gap is never silently counted as a one-second interval.

## Running the API route

Needs the image id (the deployment's `DUOMOVE_IMAGE_ID`) and one of two credentials:

```bash
# Device-scoped, revocable. Cannot express a mid-route stop.
node scripts/duomove-acceptance-api.mjs \
  --base-url https://observatory-controller-production.up.railway.app \
  --image-id <DUOMOVE_IMAGE_ID> --trip-token-file token.txt \
  --dest 37.4220,-122.0841 --out ./evidence

# Workspace session. Adds the mid-route stop and the player verify call.
node scripts/duomove-acceptance-api.mjs --base-url ... --image-id <id> \
  --email you@example.com --password-file pw.txt \
  --dest 37.4220,-122.0841 --stop 37.4180,-122.0900:20 --out ./evidence
```

A trip token may only call `POST /api/trips/trigger`, whose schema has no `waypoints` field, so
that route produces acceleration, road turns and the destination dwell but no mid-route stop. A
workspace session uses `POST /api/trips` with `waypoints[].stopSeconds` and can also call
`POST /devices/:id/player/verify` for the G01 record.

## Running the ADB route

```bash
node scripts/duomove-acceptance.mjs --endpoint <IPv4>:<port> --out ./evidence
node scripts/duomove-acceptance.mjs --endpoint <IPv4>:<port> --probe-only   # no drive
```

It reads the existing control token back with `run-as`; it never provisions one, because
replacing the token would invalidate the controller's own credential. Pass `--token-file`
pointing at `${DUOMOVE_STATE_DIR}/duomove-control-token` if `run-as` is unavailable.

**Running it inside the controller container shares one `adb` server with the controller
process.** The runner therefore never calls `adb disconnect`, and removes only the forward it
created. It does `adb connect`, which is idempotent when a connection already exists.

## What it will not do

Every shell command is a fixed literal and is checked against a denylist before it runs, so the
runner cannot install, uninstall, update, clear data, force-stop a package, grant a permission,
write a setting, provision a token or reboot. The drive itself is the only state change, it uses
a fresh session id, and it cancels only a session this run started. It refuses to drive at all if
the player is not `IDLE` or terminal with `cleanup_ok`, so it will not take a session away from
another writer.

Copying the installed APK out with `adb pull` is a read; it is how the signer certificate digest
is established without depending on a `dumpsys package` output shape that varies by version.

## Self-testing

```bash
node scripts/duomove-stub-player.mjs --port 19999 --token <32+ chars> --jitter-ms 45 --skip 40,41
node --import tsx scripts/duomove-acceptance-plan.ts --origin 37.7749,-122.4194 --out plan.json
node scripts/duomove-acceptance.mjs --direct-port 19999 --token-file tok.txt --plan plan.json
```

The stub applies deterministic per-index jitter and skips the indices you name, so the runner's
figures can be checked against known input. Label any such run a harness self-test: the stub is
not a phone and its numbers are not acceptance evidence.

## Reading the numbers

- **Lateness vs schedule** is measured against `start_elapsed_nanos + 500 ms + n x 1000 ms`, the
  player's own contract. It includes the in-process observer callback delay, because the
  timestamp comes from the observer.
- **Phone-reported max lateness** (`max_lateness_ms`) is the player's own figure, computed at
  application time. The gap between it and the harness-derived maximum bounds the observer delay
  plus any difference between the nominal schedule and what the player actually scheduled.
- **Interval** only uses consecutive indices.
- `skipped_samples` and `observer_mismatches` come from the phone and are authoritative.
- Any figure is specific to that image, that build and that run. It is not a universal timing
  guarantee, and it is not the controller's supervision cadence or the UI's display cadence.

The API runner also records `competingWriterSignals`. `stakeout-warmup/warmup-worker` and
`stakeout-stations/duomove` reach phones over ADB independently of this controller and share no
ownership with it, so a player instance change, a session change, or an applied sequence moving
backwards means a second writer was involved and the timing numbers should be discarded.
