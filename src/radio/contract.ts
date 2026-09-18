import { createHash } from 'node:crypto';
import { z } from 'zod';
import { positionSchema } from './schema.js';
import type { RadioFrame } from './engine.js';

/**
 * Frozen wire contract for the DuoPlus radio plugin (checklist A02/A03/A04, B05, D03).
 *
 * The controller and the plugin validate the same fixtures in `contracts/radio/v1`.
 * Nothing here applies radio state; these are message shapes plus the cross-field rules
 * that keep receipt, application and observation separate.
 *
 * Android has no radio equivalent of `LocationManager.addTestProvider`. A modeled Wi-Fi,
 * cell or Bluetooth environment can only be produced by hooking client APIs inside named
 * packages, which is what a DuoPlus `dplus` module does through its `config.json` `pattern`
 * list. Two consequences run through every message here: the supported scope is a package
 * list rather than the device, and a readback proves that the hook ran with the right
 * identity — never that a radio measured anything.
 */
export const RADIO_PROTOCOL = 'duoplus.radio';
export const RADIO_PROTOCOL_VERSION = 1;

/**
 * The claim a readback can support. Carried on every report so saved evidence cannot later be
 * read as physical RF verification.
 */
export const EVIDENCE_CLASS = 'INJECTION_FIDELITY' as const;

/**
 * Privileged since Android 10, so no ordinary observer can read them back. The synthetic values
 * in `src/env/sim.ts` are controller-side configuration and are never part of a comparison.
 * Listed so the exclusion is explicit rather than an omission; the readback schema is strict,
 * so a report carrying any of them is rejected.
 */
export const PRIVILEGED_UNREADABLE_FIELDS = ['imei', 'imsi', 'iccid', 'msin', 'simSerialNumber', 'subscriberId', 'bluetoothAdapterAddress'] as const;

/**
 * B05. Every time value belongs to exactly one named domain and may only be compared
 * with values from the same domain and the same identity.
 *
 * - SIM: milliseconds since radio-session start. Integer, monotonic per session.
 * - PHONE_BOOT: Android `SystemClock.elapsedRealtime()` milliseconds; meaningful only
 *   within one `bootId`. Wi-Fi `ScanResult.timestamp` is the microsecond form.
 * - WALL: UTC epoch milliseconds. Audit and display only; never a freshness input,
 *   because it moves under NTP and manual adjustment.
 */
export const CLOCK_DOMAINS = ['SIM', 'PHONE_BOOT', 'WALL'] as const;
export type ClockDomain = (typeof CLOCK_DOMAINS)[number];

export const REJECT_CODES = [
  'PROTOCOL_VERSION_UNSUPPORTED', 'MESSAGE_TYPE_UNSUPPORTED', 'MALFORMED_MESSAGE',
  'AUTH_FAILED', 'IDENTITY_MISMATCH', 'SESSION_UNKNOWN', 'BOOT_MISMATCH', 'INSTANCE_MISMATCH',
  'CLOCK_UNANCHORED', 'SEQUENCE_REPLAY', 'FRAME_EXPIRED', 'FIELD_UNSUPPORTED',
  'INTERFACE_UNAVAILABLE', 'SCOPE_NOT_INJECTED', 'SCOPE_CHANGED', 'IMAGE_PREREQUISITE_MISSING',
  'PERMISSION_DENIED', 'PAYLOAD_TOO_LARGE', 'RATE_LIMITED', 'INTERNAL_ERROR',
] as const;
export type RejectCode = (typeof REJECT_CODES)[number];

