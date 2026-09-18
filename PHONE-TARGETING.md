# Independent phone targeting, transport and ownership

Covers checklist items B01, B02, B03 and B08. Device-side driving previously
resolved one global `DUOMOVE_IMAGE_ID`, one ADB endpoint and one control-token
path, and radio session ownership was an in-memory rule. Each phone now has its
own connection, its own credential, its own readiness result and one owner.

## Configuring a fleet (B01)

`DUOMOVE_PLAYER_TARGETS` holds either a JSON array or an image→endpoint map:

```json
[{"imageId":"N5YK6","endpoint":"10.0.0.5:5555","label":"Demo"},
 {"imageId":"P7QW2","endpoint":"10.0.0.6:5555",
  "radioAgent":{"packageName":"net.stakeout.duomove.radioagent","port":9998,
                "moduleName":"duomove-radio","credentialMode":"OPERATOR_SUPPLIED"}}]
```

`controlPort` defaults to 9999 and the agent port to 9998; the two may not be the
same. The existing `DUOMOVE_IMAGE_ID` plus `ADB_PREFLIGHT_ENDPOINT` pair still
resolves, as a single-phone configuration, and that image adopts its existing
`${DUOMOVE_STATE_DIR}/duomove-control-token` once rather than needing a
re-provision — the deployed phone already holds that token. Adding
`DUOMOVE_PLAYER_TARGETS` is therefore the only step needed to move a running
deployment off the globals.

### Two channels, two credentials

The radio side is three artifacts, not one: a `dplus` module that does the
injecting and has no process of its own, an agent APK that owns the
authenticated control channel and the current frame, and the GPS player left
untouched. A module cannot hold a listening socket, so the controller's radio
transport targets the agent — a different package, a different port and a
different credential from the player, on the same phone.

Credentials are per image and per package:

| Slot | Default path | Default mode |
| --- | --- | --- |
| Player | `${DUOMOVE_STATE_DIR}/player-credentials/<digest>.token` | `RUN_AS` |
| Radio agent | `${DUOMOVE_STATE_DIR}/radio-agent-credentials/<digest>.token` | `OPERATOR_SUPPLIED` |

Files are mode 0600 and never appear in argv, logs or browser payloads.

### The ADB client identity is part of the credential set

`adb` mints its keypair at `$HOME/.android/adbkey`, which in the deployed image is
`/root/.android` and not on the volume, so every redeploy presented a new public
key to every phone. That is survivable only while the provider endpoint accepts
unauthorized keys. Set `ADB_CLIENT_KEY_BASE64` (or `ADB_PRIVATE_KEY_BASE64`, the
name a sibling deployment already uses) and the key is persisted to
`${DUOMOVE_STATE_DIR}/adb/adbkey` and handed to adb through `ADB_VENDOR_KEYS`
before the first command; with no variable set, a key already on the volume is
reused. With neither, the controller logs that its ADB identity is ephemeral
instead of leaving it silent.

Provisioning is pluggable because the shipped player's path does not generalize:
piping a token in over `adb shell run-as` works only because that APK is
`debuggable="true"`, and the agent is intended to be release-signed.

- `RUN_AS` — the controller mints the secret and pipes it into the package's
  private files on stdin. Re-provisioning with rotation mints a new secret.
- `OPERATOR_SUPPLIED` — the credential the package already holds is placed on the
  controller out of band. Nothing is pushed to the phone, and rotation is stated
  as the operator's action rather than faked.
- `AGENT_MINTED` — reserved for the agent minting its own credential and
  disclosing it once to a caller holding shell. That interface belongs to the
  agent APK, which has not been delivered, so this mode reports itself
  unavailable instead of inventing a handshake.

Configuration problems disable one image at a time and say why, rather than
throwing away the fleet or guessing:

| Situation | Result |
| --- | --- |
| Image has no entry | `NOT_CONFIGURED`; the image is refused, never redirected |
| Invalid endpoint or device port | That image only is disabled |
| Two images share one endpoint | Both images are disabled |
| One image defined twice | That image is disabled; neither row is treated as authoritative |

There is no global endpoint and no fallback path, so a command for one image can
never be addressed to another image's phone.

## Readiness lifecycle (B02)

`PlayerLifecycle.check(imageId)` evaluates one image strictly from its own
target and returns exactly one state with its reason and timestamp:

`READY`, `NOT_CONFIGURED`, `MISCONFIGURED`, `ENDPOINT_CHANGED`, `STARTING`,
`UNREACHABLE`, `APK_MISSING`, `NOT_ACTIVATED`, `UNAUTHENTICATED`, `RESTARTED`,
`FOREIGN_SESSION`, `BUSY`.

The lifecycle remembers each image's endpoint and player instance. A moved
endpoint and a restarted player are reported and require an explicit re-check;
they are never absorbed into a working-looking result. `checkFleet` runs the
checks independently, so an unreachable phone cannot change another phone's
result and never degrades into a partly working mode.

