import { z } from 'zod';
import { positionSchema } from './schema.js';
import type { RadioFrame } from './engine.js';

/**
 * Frozen wire contract for the DuoPlus radio plugin (checklist A02/A03/A04, B05, D03).
 *
 * The controller and the plugin validate the same fixtures in `contracts/radio/v1`.
 * Nothing here applies radio state; these are message shapes plus the cross-field rules
 * that keep receipt, application and observation separate.
 */
export const RADIO_PROTOCOL = 'duoplus.radio';
export const RADIO_PROTOCOL_VERSION = 1;

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
  'AUTH_FAILED', 'IDENTITY_MISMATCH', 'SESSION_UNKNOWN', 'BOOT_MISMATCH', 'CLOCK_UNANCHORED',
  'SEQUENCE_REPLAY', 'FRAME_EXPIRED', 'FIELD_UNSUPPORTED', 'INTERFACE_UNAVAILABLE',
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

/** Carried by every message so a stray frame cannot be matched to the wrong phone, session or boot. */
export const identitySchema = z.object({
  tenantId: identifier, imageId: identifier, sessionId: z.string().uuid(),
  bootId: identifier, datasetRevision: identifier,
}).strict();
export type RadioIdentity = z.infer<typeof identitySchema>;

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
  bootId: identifier, simElapsedMs: elapsed, phoneBootMs: elapsed, wallMs: elapsed,
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
 * A02. `TARGET_PACKAGES` is what DuoPlus plugin documentation actually describes.
 * `DEVICE_WIDE` may only be declared together with observer evidence from a package
 * the plugin does not own, so one successful in-app callback cannot imply fleet coverage.
 */
export const INJECTION_SCOPES = ['SELF_PROCESS', 'TARGET_PACKAGES', 'DEVICE_WIDE'] as const;
export const MEASUREMENT_MODES = ['EXCLUSIVE', 'ADDITIVE'] as const;

const interfaceCapabilitySchema = z.discriminatedUnion('supported', [
  z.object({
    supported: z.literal(true),
    androidApis: z.array(z.string().min(1).max(200)).min(1).max(20),
    measurementMode: z.enum(MEASUREMENT_MODES),
    permissions: z.array(z.string().min(1).max(200)).max(20).default([]),
    minRefreshIntervalMs: int(1000, 1800000),
    scanThrottleDisabled: z.boolean().default(false),
  }).strict(),
  z.object({
    supported: z.literal(false),
    reason: z.string().min(1).max(300),
  }).strict(),
]);