export const MESSAGE_TYPES = [
  'radio.hello', 'radio.capabilities', 'radio.session.open', 'radio.session.opened',
  'radio.apply', 'radio.result', 'radio.status.query', 'radio.status', 'radio.readback',
  'radio.session.close', 'radio.session.closed',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const elapsed = int(0, Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1).max(200);
const mac = z.string().regex(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/, 'Lowercase colon-separated MAC required');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * Carried by every message so a stray frame cannot be matched to the wrong phone, session, boot
 * or agent process. Three runtime identities stay separate because they change for different
 * reasons: `bootId` on reboot, `instanceId` when the agent process restarts, `sessionId` per run.
 */
export const identitySchema = z.object({
  tenantId: identifier, imageId: identifier, sessionId: z.string().uuid(),
  bootId: identifier, instanceId: identifier, datasetRevision: identifier,
}).strict();
export type RadioIdentity = z.infer<typeof identitySchema>;

/**
 * A02. The injected scope is the module's `pattern` package list. Its fingerprint travels on
 * capabilities, on the opened session and on every frame, so a scope change invalidates frames
 * computed for the previous scope instead of silently widening or narrowing the claim.
 */
export function scopeFingerprint(pattern: readonly string[]): string {
  const normalized = [...new Set(pattern.map(p => p.trim().toLowerCase()))].sort();
  if (!normalized.length || normalized.some(p => !p)) throw new Error('Injected scope must name at least one package');
  return createHash('sha256').update(normalized.join('\n')).digest('hex');
}

const envelopeFields = {
  protocol: z.literal(RADIO_PROTOCOL),
  protocolVersion: z.literal(RADIO_PROTOCOL_VERSION),
  messageId: z.string().uuid(),
  sentAtWallMs: elapsed,
};

/**
 * B05. The only sanctioned bridge between SIM and PHONE_BOOT time. Established once per
 * session, invalidated by any `bootId` change, and never re-derived from wall clock.
 */
export const clockAnchorSchema = z.object({
  bootId: identifier,
  /**
   * Android has no public boot-ID API and `/proc/sys/kernel/random/boot_id` is not dependably
   * readable under SELinux, so `bootId` is a UUID minted whenever `Settings.Global.BOOT_COUNT`
   * changes. The count travels with it so the derivation is auditable.
   */
  bootCount: int(0, Number.MAX_SAFE_INTEGER),
  bootIdSource: z.literal('BOOT_COUNT_UUID'),
  simElapsedMs: elapsed, phoneBootMs: elapsed, wallMs: elapsed,
  uncertaintyMs: int(0, 5000),
}).strict();
export type ClockAnchor = z.infer<typeof clockAnchorSchema>;

export function simToPhoneBootMs(anchor: ClockAnchor, simElapsedMs: number): number {
  if (!Number.isSafeInteger(simElapsedMs) || simElapsedMs < 0) throw new Error('Invalid simulation clock');
  return anchor.phoneBootMs + (simElapsedMs - anchor.simElapsedMs);
}

// ---------------------------------------------------------------------------
// A02 — declared capability and scope
// ---------------------------------------------------------------------------

/**
 * A02. `PACKAGE_PATTERN` is what the DuoPlus module framework provides: a `config.json` `pattern`
 * array naming the packages the module takes effect in, with `Entry.init(Application)` running
 * inside each of those processes. Faked radio values exist only there.
 *
 * `SYSTEM_MODULE` widens that, but only a `type: "system"` module proven on the image can claim
 * it, so the schema requires observer evidence from a package outside the pattern.
 */
export const INJECTION_SCOPES = ['PACKAGE_PATTERN', 'SYSTEM_MODULE'] as const;
export const MEASUREMENT_MODES = ['EXCLUSIVE', 'ADDITIVE'] as const;

const artifactSchema = z.object({
  packageName: z.string().min(1).max(200),
  versionName: z.string().min(1).max(80),
  versionCode: int(1, Number.MAX_SAFE_INTEGER),
  apkSha256: sha256,
  /** A08. What distinguishes an in-place update from a rebuild under a different key. */
  signerCertSha256: sha256,
  sourceCommit: z.string().regex(/^[a-f0-9]{7,40}$/),
}).strict();

/**
 * Three artifacts, three identities. The applier is a `dplus` module with no process of its own;
 * the agent is an ordinary APK owning the authenticated control channel and the current frame;
 * the GPS player is unchanged and reported only so one artifact's result never stands in for
 * another's.
 */
const artifactsSchema = z.object({
  agent: artifactSchema,
  module: artifactSchema.extend({
    /** The name `dplus dump` reports, which is what `dplus uninstall` takes. */
    moduleName: z.string().min(1).max(200),
    moduleType: z.enum(['user', 'system']),
  }).strict(),
  player: artifactSchema.nullable(),
}).strict();

/**
 * §11 of the build brief: facts about the image that shrink or enable the release, probed rather
 * than assumed. A missing prerequisite is a readiness failure, not a mismatch at acceptance time.
 */
const imagePrerequisitesSchema = z.object({
  /** `settings put global wifi_scan_throttle_enabled 0`. Without it, no live scan is reliably fresh. */
  wifiScanThrottleDisabled: z.boolean(),
  /** Wi-Fi scan results and cell info return empty to apps when the master toggle is off. */
  locationMasterToggleOn: z.boolean(),
  /** A cloud phone may have no modem, in which case cellular readback is unavailable regardless of injection. */
  modemPresent: z.boolean(),
  /** With no adapter the arrival Bluetooth action has nothing to act on. */
  bluetoothAdapterPresent: z.boolean(),
  probedAtWallMs: elapsed,
}).strict();

const interfaceCapabilitySchema = z.discriminatedUnion('supported', [
  z.object({
    supported: z.literal(true),
    androidApis: z.array(z.string().min(1).max(200)).min(1).max(20),
    measurementMode: z.enum(MEASUREMENT_MODES),
    permissions: z.array(z.string().min(1).max(200)).max(20).default([]),
    minRefreshIntervalMs: int(1000, 1800000),
    /** Covering only the pull API leaves any app that registers a listener unhooked. */
    hooksPushDelivery: z.boolean(),
  }).strict(),
  z.object({
    supported: z.literal(false),
    reason: z.string().min(1).max(300),
    /** Unsupported by this build, or unavailable on this image. Different problems, different fixes. */
    cause: z.enum(['NOT_IMPLEMENTED', 'IMAGE_LACKS_HARDWARE', 'PERMISSION_UNAVAILABLE', 'API_UNSUPPORTED']),
  }).strict(),
]);

export const capabilitiesSchema = z.object({
  ...envelopeFields,
  messageType: z.literal('radio.capabilities'),
  imageId: identifier,
  bootId: identifier,
  instanceId: identifier,
  artifacts: artifactsSchema,
  androidRelease: z.string().min(1).max(20),
  sdkInt: int(21, 100),
  abi: z.string().min(1).max(40),
  imageTemplate: z.string().min(1).max(200),
  pluginFrameworkVersion: z.string().min(1).max(80),
  injectionScope: z.enum(INJECTION_SCOPES),
  /** The module's `config.json` `pattern` list. This is the supported scope. */
  pattern: z.array(z.string().min(1).max(200)).max(100),
  scopeFingerprint: sha256,
  systemScopeEvidence: z.object({
    observerPackage: z.string().min(1).max(200), observerProcess: z.string().min(1).max(200), verifiedAtWallMs: elapsed,
  }).strict().nullable().default(null),
  imagePrerequisites: imagePrerequisitesSchema,
  interfaces: z.object({
    wifi: interfaceCapabilitySchema, cells: interfaceCapabilitySchema, bluetooth: interfaceCapabilitySchema,
  }).strict(),
}).strict().superRefine((c, ctx) => {
  if (!c.pattern.length) {
    fail(ctx, ['pattern'], 'Injected scope must enumerate the packages the module takes effect in', 'SCOPE_UNDECLARED');
  } else if (c.scopeFingerprint !== scopeFingerprint(c.pattern)) {
    fail(ctx, ['scopeFingerprint'], 'Scope fingerprint does not match the declared package pattern', 'SCOPE_FINGERPRINT_MISMATCH');
  }
  if (c.injectionScope === 'SYSTEM_MODULE' && (!c.systemScopeEvidence || c.artifacts.module.moduleType !== 'system')) {
    fail(ctx, ['systemScopeEvidence'], 'Scope beyond the package pattern requires a system module and observer evidence from outside it', 'SCOPE_UNPROVEN');
  }
  if (c.injectionScope === 'PACKAGE_PATTERN' && c.systemScopeEvidence) {
    fail(ctx, ['systemScopeEvidence'], 'Package-pattern scope cannot carry system-wide evidence', 'SCOPE_CONFLICT');
  }
  if (c.interfaces.cells.supported && !c.imagePrerequisites.modemPresent) {
    fail(ctx, ['interfaces', 'cells'], 'Cellular readback cannot be supported on an image with no modem', 'PREREQUISITE_CONFLICT');
  }
  if (c.interfaces.bluetooth.supported && !c.imagePrerequisites.bluetoothAdapterPresent) {
    fail(ctx, ['interfaces', 'bluetooth'], 'Bluetooth cannot be supported on an image with no adapter', 'PREREQUISITE_CONFLICT');
  }
});
export type RadioCapabilities = z.infer<typeof capabilitiesSchema>;

// ---------------------------------------------------------------------------
// D03 — HOLD / REPLACE / CLEAR directives
// ---------------------------------------------------------------------------

/**
 * D03. Three distinct instructions, and `entries` is what keeps them apart:
 *
 * - HOLD    (`entries: null`)  leave the existing state alone. Absence of data is never a clear.
 * - REPLACE (`entries: [...]`) the simulated set is exactly this list. `[]` is a positive
 *                              assertion that nothing is present, not missing data.
 * - CLEAR   (`entries: null`)  explicitly remove the controller's own injected state and
 *                              restore what the phone had before the test.
 *
 * Readback uses a separate `availability` vocabulary so an unmeasurable interface can never
 * be confused with a measured-and-empty one.
 */
export const DIRECTIVES = ['HOLD', 'REPLACE', 'CLEAR'] as const;
export type Directive = (typeof DIRECTIVES)[number];

const wifiEntrySchema = z.object({
  bssid: mac, ssid: z.string().min(1).max(32), frequencyMHz: int(2400, 7125), rssiDbm: int(-127, 0),
}).strict();

/**
 * E02/E03. `LTE` and `NR` only, matching what `src/radio/engine.ts` can actually model: an explicit
 * identity, a frequency and explicit propagation parameters. Pre-LTE observations without a
 * frequency cannot satisfy that, so a dataset holding only GSM/UMTS records means cellular is
 * declared unsupported for the release rather than modeled from guessed inputs. Adding a pre-LTE
 * technology is a protocol version bump plus model work, not a field addition.
 */
const cellEntrySchema = z.object({
  identifier: z.string().min(1).max(200), rat: z.enum(['LTE', 'NR']),
  mcc: z.string().regex(/^\d{3}$/), mnc: z.string().regex(/^\d{2,3}$/),
  areaCode: int(0, 16777215), cellId: int(0, 68719476735), pci: int(0, 1007).nullable(),
  frequencyMHz: z.number().finite().min(1).max(100000), channel: int(0, 3279165).nullable(),
  rsrpDbm: int(-156, -31), rsrqDb: z.number().finite().min(-43).max(20).nullable(),
  sinrDb: z.number().finite().min(-23).max(40).nullable(), timingAdvance: int(0, 1282).nullable(),
  registered: z.boolean(),
}).strict().superRefine((c, ctx) => {
  const [floor, ceiling] = c.rat === 'LTE' ? [-140, -43] : [-156, -31];
  if (c.rsrpDbm < floor || c.rsrpDbm > ceiling) {
    fail(ctx, ['rsrpDbm'], `${c.rat} RSRP must be between ${floor} and ${ceiling} dBm`, 'MEASUREMENT_OUT_OF_RANGE');
  }
  if (c.rat === 'LTE' && (c.cellId > 268435455 || c.areaCode > 65535 || (c.pci ?? 0) > 503)) {
    fail(ctx, ['cellId'], 'Invalid LTE identity range', 'IDENTITY_OUT_OF_RANGE');
  }
});

const bluetoothEntrySchema = z.object({
  address: mac, name: z.string().max(248).nullable(), rssiDbm: int(-127, 0),
  deviceClass: int(0, 16777215).nullable().default(null),
  manufacturerId: int(0, 65535).nullable().default(null),
}).strict();

/** E04. Cache provenance travels with the batch: when it was sampled and the cadence it was sampled at. */
const replaceFields = {
  directive: z.literal('REPLACE'),
  sampledSimElapsedMs: elapsed,
  cacheIntervalMs: int(1000, 1800000),
};
const holdBlock = z.object({ directive: z.literal('HOLD'), entries: z.null() }).strict();
const clearBlock = z.object({ directive: z.literal('CLEAR'), entries: z.null() }).strict();
const directiveBlock = <T extends z.ZodTypeAny>(entry: T, max: number) => z.discriminatedUnion('directive', [
  holdBlock, clearBlock,
  z.object({ ...replaceFields, entries: z.array(entry).max(max) }).strict(),
]);

export type DirectiveBlock<T> =
  | { directive: 'HOLD' | 'CLEAR'; entries: null }
  | { directive: 'REPLACE'; entries: T[]; sampledSimElapsedMs: number; cacheIntervalMs: number };

// ---------------------------------------------------------------------------
// A03 — controller -> plugin application request
// ---------------------------------------------------------------------------

export const APPLY_PHASES = ['MOVING', 'ARRIVED', 'CLEANUP'] as const;

export const applyRequestSchema = z.object({
  ...envelopeFields,
  messageType: z.literal('radio.apply'),
  identity: identitySchema,
  /** Monotonic per session. A repeat must be answered from the stored result, never re-applied. */
  sequence: elapsed,
  /** SIM domain. The modeled instant this frame represents. */
  simElapsedMs: elapsed,
  /** B06. The plugin must not apply this frame after `validForMs` past receipt. */
  validForMs: int(250, 30000).default(5000),
  /**
   * A02. The scope this frame was computed for. The agent rejects a frame whose fingerprint does
   * not match the module's current `pattern`, so a scope change cannot silently widen or narrow
   * what the evidence covers.
   */
  scopeFingerprint: sha256,
  phase: z.enum(APPLY_PHASES),
  /** Correlation only. GPS is applied by the player, never by this message. */
  position: positionSchema,
  frameHash: sha256,
  wifi: directiveBlock(wifiEntrySchema, 512),
  cells: directiveBlock(cellEntrySchema, 64),
  bluetooth: directiveBlock(bluetoothEntrySchema, 128),
  warnings: z.array(z.string().min(1).max(200)).max(200).default([]),
}).strict().superRefine((request, ctx) => {
  for (const name of ['wifi', 'cells', 'bluetooth'] as const) {
    const block = request[name];
    if (block.directive !== 'REPLACE') continue;
    if (block.sampledSimElapsedMs > request.simElapsedMs) {
      fail(ctx, [name, 'sampledSimElapsedMs'], 'A cached sample cannot be newer than the frame it is delivered in', 'SAMPLE_AHEAD_OF_FRAME');
    }
  }
  if (request.cells.directive === 'REPLACE' && request.cells.entries.filter(c => c.registered).length > 1) {
    fail(ctx, ['cells'], 'At most one cell may be registered as serving', 'MULTIPLE_SERVING_CELLS');
  }
  if (request.phase === 'CLEANUP') {
    for (const name of ['wifi', 'cells', 'bluetooth'] as const) {
      if (request[name].directive === 'REPLACE') {
        fail(ctx, [name, 'directive'], 'Cleanup frames may only HOLD or CLEAR', 'CLEANUP_APPLIES_STATE');
      }
    }
  }
  if (request.phase === 'MOVING' && request.bluetooth.directive === 'REPLACE') {
    fail(ctx, ['bluetooth', 'directive'], 'Bluetooth may only be replaced after confirmed arrival', 'BLUETOOTH_REPLACED_IN_MOTION');
  }
});
export type ApplyRequest = z.infer<typeof applyRequestSchema>;

// ---------------------------------------------------------------------------
// A04 — result lifecycle
// ---------------------------------------------------------------------------

/**
 * A04. Wire lifecycle, in the order the plugin may report it.
 *
 * - RECEIVED  authenticated and parsed. Nothing has been written.
 * - VALIDATED schema, identity and freshness accepted. Nothing has been written yet.
 * - APPLIED   every in-scope interface reached its instructed state.
 * - PARTIAL   at least one interface reached it and at least one did not.
 * - REJECTED  refused before any write; phone state is unchanged.
 * - EXPIRED   arrived beyond `validForMs`; refused without writing.
 * - FAILED    a write was attempted and errored; state is uncertain unless `rolledBack`.
 *
 * OBSERVED is deliberately absent: only the independent readback collector produces it,
 * and it is never inferred from a result. TIMED_OUT is controller-side only.
 */
export const WIRE_LIFECYCLE = ['RECEIVED', 'VALIDATED', 'APPLIED', 'PARTIAL', 'REJECTED', 'EXPIRED', 'FAILED'] as const;
export type WireLifecycle = (typeof WIRE_LIFECYCLE)[number];
export type ControllerApplicationState = WireLifecycle | 'TIMED_OUT';

/**
 * `UNSUPPORTED_IN_SCOPE` (this build does not hook the interface), `UNAVAILABLE` (the image cannot
 * provide it at all) and `FAILED` (the write errored) are three different problems with three
 * different fixes. `PENDING` means not yet attempted, which is never a degree of failure.
 */
export const INTERFACE_OUTCOMES = ['PENDING', 'APPLIED', 'HELD', 'CLEARED', 'REJECTED', 'UNSUPPORTED_IN_SCOPE', 'UNAVAILABLE', 'FAILED'] as const;
export type InterfaceOutcome = (typeof INTERFACE_OUTCOMES)[number];
const SETTLED_OK: InterfaceOutcome[] = ['APPLIED', 'HELD', 'CLEARED'];
const WROTE_STATE: InterfaceOutcome[] = ['APPLIED', 'CLEARED'];

const interfaceResultSchema = z.object({
  outcome: z.enum(INTERFACE_OUTCOMES),
  appliedCount: elapsed.nullable(),
  code: z.enum(REJECT_CODES).nullable(),
  message: z.string().max(300).nullable(),
}).strict().superRefine((r, ctx) => {
  if (SETTLED_OK.includes(r.outcome) && r.code) fail(ctx, ['code'], 'A settled interface cannot carry a reject code', 'OUTCOME_CODE_CONFLICT');
  if (!SETTLED_OK.includes(r.outcome) && r.outcome !== 'PENDING' && !r.code) {
    fail(ctx, ['code'], 'An unsuccessful interface must name its reject code', 'OUTCOME_CODE_MISSING');
  }
  if (r.outcome === 'APPLIED' && r.appliedCount === null) fail(ctx, ['appliedCount'], 'An applied interface must report how many entries it wrote', 'APPLIED_COUNT_MISSING');
});

export const applyResultSchema = z.object({
  ...envelopeFields,
  messageType: z.literal('radio.result'),
  identity: identitySchema,
  requestMessageId: z.string().uuid(),
  sequence: elapsed,
  frameHash: sha256,
  lifecycle: z.enum(WIRE_LIFECYCLE),
  /** True when this is a replayed answer for an already-seen sequence. Re-application is forbidden. */
  duplicate: z.boolean().default(false),
  receivedAtBootMs: elapsed,
  /** PHONE_BOOT domain. Null unless something was actually written. */
  appliedAtBootMs: elapsed.nullable(),
  interfaces: z.object({ wifi: interfaceResultSchema, cells: interfaceResultSchema, bluetooth: interfaceResultSchema }).strict(),
  rejection: z.object({
    code: z.enum(REJECT_CODES), message: z.string().min(1).max(300), field: z.string().max(200).nullable().default(null),
  }).strict().nullable(),
  stateCertainty: z.enum(['CERTAIN', 'UNCERTAIN']),
  rolledBack: z.boolean().default(false),
}).strict().superRefine((r, ctx) => {
  const outcomes = [r.interfaces.wifi.outcome, r.interfaces.cells.outcome, r.interfaces.bluetooth.outcome];
  const wrote = outcomes.some(o => WROTE_STATE.includes(o));
  const settled = outcomes.filter(o => SETTLED_OK.includes(o));
  const unsettled = outcomes.filter(o => o !== 'PENDING' && !SETTLED_OK.includes(o));

  // Receipt is not application: an acknowledged frame reports no interface progress at all.
  if (r.lifecycle === 'RECEIVED' || r.lifecycle === 'VALIDATED') {
    if (outcomes.some(o => o !== 'PENDING')) fail(ctx, ['interfaces'], `${r.lifecycle} may not report interface progress`, 'RECEIPT_CLAIMS_APPLICATION');
    if (r.appliedAtBootMs !== null) fail(ctx, ['appliedAtBootMs'], `${r.lifecycle} may not carry an application time`, 'RECEIPT_CLAIMS_APPLICATION');
    if (r.rejection) fail(ctx, ['rejection'], `${r.lifecycle} may not carry a rejection`, 'LIFECYCLE_CONFLICT');
  }
  if (r.lifecycle === 'APPLIED') {
    if (outcomes.some(o => !SETTLED_OK.includes(o))) fail(ctx, ['interfaces'], 'APPLIED requires every interface to be applied, held or cleared', 'LIFECYCLE_CONFLICT');
    if (r.appliedAtBootMs === null && wrote) fail(ctx, ['appliedAtBootMs'], 'APPLIED requires the boot-domain time of the write', 'APPLICATION_TIME_MISSING');
    if (r.rejection) fail(ctx, ['rejection'], 'APPLIED may not carry a rejection', 'LIFECYCLE_CONFLICT');
  }
  if (r.lifecycle === 'PARTIAL' && (!settled.length || !unsettled.length)) {
    fail(ctx, ['interfaces'], 'PARTIAL requires both a settled and an unsettled interface', 'PARTIAL_NOT_PARTIAL');
  }
  if (r.lifecycle === 'REJECTED' || r.lifecycle === 'EXPIRED') {
    if (!r.rejection) fail(ctx, ['rejection'], `${r.lifecycle} must name its reject code`, 'REJECTION_MISSING');
    if (wrote || r.appliedAtBootMs !== null) fail(ctx, ['interfaces'], `${r.lifecycle} must leave phone state unchanged`, 'REJECTED_WROTE_STATE');
    if (r.stateCertainty !== 'CERTAIN') fail(ctx, ['stateCertainty'], `${r.lifecycle} happens before any write, so state is certain`, 'CERTAINTY_CONFLICT');
  }
  if (r.lifecycle === 'FAILED' && !r.rejection) fail(ctx, ['rejection'], 'FAILED must name why the write failed', 'REJECTION_MISSING');
  if (r.rolledBack && r.stateCertainty !== 'CERTAIN') {
    fail(ctx, ['stateCertainty'], 'A confirmed rollback makes state certain; an unconfirmed one is not a rollback', 'CERTAINTY_CONFLICT');
  }
  if (wrote && r.appliedAtBootMs === null) {
    fail(ctx, ['appliedAtBootMs'], 'An interface that wrote state must report when it did', 'WROTE_WITHOUT_TIME');
  }
  if (r.appliedAtBootMs !== null && r.appliedAtBootMs < r.receivedAtBootMs) {
    fail(ctx, ['appliedAtBootMs'], 'Application cannot precede receipt in the same boot', 'CLOCK_ORDER');
  }
});
export type ApplyResult = z.infer<typeof applyResultSchema>;

/** Reconciliation query for an uncertain or timed-out application. Keyed by session and sequence. */
export const statusQuerySchema = z.object({
  ...envelopeFields, messageType: z.literal('radio.status.query'), identity: identitySchema, sequence: elapsed,
}).strict();

export const statusSchema = z.object({
  ...envelopeFields, messageType: z.literal('radio.status'), identity: identitySchema,
  sequence: elapsed, known: z.boolean(), result: applyResultSchema.nullable(),
  nowBootMs: elapsed, lastAppliedSequence: elapsed.nullable(),
}).strict().superRefine((s, ctx) => {
  if (s.known && !s.result) fail(ctx, ['result'], 'A known sequence must return its stored result', 'STATUS_RESULT_MISSING');
  if (!s.known && s.result) fail(ctx, ['result'], 'An unknown sequence cannot carry a result', 'STATUS_RESULT_CONFLICT');
});

// ---------------------------------------------------------------------------
// A05/E05 — independent readback
// ---------------------------------------------------------------------------

/**
 * E05. Four states, not four degrees of failure:
 *
 * - `MEASURED`             the API was called and returned; `entries: []` means read and empty.
 * - `NOT_YET_MEASURED`     no measurement exists for this interface since application. With Wi-Fi
 *                          scan throttling on, this is the expected state inside a short window.
 * - `UNAVAILABLE`          the value could not be read at all, with the reason named.
 * - `UNSUPPORTED_IN_SCOPE` this build does not hook the interface inside the injected packages.
 *
 * A mismatch is a fifth, separate result and is decided by comparison, never by availability.
 */
export const AVAILABILITY = ['MEASURED', 'NOT_YET_MEASURED', 'UNAVAILABLE', 'UNSUPPORTED_IN_SCOPE'] as const;
export const UNAVAILABLE_REASONS = [
  'PERMISSION_DENIED', 'INTERFACE_DISABLED', 'API_UNSUPPORTED', 'LOCATION_TOGGLE_OFF',
  'NO_MODEM', 'NO_BLUETOOTH_ADAPTER', 'READ_FAILED',
] as const;
export const NOT_YET_MEASURED_REASONS = ['SCAN_THROTTLED', 'SCAN_IN_PROGRESS', 'NO_CALLBACK_YET', 'CACHE_PREDATES_APPLICATION'] as const;

/**
 * A05/§5.6 of the build brief. `INJECTED_HOOK` is the honest label when the value came back from the
 * module's own hook: a post-application timestamp on such a value proves the hook re-ran, not that a
 * radio scanned. `PLATFORM_CACHE` and `LIVE_SCAN` are the paths Wi-Fi throttling constrains.
 */
export const COLLECTION_METHODS = ['LIVE_SCAN', 'PLATFORM_CACHE', 'PUSH_CALLBACK', 'INJECTED_HOOK'] as const;

const measurementBlock = <T extends z.ZodTypeAny>(entry: T, max: number) => z.discriminatedUnion('availability', [
  z.object({
    availability: z.literal('MEASURED'), entries: z.array(entry).max(max), measurementMode: z.enum(MEASUREMENT_MODES),
    collectionMethod: z.enum(COLLECTION_METHODS), apiSource: z.string().min(1).max(200),
  }).strict(),
  z.object({
    availability: z.literal('NOT_YET_MEASURED'), reason: z.enum(NOT_YET_MEASURED_REASONS), entries: z.null(),
  }).strict(),
  z.object({
    availability: z.literal('UNAVAILABLE'), reason: z.enum(UNAVAILABLE_REASONS), entries: z.null(),
  }).strict(),
  z.object({
    availability: z.literal('UNSUPPORTED_IN_SCOPE'), reason: z.string().min(1).max(300), entries: z.null(),
  }).strict(),
]);

const wifiObservationSchema = wifiEntrySchema.extend({ measuredAtBootUs: elapsed }).strict();
const cellObservationSchema = z.object({
  identifier: z.string().min(1).max(200), registered: z.boolean(), rsrpDbm: int(-156, -31),
  rsrqDb: z.number().finite().min(-43).max(20).nullable().default(null),
  sinrDb: z.number().finite().min(-23).max(40).nullable().default(null),
  timingAdvance: int(0, 1282).nullable().default(null),
  measuredAtBootMs: elapsed,
}).strict();
const bluetoothObservationSchema = z.object({
  address: mac, name: z.string().max(248).nullable().default(null), rssiDbm: int(-127, 0), measuredAtBootMs: elapsed,
}).strict();

/**
 * A02/A05. Whether the observing package is inside the module's `pattern` decides what its report
 * can mean. An in-scope observer's match is the fidelity evidence. An out-of-scope observer is a
 * negative control: it *should* report the host's real radios and not match, and that non-match is
 * a correct result, not a failure. `UNKNOWN` supports no claim in either direction.
 */
export const SCOPE_MEMBERSHIPS = ['IN_SCOPE', 'OUT_OF_SCOPE', 'UNKNOWN'] as const;
export type ScopeMembership = (typeof SCOPE_MEMBERSHIPS)[number];

export const readbackSchema = z.object({
  ...envelopeFields,
  messageType: z.literal('radio.readback'),
  identity: identitySchema,
  scope: z.literal('ANDROID_API_READBACK'),
  /** Fixed. Injection fidelity and scope are what a readback can establish; physical RF is not. */
  evidenceClass: z.literal(EVIDENCE_CLASS),
  /** A05. Who read the values, so an echo of the submitted payload is distinguishable. */
  observerPackage: z.string().min(1).max(200),
  observerProcess: z.string().min(1).max(200),
  observerPid: int(1, 4194304),
  observerUid: int(0, 2147483647),
  scopeMembership: z.enum(SCOPE_MEMBERSHIPS),
  /** The scope the observer resolved membership against; must match the frame it verifies. */
  scopeFingerprint: sha256,
  /**
   * E04. Read from `Settings.Global.wifi_scan_throttle_enabled`. When throttling is on, a fresh
   * post-application scan is not reliably obtainable, and Wi-Fi verification is inconclusive rather
   * than mismatched.
   */
  wifiScanThrottleDisabled: z.boolean(),
  sequence: elapsed,
  frameHash: sha256,
  observedAtBootMs: elapsed,
  /** Copied from the result being verified, so pre-application samples are identifiable. */
  appliedAtBootMs: elapsed,
  wifi: measurementBlock(wifiObservationSchema, 10000),
  cells: measurementBlock(cellObservationSchema, 10000),
  bluetooth: measurementBlock(bluetoothObservationSchema, 10000),
}).strict().superRefine((r, ctx) => {
  if (r.observedAtBootMs < r.appliedAtBootMs) {
    fail(ctx, ['observedAtBootMs'], 'Observation cannot precede the application it verifies', 'CLOCK_ORDER');
  }
  if (r.scopeMembership === 'IN_SCOPE' && r.observerProcess === r.identity.instanceId) {
    fail(ctx, ['observerProcess'], 'The applying process cannot observe itself', 'SELF_OBSERVATION');
  }
  if (r.wifi.availability === 'MEASURED') {
    for (const [i, entry] of r.wifi.entries.entries()) {
      if (Math.floor(entry.measuredAtBootUs / 1000) > r.observedAtBootMs) {
        fail(ctx, ['wifi', 'entries', String(i), 'measuredAtBootUs'], 'A scan result cannot be newer than the report', 'CLOCK_ORDER');
      }
    }
  }
});
export type Readback = z.infer<typeof readbackSchema>;

/** Boot and agent-process identity are answers, not requests, so the open message omits both. */
export const sessionOpenSchema = z.object({
  ...envelopeFields, messageType: z.literal('radio.session.open'),
  identity: identitySchema.omit({ bootId: true, instanceId: true }),
  expectedArtifacts: z.object({
    agentApkSha256: sha256, agentVersionCode: int(1, Number.MAX_SAFE_INTEGER),
    moduleApkSha256: sha256, moduleName: z.string().min(1).max(200),
  }).strict(),
  expectedScopeFingerprint: sha256,
  simStartWallMs: elapsed,
}).strict();

export const sessionOpenedSchema = z.object({
  ...envelopeFields, messageType: z.literal('radio.session.opened'), identity: identitySchema,
  clockAnchor: clockAnchorSchema, capabilitiesMessageId: z.string().uuid(),
  scopeFingerprint: sha256,
  /** H02/E01. The dataset revision the run is pinned to; a change mid-session ends the session. */
  datasetRevisionPinned: z.boolean(),
}).strict().superRefine((s, ctx) => {
  if (s.clockAnchor.bootId !== s.identity.bootId) {
    fail(ctx, ['clockAnchor', 'bootId'], 'The clock anchor belongs to the session boot identity', 'BOOT_MISMATCH');
  }
  if (!s.datasetRevisionPinned) {
    fail(ctx, ['datasetRevisionPinned'], 'A session must be pinned to the dataset revision it was planned against', 'DATASET_UNPINNED');
  }
});

export const sessionCloseSchema = z.object({
  ...envelopeFields, messageType: z.literal('radio.session.close'), identity: identitySchema,
  reason: z.enum(['COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED', 'CONTROLLER_RESTART']),
}).strict();

export const sessionClosedSchema = z.object({
  ...envelopeFields, messageType: z.literal('radio.session.closed'), identity: identitySchema,
  cleanupOk: z.boolean(), residualState: z.array(z.enum(['WIFI', 'CELLS', 'BLUETOOTH'])).max(3),
  message: z.string().max(300).nullable().default(null),
}).strict().superRefine((s, ctx) => {
  if (s.cleanupOk && s.residualState.length) {
    fail(ctx, ['residualState'], 'Confirmed cleanup cannot leave residual injected state', 'CLEANUP_CONFLICT');
  }
});

export const helloSchema = z.object({
  ...envelopeFields, messageType: z.literal('radio.hello'), imageId: identifier,
  controllerVersion: z.string().min(1).max(80),
}).strict();

const SCHEMAS = {
  'radio.hello': helloSchema,
  'radio.capabilities': capabilitiesSchema,
  'radio.session.open': sessionOpenSchema,
  'radio.session.opened': sessionOpenedSchema,
  'radio.apply': applyRequestSchema,
  'radio.result': applyResultSchema,
  'radio.status.query': statusQuerySchema,
  'radio.status': statusSchema,
  'radio.readback': readbackSchema,
  'radio.session.close': sessionCloseSchema,
  'radio.session.closed': sessionClosedSchema,
} as const satisfies Record<MessageType, z.ZodTypeAny>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function fail(ctx: z.RefinementCtx, path: (string | number)[], message: string, detail: string) {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message, params: { detail } });
}