## Radio delivery (B03)

`RadioDeliveryAdapter` writes a frame to one phone and session:

- Identity on every write, as separate concepts: tenant, image, injecting module
  name and version, agent package and agent process instance, phone boot
  identity, session, ownership epoch and sequence. The acknowledgment must match
  all of them, and the phone reports its own identity rather than echoing the
  controller's expectation, so changed injecting code, a restarted agent, a
  rebooted phone and a different run are four distinguishable failures.
- Bounded payloads (32 KiB by default) and a request timeout (5 s by default).
- One explicit result per frame: `APPLIED`, `RECEIVED`, `REJECTED`,
  `UNSUPPORTED`, `TIMED_OUT`, `UNREACHABLE`, `PAYLOAD_TOO_LARGE`,
  `REPLAY_REJECTED`, `IDENTITY_MISMATCH`, `INVALID_ACK`, `OWNERSHIP_LOST`,
  `CLOSED`.

Receipt is never reported as application. A frame that never reached the socket
is a clean failure and may be retried with the same sequence; a written frame
with no answer stays explicitly uncertain. A mismatched acknowledgment closes
the writer instead of continuing to send.

The wire format lives behind the codec seam in `src/trips/radioWire.ts`.
Adopting the delivered plugin protocol (A03/A04, owned elsewhere) means supplying
another codec, not changing the adapter, the transport or the ownership rules.
Until then the placeholder codec follows the player's existing conventions:
32 hex request ids, and a closed lowercase `[a-z_]{1,80}` rejection vocabulary
where anything unrecognized is flattened to `invalid_request`.

### What is stubbed

None of the three radio artifacts (A01) has been delivered, so no phone can
accept these frames yet. `src/trips/radioStubReceiver.ts` is an explicit stand-in
for the agent: it speaks the same wire format, answers with its own module and
agent identity, and enforces the same credential binding, image binding, epoch
fencing and frame ordering, so the adapter and its failure states can be
exercised. It is never started automatically, and it is not evidence of on-phone
behavior. In a deployment the adapter reports an unreachable receiver rather than
reporting a frame as applied.

Also undefined until the agent exists: its control lease and what happens to
applied radio state when that lease lapses (held, reverted, or held and flagged),
and credential revocation that releases owned radio state. The controller-side
lease below is the ownership half only.

## One owner per physical phone (B08)

`withPhysicalImageLease` is the Redis lease that GPS trip operations already
used, now shared by player lifecycle work and radio writes, keyed by the
physical image so duplicate image rows in different workspaces cannot both
drive one phone. Acquiring it raises a fencing epoch.

- Ownership is proved immediately before each write; an expired worker sends
  nothing.
- The epoch travels with the frame, so a payload that was already in flight when
  a lease expired is rejected by the receiver as `stale_epoch`.
- `authorizeImageWriter` requires the requesting workspace to own a row for the
  image, and refuses when another workspace is driving it or a campaign
  reservation holds it.
- The lease is not reentrant. Work already inside `withTripLease` passes that
  ownership to `openRadioDelivery`; standalone radio work uses
  `withOwnedRadioDelivery`.

### The limit: this controller is not the only writer

Two other deployed systems reach the same DuoPlus phones over ADB —
`stakeout-warmup/warmup-worker` and `stakeout-stations/duomove` — and Railway
private networking is per project with no shared variables, so this Redis lease
is visible only inside this controller's project. **Single-writer therefore holds
within this controller only.** Nothing here can stop an external system from
driving the same phone, and there is no cross-system lease to join.

What the controller does instead is refuse to assume exclusivity and detect the
takeover:

- Readiness reports `FOREIGN_SESSION` when the player is running a session this
  controller never opened. Its own sessions from before a restart are recovered
  from persisted trips first, so a restart does not manufacture a false alarm.
- A step that finds a different live session on the player stops with "another
  writer owns this player session" rather than reporting it as our own restart,
  and replays nothing.
- The radio adapter's identity checks reject an acknowledgment carrying a session
  or ownership epoch this writer did not author.

Closing the gap needs a decision above this repo: one owner for each phone across
the three deployments, or a shared lease they all consult.

## Still open

B04–B07 (GPS progress feeding the radio runtime, the simulation-to-device clock
mapping, the synchronization policy and end-to-end ordering guarantees) and the
on-phone acceptance items G01–G05 depend on the delivered artifacts and a
reachable phone. A stubbed agent can test controller logic; it cannot close
on-phone acceptance.

Two related mismatches live outside this layer and are unchanged here: the
controller validates ±90° latitude while the player's sample validator accepts
±85° (F05), and player APK verification still pins one expected artifact, which
cannot describe a separate agent and module (A08/G01).

## Verification commands

`npm test`, `npm run build`.