export const capabilitiesSchema = z.object({
  ...envelopeFields,
  messageType: z.literal('radio.capabilities'),
  imageId: identifier,
  pluginPackage: z.string().min(1).max(200),
  pluginVersionName: z.string().min(1).max(80),
  pluginVersionCode: int(1, Number.MAX_SAFE_INTEGER),
  apkSha256: sha256,
  sourceCommit: z.string().regex(/^[a-f0-9]{7,40}$/),
  androidRelease: z.string().min(1).max(20),
  sdkInt: int(21, 100),
  abi: z.string().min(1).max(40),
  imageTemplate: z.string().min(1).max(200),
  pluginFrameworkVersion: z.string().min(1).max(80),
  injectionScope: z.enum(INJECTION_SCOPES),
  targetPackages: z.array(z.string().min(1).max(200)).max(100).default([]),
  deviceWideEvidence: z.object({
    observerPackage: z.string().min(1).max(200), observerProcess: z.string().min(1).max(200), verifiedAtWallMs: elapsed,
  }).strict().nullable().default(null),
  interfaces: z.object({
    wifi: interfaceCapabilitySchema, cells: interfaceCapabilitySchema, bluetooth: interfaceCapabilitySchema,
  }).strict(),
}).strict().superRefine((c, ctx) => {
  if (c.injectionScope === 'TARGET_PACKAGES' && !c.targetPackages.length) {
    fail(ctx, ['targetPackages'], 'TARGET_PACKAGES scope must enumerate the packages it covers', 'SCOPE_UNDECLARED');
  }
  if (c.injectionScope === 'DEVICE_WIDE' && !c.deviceWideEvidence) {
    fail(ctx, ['deviceWideEvidence'], 'Device-wide scope requires observer evidence from another package', 'SCOPE_UNPROVEN');
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

export const INTERFACE_OUTCOMES = ['PENDING', 'APPLIED', 'HELD', 'CLEARED', 'REJECTED', 'UNSUPPORTED', 'UNAVAILABLE', 'FAILED'] as const;
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

export const AVAILABILITY = ['MEASURED', 'UNAVAILABLE', 'OUT_OF_SCOPE'] as const;
export const UNAVAILABLE_REASONS = [
  'PERMISSION_DENIED', 'INTERFACE_DISABLED', 'API_UNSUPPORTED', 'SCAN_THROTTLED', 'NO_RESULT_YET', 'READ_FAILED',
] as const;

/**
 * E05. `MEASURED` with `entries: []` means the interface was read and nothing was present.
 * `UNAVAILABLE` means it could not be read. `OUT_OF_SCOPE` means the declared plugin scope
 * never covered it. These must not collapse into one another.
 */
const measurementBlock = <T extends z.ZodTypeAny>(entry: T, max: number) => z.discriminatedUnion('availability', [
  z.object({
    availability: z.literal('MEASURED'), entries: z.array(entry).max(max), measurementMode: z.enum(MEASUREMENT_MODES),
  }).strict(),
  z.object({
    availability: z.literal('UNAVAILABLE'), reason: z.enum(UNAVAILABLE_REASONS), entries: z.null(),
  }).strict(),
  z.object({
    availability: z.literal('OUT_OF_SCOPE'), reason: z.string().min(1).max(300), entries: z.null(),
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

export const readbackSchema = z.object({
  ...envelopeFields,
  messageType: z.literal('radio.readback'),
  identity: identitySchema,
  scope: z.literal('ANDROID_API_READBACK'),
  /** A05. Who read the values, so an echo of the submitted payload is distinguishable. */
  observerPackage: z.string().min(1).max(200),
  observerProcess: z.string().min(1).max(200),
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
  if (r.wifi.availability === 'MEASURED') {
    for (const [i, entry] of r.wifi.entries.entries()) {
      if (Math.floor(entry.measuredAtBootUs / 1000) > r.observedAtBootMs) {
        fail(ctx, ['wifi', 'entries', String(i), 'measuredAtBootUs'], 'A scan result cannot be newer than the report', 'CLOCK_ORDER');
      }
    }
  }
});
export type Readback = z.infer<typeof readbackSchema>;

export const sessionOpenSchema = z.object({
  ...envelopeFields, messageType: z.literal('radio.session.open'), identity: identitySchema.omit({ bootId: true }),
  expectedCapabilities: z.object({ apkSha256: sha256, pluginVersionCode: int(1, Number.MAX_SAFE_INTEGER) }).strict(),
  simStartWallMs: elapsed,
}).strict();

export const sessionOpenedSchema = z.object({
  ...envelopeFields, messageType: z.literal('radio.session.opened'), identity: identitySchema,
  clockAnchor: clockAnchorSchema, capabilitiesMessageId: z.string().uuid(),
}).strict().superRefine((s, ctx) => {
  if (s.clockAnchor.bootId !== s.identity.bootId) {
    fail(ctx, ['clockAnchor', 'bootId'], 'The clock anchor belongs to the session boot identity', 'BOOT_MISMATCH');
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
// Bridge from the modeled frame to the wire request
// ---------------------------------------------------------------------------

export interface FrameRequestContext {
  messageId: string; bootId: string; sentAtWallMs: number; frameHash: string;
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
      bootId: context.bootId, datasetRevision: frame.datasetRevision,
    },
    sequence: frame.sequence, simElapsedMs: frame.elapsedMs, validForMs: context.validForMs ?? 5000,
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