export type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; code: RejectCode; detail: string | null; message: string; path: string | null };

const reject = (code: RejectCode, message: string, detail: string | null = null, path: string | null = null): Validation<never> =>
  ({ ok: false, code, detail, message, path });

function fromZod(error: z.ZodError): Validation<never> {
  const issue = error.issues[0]!;
  const detail = (issue as { params?: { detail?: string } }).params?.detail ?? null;
  const path = issue.path.length ? issue.path.join('.') : null;
  return reject('MALFORMED_MESSAGE', issue.message, detail, path);
}

const envelopePeek = z.object({
  protocol: z.unknown(), protocolVersion: z.unknown(), messageType: z.unknown(),
}).passthrough();

/**
 * Version before shape: an incompatible protocol is reported as a version rejection even when
 * the rest of the message is also unparseable, so neither side guesses at a partial upgrade.
 */
export function validateMessage(raw: unknown): Validation<z.infer<(typeof SCHEMAS)[MessageType]>> {
  const peek = envelopePeek.safeParse(raw);
  if (!peek.success) return reject('MALFORMED_MESSAGE', 'Message must be an object with a protocol envelope');
  const { protocol, protocolVersion, messageType } = peek.data;
  if (protocol !== RADIO_PROTOCOL) {
    return reject('PROTOCOL_VERSION_UNSUPPORTED', `Unsupported protocol ${JSON.stringify(protocol)}; expected ${RADIO_PROTOCOL}`, 'PROTOCOL_NAME', 'protocol');
  }
  if (protocolVersion !== RADIO_PROTOCOL_VERSION) {
    return reject('PROTOCOL_VERSION_UNSUPPORTED', `Unsupported protocol version ${JSON.stringify(protocolVersion)}; expected ${RADIO_PROTOCOL_VERSION}`, 'PROTOCOL_VERSION', 'protocolVersion');
  }
  if (typeof messageType !== 'string' || !(messageType in SCHEMAS)) {
    return reject('MESSAGE_TYPE_UNSUPPORTED', `Unsupported message type ${JSON.stringify(messageType)}`, null, 'messageType');
  }
  const parsed = SCHEMAS[messageType as MessageType].safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : fromZod(parsed.error);
}

export function validateAs<K extends MessageType>(messageType: K, raw: unknown): Validation<z.infer<(typeof SCHEMAS)[K]>> {
  const result = validateMessage(raw);
  if (!result.ok) return result;
  if (result.value.messageType !== messageType) {
    return reject('MESSAGE_TYPE_UNSUPPORTED', `Expected ${messageType}, received ${result.value.messageType}`, null, 'messageType');
  }
  return result as Validation<z.infer<(typeof SCHEMAS)[K]>>;
}

// ---------------------------------------------------------------------------
// Controller-side interpretation of a result (A04)
// ---------------------------------------------------------------------------

export type RetryPolicy = 'NONE' | 'NEW_FRAME' | 'STATUS_QUERY';
export interface ApplicationVerdict {
  state: ControllerApplicationState;
  /** True only when the plugin confirmed a write. Never true for RECEIVED, VALIDATED or a timeout. */
  applied: boolean;
  /** True when the controller cannot tell whether phone state changed. Blocks a competing writer. */
  uncertain: boolean;
  retry: RetryPolicy;
  interfacesApplied: InterfaceOutcome[];
  reason: string | null;
}

/** A04. The single place the controller decides what a result means. Receipt never counts as application. */
export function interpretResult(result: ApplyResult): ApplicationVerdict {
  const outcomes = [result.interfaces.wifi.outcome, result.interfaces.cells.outcome, result.interfaces.bluetooth.outcome];
  const base = { state: result.lifecycle, interfacesApplied: outcomes, reason: result.rejection?.message ?? null };
  switch (result.lifecycle) {
    case 'RECEIVED':
    case 'VALIDATED':
      return { ...base, applied: false, uncertain: false, retry: 'NONE' };
    case 'APPLIED':
      return { ...base, applied: true, uncertain: false, retry: 'NONE' };
    case 'PARTIAL':
      return { ...base, applied: false, uncertain: false, retry: 'NEW_FRAME' };
    case 'EXPIRED':
      return { ...base, applied: false, uncertain: false, retry: 'NEW_FRAME' };
    case 'REJECTED':
      return { ...base, applied: false, uncertain: false, retry: retryableRejection(result.rejection?.code) ? 'NEW_FRAME' : 'NONE' };
    case 'FAILED':
      return { ...base, applied: false, uncertain: result.stateCertainty === 'UNCERTAIN' && !result.rolledBack, retry: result.rolledBack ? 'NEW_FRAME' : 'STATUS_QUERY' };
  }
}

const RETRYABLE: RejectCode[] = ['RATE_LIMITED', 'INTERNAL_ERROR', 'FRAME_EXPIRED', 'CLOCK_UNANCHORED'];
const retryableRejection = (code?: RejectCode) => code !== undefined && RETRYABLE.includes(code);

/**
 * A04. A missing response is not a failed application. The controller holds ownership, marks the
 * frame uncertain and reconciles through `radio.status` or an independent readback.
 */
export function timedOutVerdict(sequence: number): ApplicationVerdict {
  return {
    state: 'TIMED_OUT', applied: false, uncertain: true, retry: 'STATUS_QUERY',
    interfacesApplied: ['PENDING', 'PENDING', 'PENDING'],
    reason: `No result for sequence ${sequence}; application state is unknown`,
  };
}

/** Guard for callers that must not proceed on receipt alone. */
export function assertApplied(result: ApplyResult): void {
  const verdict = interpretResult(result);
  if (!verdict.applied) throw new Error(`Radio frame ${result.sequence} is ${verdict.state}, not applied`);
}

// ---------------------------------------------------------------------------
// A02 — frames must stay inside the declared scope and capability
// ---------------------------------------------------------------------------

export interface CapabilityViolation { code: RejectCode; field: string; message: string }

/**
 * A02/E02. Checks a frame against what the build actually declared, before it is sent. A frame that
 * asks an unsupported interface to change, or that was computed for a different injected scope, is a
 * controller-side error rather than something to discover from a plugin rejection.
 */
export function frameCapabilityViolations(request: ApplyRequest, capabilities: RadioCapabilities): CapabilityViolation[] {
  const violations: CapabilityViolation[] = [];
  if (request.scopeFingerprint !== capabilities.scopeFingerprint) {
    violations.push({ code: 'SCOPE_CHANGED', field: 'scopeFingerprint', message: 'Frame was computed for a different injected package scope' });
  }
  if (request.identity.imageId !== capabilities.imageId) {
    violations.push({ code: 'IDENTITY_MISMATCH', field: 'identity.imageId', message: 'Frame targets a different physical image' });
  }
  if (request.identity.bootId !== capabilities.bootId) {
    violations.push({ code: 'BOOT_MISMATCH', field: 'identity.bootId', message: 'Frame belongs to a previous boot' });
  }
  if (request.identity.instanceId !== capabilities.instanceId) {
    violations.push({ code: 'INSTANCE_MISMATCH', field: 'identity.instanceId', message: 'Frame belongs to a previous agent process' });
  }
  if (!capabilities.imagePrerequisites.locationMasterToggleOn) {
    violations.push({ code: 'IMAGE_PREREQUISITE_MISSING', field: 'imagePrerequisites.locationMasterToggleOn', message: 'Wi-Fi scan results and cell info return empty while the location toggle is off' });
  }
  for (const name of ['wifi', 'cells', 'bluetooth'] as const) {
    const capability = capabilities.interfaces[name];
    if (request[name].directive === 'REPLACE' && !capability.supported) {
      violations.push({ code: 'INTERFACE_UNAVAILABLE', field: name, message: `${name} is declared unsupported on this build or image: ${capability.reason}` });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Bridge from the modeled frame to the wire request
// ---------------------------------------------------------------------------

export interface FrameRequestContext {
  messageId: string; bootId: string; instanceId: string; scopeFingerprint: string;
  sentAtWallMs: number; frameHash: string;
  wifiCacheIntervalMs: number; bluetoothCacheIntervalMs: number; validForMs?: number;
  /** Frames whose Bluetooth is held do not carry a Bluetooth sample time. */
  wifiSampledSimElapsedMs: number; bluetoothSampledSimElapsedMs: number | null;
}

/**
 * Translates a modeled frame into the wire request, preserving the model's own HOLD/REPLACE
 * decision and the original sample times. Cached samples keep their age; they are never
 * re-stamped to the frame time.
 */
export function applyRequestFromFrame(frame: RadioFrame, context: FrameRequestContext): ApplyRequest {
  const replaceBluetooth = frame.bluetoothAction === 'REPLACE' && frame.bluetooth !== null;
  const request = {
    protocol: RADIO_PROTOCOL, protocolVersion: RADIO_PROTOCOL_VERSION, messageType: 'radio.apply' as const,
    messageId: context.messageId, sentAtWallMs: context.sentAtWallMs,
    identity: {
      tenantId: frame.tenantId, imageId: frame.imageId, sessionId: frame.sessionId,
      bootId: context.bootId, instanceId: context.instanceId, datasetRevision: frame.datasetRevision,
    },
    sequence: frame.sequence, simElapsedMs: frame.elapsedMs, validForMs: context.validForMs ?? 5000,
    scopeFingerprint: context.scopeFingerprint,
    phase: replaceBluetooth ? ('ARRIVED' as const) : ('MOVING' as const),
    position: frame.position, frameHash: context.frameHash,
    wifi: {
      directive: 'REPLACE' as const, sampledSimElapsedMs: context.wifiSampledSimElapsedMs,
      cacheIntervalMs: context.wifiCacheIntervalMs,
      entries: frame.wifi.map(w => ({ bssid: w.bssid, ssid: w.ssid, frequencyMHz: w.frequencyMHz, rssiDbm: w.rssiDbm })),
    },
    cells: {
      directive: 'REPLACE' as const, sampledSimElapsedMs: frame.elapsedMs, cacheIntervalMs: 1000,
      entries: frame.cells.map(c => ({
        identifier: c.identifier, rat: c.identity.rat, mcc: c.identity.mcc, mnc: c.identity.mnc,
        areaCode: c.identity.areaCode, cellId: c.identity.cellId, pci: c.identity.pci ?? null,
        frequencyMHz: c.frequencyMHz, channel: c.identity.channel ?? null, rsrpDbm: c.rsrpDbm,
        rsrqDb: c.rsrqDb, sinrDb: c.sinrDb, timingAdvance: c.timingAdvance, registered: c.registered,
      })),
    },
    bluetooth: replaceBluetooth
      ? {
        directive: 'REPLACE' as const,
        sampledSimElapsedMs: context.bluetoothSampledSimElapsedMs ?? frame.elapsedMs,
        cacheIntervalMs: context.bluetoothCacheIntervalMs,
        entries: frame.bluetooth!.map(b => ({ address: b.address, name: b.name, rssiDbm: b.rssiDbm, deviceClass: null, manufacturerId: null })),
      }
      : { directive: 'HOLD' as const, entries: null },
    warnings: frame.warnings,
  };
  return applyRequestSchema.parse(request);
}
