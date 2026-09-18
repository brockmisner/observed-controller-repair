import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Writes the shared radio-protocol fixtures that both the controller and the plugin APK
 * validate against. Every case names the outcome the validator must produce, so a
 * disagreement between the two implementations is a test failure rather than a discussion.
 *
 * Run: npm run fixtures:radio
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'contracts/radio/v1');

const PROTOCOL = 'duoplus.radio';
const VERSION = 1;
const SESSION = '4f5b3d02-9a2f-4b70-8c31-0a4f0a2d51aa';
const BOOT = 'boot-8812-2f4a1c90';
const INSTANCE = 'agent-instance-6d1f0b73';
const FRAME_HASH = 'a'.repeat(64);
const AGENT_SHA = 'b'.repeat(64);
const MODULE_SHA = 'c'.repeat(64);
const PLAYER_SHA = '620d7714280e98048a16d7fcd0320fed3d8925c7377997eadad4b99adfcd5dbf';
const SIGNER_SHA = 'e491a1530d21de5adedfea0c166dff502ca773fb60a1667e88ad9bd0320fe451';
const messageId = suffix => `11111111-2222-4333-8444-${String(suffix).padStart(12, '0')}`;

/** The module's config.json `pattern`: the packages the injected environment is visible inside. */
const PATTERN = ['com.android.chrome', 'com.google.android.googlequicksearchbox', 'net.stakeout.duomove.probe'];
const scopeFingerprint = pattern =>
  createHash('sha256').update([...new Set(pattern.map(p => p.trim().toLowerCase()))].sort().join('\n')).digest('hex');
const SCOPE = scopeFingerprint(PATTERN);

const identity = {
  tenantId: 'workspace-brock', imageId: 'N5YK6', sessionId: SESSION, bootId: BOOT, instanceId: INSTANCE,
  datasetRevision: 'miami-beach-7mi:12',
};
const envelope = (messageType, suffix) => ({
  protocol: PROTOCOL, protocolVersion: VERSION, messageType, messageId: messageId(suffix), sentAtWallMs: 1789700000000,
});

const wifiEntries = [
  { bssid: 'a4:2b:8c:00:11:22', ssid: 'OceanDrive-2G', frequencyMHz: 2412, rssiDbm: -61 },
  { bssid: 'a4:2b:8c:00:11:23', ssid: 'OceanDrive-5G', frequencyMHz: 5180, rssiDbm: -74 },
];
const cellEntries = [
  {
    identifier: 'CELL:LTE:310:260:4201:184320011', rat: 'LTE', mcc: '310', mnc: '260', areaCode: 4201,
    cellId: 184320011, pci: 271, frequencyMHz: 1900, channel: 1975, rsrpDbm: -88, rsrqDb: null, sinrDb: null,
    timingAdvance: null, registered: true,
  },
  {
    identifier: 'CELL:LTE:310:260:4201:184320012', rat: 'LTE', mcc: '310', mnc: '260', areaCode: 4201,
    cellId: 184320012, pci: 272, frequencyMHz: 1900, channel: 1975, rsrpDbm: -101, rsrqDb: null, sinrDb: null,
    timingAdvance: null, registered: false,
  },
];
const bluetoothEntries = [
  { address: 'd0:1c:44:9f:2a:10', name: 'Living Room TV', rssiDbm: -68, deviceClass: 1048612, manufacturerId: 117 },
  { address: 'd0:1c:44:9f:2a:11', name: null, rssiDbm: -81, deviceClass: null, manufacturerId: null },
];

const hold = { directive: 'HOLD', entries: null };
const clear = { directive: 'CLEAR', entries: null };
const replace = (entries, sampledSimElapsedMs, cacheIntervalMs) => ({
  directive: 'REPLACE', sampledSimElapsedMs, cacheIntervalMs, entries,
});

/** Frame 47 of a drive: Wi-Fi is a 30-second cached scan, cells refresh every tick, Bluetooth is held. */
const applyMoving = () => ({
  ...envelope('radio.apply', 1),
  identity,
  sequence: 47,
  simElapsedMs: 47000,
  validForMs: 5000,
  scopeFingerprint: SCOPE,
  phase: 'MOVING',
  position: { lat: 25.79065, lng: -80.13000 },
  frameHash: FRAME_HASH,
  wifi: replace(wifiEntries, 30000, 30000),
  cells: replace(cellEntries, 47000, 1000),
  bluetooth: hold,
  warnings: ['SECTOR_UNKNOWN:CELL:LTE:310:260:4201:184320012'],
});

const applyArrival = () => ({
  ...applyMoving(),
  ...envelope('radio.apply', 2),
  sequence: 92,
  simElapsedMs: 92000,
  phase: 'ARRIVED',
  wifi: replace(wifiEntries, 90000, 30000),
  cells: replace(cellEntries, 92000, 1000),
  bluetooth: replace(bluetoothEntries, 92000, 30000),
  warnings: [],
});

const interfaceResult = (outcome, appliedCount = null, code = null, message = null) => ({ outcome, appliedCount, code, message });
const pending = interfaceResult('PENDING');

const resultApplied = () => ({
  ...envelope('radio.result', 20),
  identity,
  requestMessageId: messageId(1),
  sequence: 47,
  frameHash: FRAME_HASH,
  lifecycle: 'APPLIED',
  duplicate: false,
  receivedAtBootMs: 918233,
  appliedAtBootMs: 918241,
  interfaces: {
    wifi: interfaceResult('APPLIED', 2), cells: interfaceResult('APPLIED', 2), bluetooth: interfaceResult('HELD', null),
  },
  rejection: null,
  stateCertainty: 'CERTAIN',
  rolledBack: false,
});

/** An in-scope observer: a process inside the module's `pattern`, separate from the applier. */
const readbackMeasured = () => ({
  ...envelope('radio.readback', 40),
  identity,
  scope: 'ANDROID_API_READBACK',
  evidenceClass: 'INJECTION_FIDELITY',
  observerPackage: 'net.stakeout.duomove.probe',
  observerProcess: 'net.stakeout.duomove.probe:collector',
  observerPid: 8241,
  observerUid: 10231,
  scopeMembership: 'IN_SCOPE',
  scopeFingerprint: SCOPE,
  wifiScanThrottleDisabled: true,
  sequence: 92,
  frameHash: FRAME_HASH,
  observedAtBootMs: 963400,
  appliedAtBootMs: 963120,
  wifi: {
    availability: 'MEASURED', measurementMode: 'EXCLUSIVE', collectionMethod: 'INJECTED_HOOK',
    apiSource: 'WifiManager.getScanResults',
    entries: wifiEntries.map(w => ({ ...w, rssiDbm: w.rssiDbm - 1, measuredAtBootUs: 963300000 })),
  },
  cells: {
    availability: 'MEASURED', measurementMode: 'EXCLUSIVE', collectionMethod: 'INJECTED_HOOK',
    apiSource: 'TelephonyManager.getAllCellInfo',
    entries: cellEntries.map(c => ({
      identifier: c.identifier, registered: c.registered, rsrpDbm: c.rsrpDbm + 2, rsrqDb: null, sinrDb: null,
      timingAdvance: null, measuredAtBootMs: 963310,
    })),
  },
  bluetooth: {
    availability: 'MEASURED', measurementMode: 'EXCLUSIVE', collectionMethod: 'INJECTED_HOOK',
    apiSource: 'BluetoothLeScanner.ScanCallback',
    entries: bluetoothEntries.map(b => ({ address: b.address, name: b.name, rssiDbm: b.rssiDbm, measuredAtBootMs: 963350 })),
  },
});

/** The negative control: a package outside `pattern` correctly sees the host's real radios. */
const readbackOutOfScope = () => variant(readbackMeasured(), m => {
  m.messageId = messageId(41);
  m.observerPackage = 'net.stakeout.duomove.outsider';
  m.observerProcess = 'net.stakeout.duomove.outsider';
  m.observerPid = 8302;
  m.observerUid = 10244;
  m.scopeMembership = 'OUT_OF_SCOPE';
  m.wifi = {
    availability: 'MEASURED', measurementMode: 'ADDITIVE', collectionMethod: 'PLATFORM_CACHE',
    apiSource: 'WifiManager.getScanResults',
    entries: [{ bssid: 'ff:ee:dd:00:00:01', ssid: 'HostRealAP', frequencyMHz: 2437, rssiDbm: -70, measuredAtBootUs: 963300000 }],
  };
  m.cells = { availability: 'UNAVAILABLE', reason: 'NO_MODEM', entries: null };
  m.bluetooth = { availability: 'MEASURED', measurementMode: 'ADDITIVE', collectionMethod: 'LIVE_SCAN', apiSource: 'BluetoothLeScanner.ScanCallback', entries: [] };
});

const capability = (overrides = {}) => ({
  supported: true, androidApis: ['WifiManager.getScanResults'], measurementMode: 'EXCLUSIVE',
  permissions: ['android.permission.ACCESS_FINE_LOCATION'], minRefreshIntervalMs: 30000, hooksPushDelivery: false,
  ...overrides,
});

const artifact = (overrides = {}) => ({
  packageName: 'net.stakeout.duomove.radioagent', versionName: '0.1.0', versionCode: 1,
  apkSha256: AGENT_SHA, signerCertSha256: SIGNER_SHA, sourceCommit: '4e9ee9f', ...overrides,
});

const capabilities = () => ({
  ...envelope('radio.capabilities', 60),
  imageId: 'N5YK6',
  bootId: BOOT,
  instanceId: INSTANCE,
  artifacts: {
    agent: artifact(),
    module: artifact({
      packageName: 'net.stakeout.duomove.radiomodule', apkSha256: MODULE_SHA,
      moduleName: 'duomove-radio', moduleType: 'user',
    }),
    player: artifact({ packageName: 'net.stakeout.duomove.player', versionName: '1.0.0', apkSha256: PLAYER_SHA }),
  },
  androidRelease: '13',
  sdkInt: 33,
  abi: 'arm64-v8a',
  imageTemplate: 'duoplus-android13-default',
  pluginFrameworkVersion: 'dpbridge-1',
  injectionScope: 'PACKAGE_PATTERN',
  pattern: PATTERN,
  scopeFingerprint: SCOPE,
  systemScopeEvidence: null,
  imagePrerequisites: {
    wifiScanThrottleDisabled: true, locationMasterToggleOn: true, modemPresent: true,
    bluetoothAdapterPresent: true, probedAtWallMs: 1789699000000,
  },
  interfaces: {
    wifi: capability({ hooksPushDelivery: true }),
    cells: capability({ androidApis: ['TelephonyManager.getAllCellInfo', 'TelephonyCallback.CellInfoListener'], minRefreshIntervalMs: 1000, hooksPushDelivery: true }),
    bluetooth: capability({ androidApis: ['BluetoothLeScanner.startScan'], minRefreshIntervalMs: 30000 }),
  },
});

/** Deep clone plus a mutation, so each case states only how it differs from a valid message. */
const variant = (base, mutate) => { const copy = structuredClone(base); mutate(copy); return copy; };

const cases = [
  // --- radio.apply: accepted shapes -------------------------------------------------
  ['apply-moving-valid.json', 'radio.apply', 'ACCEPT', null, null,
    'Drive frame: Wi-Fi from a 30 s cached scan, per-tick cells, Bluetooth held.', applyMoving()],
  ['apply-arrival-valid.json', 'radio.apply', 'ACCEPT', null, null,
    'Arrival frame: the only phase permitted to replace Bluetooth.', applyArrival()],
  ['apply-empty-replace-valid.json', 'radio.apply', 'ACCEPT', null, null,
    'REPLACE with an empty list asserts nothing is present; it is not missing data.',
    variant(applyArrival(), m => { m.bluetooth = replace([], 92000, 30000); })],
  ['apply-cleanup-clear-valid.json', 'radio.apply', 'ACCEPT', null, null,
    'Cleanup explicitly clears the controller-injected state on every interface.',
    variant(applyMoving(), m => { m.phase = 'CLEANUP'; m.wifi = clear; m.cells = clear; m.bluetooth = clear; m.warnings = []; })],
  ['apply-hold-all-valid.json', 'radio.apply', 'ACCEPT', null, null,
    'Every interface held: the phone keeps whatever it already has.',
    variant(applyMoving(), m => { m.wifi = hold; m.cells = hold; m.warnings = []; })],

  // --- radio.apply: version rejection ----------------------------------------------
  ['apply-future-protocol-version.json', 'radio.apply', 'REJECT', 'PROTOCOL_VERSION_UNSUPPORTED', 'PROTOCOL_VERSION',
    'A newer protocol version is refused outright rather than partially interpreted.',
    variant(applyMoving(), m => { m.protocolVersion = 2; })],
  ['apply-unknown-protocol.json', 'radio.apply', 'REJECT', 'PROTOCOL_VERSION_UNSUPPORTED', 'PROTOCOL_NAME',
    'A different protocol name is refused before any field is read.',
    variant(applyMoving(), m => { m.protocol = 'duoplus.gps'; })],
  ['apply-unknown-message-type.json', 'radio.apply', 'REJECT', 'MESSAGE_TYPE_UNSUPPORTED', null,
    'An unrecognized message type is never guessed at.',
    variant(applyMoving(), m => { m.messageType = 'radio.apply.v2'; })],

  // --- radio.apply: D03 directive rules --------------------------------------------
  ['apply-hold-with-entries.json', 'radio.apply', 'REJECT', 'MALFORMED_MESSAGE', null,
    'HOLD must carry no payload; a hold that ships data is ambiguous.',
    variant(applyMoving(), m => { m.bluetooth = { directive: 'HOLD', entries: bluetoothEntries }; })],
  ['apply-replace-null-entries.json', 'radio.apply', 'REJECT', 'MALFORMED_MESSAGE', null,
    'REPLACE must carry a list; null would be indistinguishable from a hold.',
    variant(applyMoving(), m => { m.wifi = { directive: 'REPLACE', sampledSimElapsedMs: 30000, cacheIntervalMs: 30000, entries: null }; })],
  ['apply-clear-with-entries.json', 'radio.apply', 'REJECT', 'MALFORMED_MESSAGE', null,
    'CLEAR removes state; it cannot also assert content.',
    variant(applyMoving(), m => { m.wifi = { directive: 'CLEAR', entries: wifiEntries }; })],
  ['apply-unknown-directive.json', 'radio.apply', 'REJECT', 'MALFORMED_MESSAGE', null,
    'Only HOLD, REPLACE and CLEAR exist.',
    variant(applyMoving(), m => { m.wifi = { directive: 'MERGE', entries: wifiEntries }; })],
  ['apply-bluetooth-replaced-in-motion.json', 'radio.apply', 'REJECT', 'MALFORMED_MESSAGE', 'BLUETOOTH_REPLACED_IN_MOTION',
    'Bluetooth replacement during movement is refused by the contract, not only by the arrival gate.',
    variant(applyMoving(), m => { m.bluetooth = replace(bluetoothEntries, 47000, 30000); })],
  ['apply-cleanup-applies-state.json', 'radio.apply', 'REJECT', 'MALFORMED_MESSAGE', 'CLEANUP_APPLIES_STATE',
    'A cleanup frame cannot install new state on its way out.',
    variant(applyMoving(), m => { m.phase = 'CLEANUP'; m.cells = clear; m.warnings = []; })],

  // --- radio.apply: identity, clock and range rules --------------------------------
  ['apply-missing-boot-id.json', 'radio.apply', 'REJECT', 'MALFORMED_MESSAGE', null,
    'Boot identity is mandatory; without it a pre-reboot frame could be applied after a restart.',
    variant(applyMoving(), m => { delete m.identity.bootId; })],
  ['apply-missing-instance-id.json', 'radio.apply', 'REJECT', 'MALFORMED_MESSAGE', null,
    'Agent process identity is separate from boot identity and equally mandatory.',
    variant(applyMoving(), m => { delete m.identity.instanceId; })],
  ['apply-missing-scope-fingerprint.json', 'radio.apply', 'REJECT', 'MALFORMED_MESSAGE', null,
    'Every frame states the injected package scope it was computed for.',
    variant(applyMoving(), m => { delete m.scopeFingerprint; })],
  ['apply-unknown-field.json', 'radio.apply', 'REJECT', 'MALFORMED_MESSAGE', null,
    'Unknown fields are refused. Extensions arrive through capability negotiation, not silent tolerance.',
    variant(applyMoving(), m => { m.rsrqModel = 'estimated'; })],
  ['apply-sample-newer-than-frame.json', 'radio.apply', 'REJECT', 'MALFORMED_MESSAGE', 'SAMPLE_AHEAD_OF_FRAME',
    'A cached sample cannot be dated after the frame delivering it.',
    variant(applyMoving(), m => { m.wifi = replace(wifiEntries, 48000, 30000); })],
  ['apply-negative-sim-clock.json', 'radio.apply', 'REJECT', 'MALFORMED_MESSAGE', null,
    'Simulation time is a non-negative integer in the SIM domain.',
    variant(applyMoving(), m => { m.simElapsedMs = -1; })],
  ['apply-validfor-too-long.json', 'radio.apply', 'REJECT', 'MALFORMED_MESSAGE', null,
    'An unbounded validity window would let a stale frame apply late.',
    variant(applyMoving(), m => { m.validForMs = 600000; })],
  ['apply-two-registered-cells.json', 'radio.apply', 'REJECT', 'MALFORMED_MESSAGE', 'MULTIPLE_SERVING_CELLS',
    'A phone has one serving cell.',
    variant(applyMoving(), m => { m.cells.entries[1].registered = true; })],
  ['apply-lte-rsrp-out-of-range.json', 'radio.apply', 'REJECT', 'MALFORMED_MESSAGE', 'MEASUREMENT_OUT_OF_RANGE',
    'RSRP is range-checked per radio technology: -35 dBm is plausible for NR and impossible for LTE.',
    variant(applyMoving(), m => { m.cells.entries[0].rsrpDbm = -35; })],
  ['apply-rsrp-outside-any-technology.json', 'radio.apply', 'REJECT', 'MALFORMED_MESSAGE', null,
    'A value no radio technology reports is refused by the field range itself.',
    variant(applyMoving(), m => { m.cells.entries[0].rsrpDbm = -20; })],
  ['apply-lte-identity-out-of-range.json', 'radio.apply', 'REJECT', 'MALFORMED_MESSAGE', 'IDENTITY_OUT_OF_RANGE',
    'An NR-sized cell identity cannot be labeled LTE.',
    variant(applyMoving(), m => { m.cells.entries[0].cellId = 268435456; })],
  ['apply-uppercase-bssid.json', 'radio.apply', 'REJECT', 'MALFORMED_MESSAGE', null,
    'Identifiers are normalized to lowercase so comparison never depends on casing.',
    variant(applyMoving(), m => { m.wifi.entries[0].bssid = 'A4:2B:8C:00:11:22'; })],

  // --- radio.result: A04 lifecycle -------------------------------------------------
  ['result-applied-valid.json', 'radio.result', 'ACCEPT', null, null,
    'A complete application: every interface settled and the write is timestamped in boot time.',
    resultApplied()],
  ['result-received-pending-valid.json', 'radio.result', 'ACCEPT', null, null,
    'Receipt only. No interface has progressed and there is no application time.',
    variant(resultApplied(), m => {
      m.lifecycle = 'RECEIVED'; m.appliedAtBootMs = null;
      m.interfaces = { wifi: pending, cells: pending, bluetooth: pending };
    })],
  ['result-partial-valid.json', 'radio.result', 'ACCEPT', null, null,
    'Partial failure names exactly which interface did not reach its instructed state.',
    variant(resultApplied(), m => {
      m.lifecycle = 'PARTIAL';
      m.interfaces.cells = interfaceResult('UNSUPPORTED_IN_SCOPE', null, 'FIELD_UNSUPPORTED', 'timingAdvance injection is not implemented');
    })],
  ['result-cells-unavailable-valid.json', 'radio.result', 'ACCEPT', null, null,
    'Unavailable on this image is a different outcome from unsupported by this build.',
    variant(resultApplied(), m => {
      m.lifecycle = 'PARTIAL';
      m.interfaces.cells = interfaceResult('UNAVAILABLE', null, 'INTERFACE_UNAVAILABLE', 'This image reports no modem');
    })],
  ['result-expired-valid.json', 'radio.result', 'ACCEPT', null, null,
    'A frame that arrived past validForMs is refused without writing anything.',
    variant(resultApplied(), m => {
      m.lifecycle = 'EXPIRED'; m.appliedAtBootMs = null;
      m.interfaces = {
        wifi: interfaceResult('REJECTED', null, 'FRAME_EXPIRED', 'Received 6200 ms after issue'),
        cells: interfaceResult('REJECTED', null, 'FRAME_EXPIRED', 'Received 6200 ms after issue'),
        bluetooth: interfaceResult('REJECTED', null, 'FRAME_EXPIRED', 'Received 6200 ms after issue'),
      };
      m.rejection = { code: 'FRAME_EXPIRED', message: 'Frame 47 exceeded its 5000 ms validity', field: 'validForMs' };
    })],
  ['result-failed-uncertain-valid.json', 'radio.result', 'ACCEPT', null, null,
    'Wi-Fi was written, cells errored and no rollback was confirmed, so phone state is uncertain.',
    variant(resultApplied(), m => {
      m.lifecycle = 'FAILED'; m.stateCertainty = 'UNCERTAIN'; m.rolledBack = false;
      m.interfaces.cells = interfaceResult('FAILED', null, 'INTERNAL_ERROR', 'Injection service died mid-write');
      m.rejection = { code: 'INTERNAL_ERROR', message: 'Injection service died mid-write', field: null };
    })],
  ['result-wrote-without-application-time.json', 'radio.result', 'REJECT', 'MALFORMED_MESSAGE', 'WROTE_WITHOUT_TIME',
    'A write always carries its boot-domain time, even inside a failure.',
    variant(resultApplied(), m => {
      m.lifecycle = 'FAILED'; m.appliedAtBootMs = null; m.stateCertainty = 'UNCERTAIN';
      m.interfaces.cells = interfaceResult('FAILED', null, 'INTERNAL_ERROR', 'write failed');
      m.rejection = { code: 'INTERNAL_ERROR', message: 'write failed', field: null };
    })],
  ['result-duplicate-valid.json', 'radio.result', 'ACCEPT', null, null,
    'A repeated sequence returns the stored answer and is flagged as a duplicate, not re-applied.',
    variant(resultApplied(), m => { m.duplicate = true; })],
  ['result-received-claims-application.json', 'radio.result', 'REJECT', 'MALFORMED_MESSAGE', 'RECEIPT_CLAIMS_APPLICATION',
    'RECEIVED cannot report an applied interface. Receipt is never application.',
    variant(resultApplied(), m => { m.lifecycle = 'RECEIVED'; m.appliedAtBootMs = null; m.interfaces.cells = pending; m.interfaces.bluetooth = pending; })],
  ['result-received-with-application-time.json', 'radio.result', 'REJECT', 'MALFORMED_MESSAGE', 'RECEIPT_CLAIMS_APPLICATION',
    'An acknowledged frame has no application timestamp.',
    variant(resultApplied(), m => { m.lifecycle = 'VALIDATED'; m.interfaces = { wifi: pending, cells: pending, bluetooth: pending }; })],
  ['result-applied-without-timestamp.json', 'radio.result', 'REJECT', 'MALFORMED_MESSAGE', 'APPLICATION_TIME_MISSING',
    'A claimed application must say when, in the phone boot domain, it happened.',
    variant(resultApplied(), m => { m.appliedAtBootMs = null; })],
  ['result-applied-with-unsettled-interface.json', 'radio.result', 'REJECT', 'MALFORMED_MESSAGE', 'LIFECYCLE_CONFLICT',
    'APPLIED cannot hide an unsupported interface; that is PARTIAL.',
    variant(resultApplied(), m => { m.interfaces.bluetooth = interfaceResult('UNSUPPORTED_IN_SCOPE', null, 'FIELD_UNSUPPORTED', 'not hooked in this build'); })],
  ['result-partial-with-nothing-failed.json', 'radio.result', 'REJECT', 'MALFORMED_MESSAGE', 'PARTIAL_NOT_PARTIAL',
    'PARTIAL requires both a settled and an unsettled interface.',
    variant(resultApplied(), m => { m.lifecycle = 'PARTIAL'; })],
  ['result-rejected-wrote-state.json', 'radio.result', 'REJECT', 'MALFORMED_MESSAGE', 'REJECTED_WROTE_STATE',
    'A rejection means nothing was written.',
    variant(resultApplied(), m => {
      m.lifecycle = 'REJECTED';
      m.rejection = { code: 'IDENTITY_MISMATCH', message: 'Frame addressed another session', field: 'identity.sessionId' };
    })],
  ['result-rejected-without-code.json', 'radio.result', 'REJECT', 'MALFORMED_MESSAGE', 'REJECTION_MISSING',
    'Every refusal names a machine-readable code.',
    variant(resultApplied(), m => {
      m.lifecycle = 'REJECTED'; m.appliedAtBootMs = null;
      m.interfaces = { wifi: interfaceResult('REJECTED', null, 'IDENTITY_MISMATCH', 'wrong session'), cells: interfaceResult('REJECTED', null, 'IDENTITY_MISMATCH', 'wrong session'), bluetooth: interfaceResult('REJECTED', null, 'IDENTITY_MISMATCH', 'wrong session') };
    })],
  ['result-rollback-uncertain.json', 'radio.result', 'REJECT', 'MALFORMED_MESSAGE', 'CERTAINTY_CONFLICT',
    'An unconfirmed rollback is not a rollback.',
    variant(resultApplied(), m => {
      m.lifecycle = 'FAILED'; m.appliedAtBootMs = null; m.rolledBack = true; m.stateCertainty = 'UNCERTAIN';
      m.interfaces.cells = interfaceResult('FAILED', null, 'INTERNAL_ERROR', 'write failed');
      m.rejection = { code: 'INTERNAL_ERROR', message: 'write failed', field: null };
    })],
  ['result-applied-before-received.json', 'radio.result', 'REJECT', 'MALFORMED_MESSAGE', 'CLOCK_ORDER',
    'Within one boot, application cannot precede receipt.',
    variant(resultApplied(), m => { m.appliedAtBootMs = 918000; })],
  ['result-settled-interface-with-code.json', 'radio.result', 'REJECT', 'MALFORMED_MESSAGE', 'OUTCOME_CODE_CONFLICT',
    'A settled interface carries no reject code.',
    variant(resultApplied(), m => { m.interfaces.wifi = interfaceResult('APPLIED', 2, 'RATE_LIMITED', 'throttled'); })],

  // --- radio.readback: A05/E05 -----------------------------------------------------
  ['readback-measured-valid.json', 'radio.readback', 'ACCEPT', null, null,
    'An independent observer reports what the Android APIs returned, with its own package and process.',
    readbackMeasured()],
  ['readback-empty-measured-valid.json', 'radio.readback', 'ACCEPT', null, null,
    'Measured and empty. Distinct from unavailable.',
    variant(readbackMeasured(), m => { m.bluetooth = { ...m.bluetooth, entries: [] }; })],
  ['readback-unavailable-valid.json', 'radio.readback', 'ACCEPT', null, null,
    'An interface that could not be read stays unavailable and names why.',
    variant(readbackMeasured(), m => { m.cells = { availability: 'UNAVAILABLE', reason: 'PERMISSION_DENIED', entries: null }; })],
  ['readback-no-modem-valid.json', 'radio.readback', 'ACCEPT', null, null,
    'An image with no modem makes cellular readback unavailable however well injection works.',
    variant(readbackMeasured(), m => { m.cells = { availability: 'UNAVAILABLE', reason: 'NO_MODEM', entries: null }; })],
  ['readback-not-yet-measured-valid.json', 'radio.readback', 'ACCEPT', null, null,
    'Wi-Fi scan throttling leaves no post-application scan yet. Not measured is not unavailable.',
    variant(readbackMeasured(), m => {
      m.wifiScanThrottleDisabled = false;
      m.wifi = { availability: 'NOT_YET_MEASURED', reason: 'SCAN_THROTTLED', entries: null };
    })],
  ['readback-unsupported-in-scope-valid.json', 'radio.readback', 'ACCEPT', null, null,
    'An interface this build does not hook inside the injected packages is neither match nor mismatch.',
    variant(readbackMeasured(), m => { m.bluetooth = { availability: 'UNSUPPORTED_IN_SCOPE', reason: 'This build hooks no Bluetooth API inside the pattern packages', entries: null }; })],
  ['readback-out-of-scope-observer-valid.json', 'radio.readback', 'ACCEPT', null, null,
    'The negative control: a package outside the pattern reports the host\'s real radios.',
    readbackOutOfScope()],
  ['readback-scope-unknown-valid.json', 'radio.readback', 'ACCEPT', null, null,
    'An observer whose scope membership was not resolved supports no coverage claim either way.',
    variant(readbackMeasured(), m => { m.scopeMembership = 'UNKNOWN'; })],
  ['readback-additive-mode-valid.json', 'radio.readback', 'ACCEPT', null, null,
    'An additive observer sees real networks alongside injected ones; extras are expected there.',
    variant(readbackMeasured(), m => {
      m.wifi.measurementMode = 'ADDITIVE';
      m.wifi.entries.push({ bssid: 'ff:ee:dd:00:00:01', ssid: 'NeighbourNet', frequencyMHz: 2437, rssiDbm: -83, measuredAtBootUs: 963300000 });
    })],
  ['readback-live-scan-valid.json', 'radio.readback', 'ACCEPT', null, null,
    'Collection method is recorded per interface: a hooked read and a real scan are different evidence.',
    variant(readbackMeasured(), m => { m.wifi.collectionMethod = 'LIVE_SCAN'; })],
  ['readback-unavailable-with-entries.json', 'radio.readback', 'REJECT', 'MALFORMED_MESSAGE', null,
    'Unavailable cannot carry measurements.',
    variant(readbackMeasured(), m => { m.cells = { availability: 'UNAVAILABLE', reason: 'READ_FAILED', entries: [] }; })],
  ['readback-unknown-availability.json', 'radio.readback', 'REJECT', 'MALFORMED_MESSAGE', null,
    'Availability is exactly MEASURED, NOT_YET_MEASURED, UNAVAILABLE or UNSUPPORTED_IN_SCOPE.',
    variant(readbackMeasured(), m => { m.wifi = { availability: 'PARTIAL', entries: [] }; })],
  ['readback-missing-collection-method.json', 'radio.readback', 'REJECT', 'MALFORMED_MESSAGE', null,
    'A measured interface must say which API produced the value and whether it was live or cached.',
    variant(readbackMeasured(), m => { delete m.wifi.collectionMethod; })],
  ['readback-wrong-scope.json', 'radio.readback', 'REJECT', 'MALFORMED_MESSAGE', null,
    'Only an Android API readback counts; a provider acknowledgment does not.',
    variant(readbackMeasured(), m => { m.scope = 'PLUGIN_ACK'; })],
  ['readback-rf-evidence-claim.json', 'radio.readback', 'REJECT', 'MALFORMED_MESSAGE', null,
    'A readback establishes injection fidelity. It cannot relabel itself as physical RF measurement.',
    variant(readbackMeasured(), m => { m.evidenceClass = 'PHYSICAL_RF'; })],
  ['readback-missing-observer.json', 'radio.readback', 'REJECT', 'MALFORMED_MESSAGE', null,
    'The observing package and process are mandatory, so an echo of the request is identifiable.',
    variant(readbackMeasured(), m => { delete m.observerPackage; })],
  ['readback-missing-scope-membership.json', 'radio.readback', 'REJECT', 'MALFORMED_MESSAGE', null,
    'Whether the observer sits inside the injected packages decides what its report can mean.',
    variant(readbackMeasured(), m => { delete m.scopeMembership; })],
  ['readback-self-observation.json', 'radio.readback', 'REJECT', 'MALFORMED_MESSAGE', 'SELF_OBSERVATION',
    'The applying process cannot be its own observer; that is the weakness the current player has.',
    variant(readbackMeasured(), m => { m.observerProcess = INSTANCE; })],
  ['readback-privileged-identifier.json', 'radio.readback', 'REJECT', 'MALFORMED_MESSAGE', null,
    'IMEI, IMSI and ICCID are privileged since Android 10 and are never part of a comparison.',
    variant(readbackMeasured(), m => { m.imsi = '310260123456789'; })],
  ['readback-observed-before-applied.json', 'radio.readback', 'REJECT', 'MALFORMED_MESSAGE', 'CLOCK_ORDER',
    'An observation cannot precede the application it verifies.',
    variant(readbackMeasured(), m => { m.observedAtBootMs = 963000; })],
  ['readback-scan-newer-than-report.json', 'radio.readback', 'REJECT', 'MALFORMED_MESSAGE', 'CLOCK_ORDER',
    'A scan result cannot be dated after the report carrying it.',
    variant(readbackMeasured(), m => { m.wifi.entries[0].measuredAtBootUs = 999000000; })],

  // --- radio.capabilities: A02 -----------------------------------------------------
  ['capabilities-package-pattern-valid.json', 'radio.capabilities', 'ACCEPT', null, null,
    'Three artifacts and a package pattern: the scope Android and the DuoPlus module framework actually allow.',
    capabilities()],
  ['capabilities-unsupported-interface-valid.json', 'radio.capabilities', 'ACCEPT', null, null,
    'An unsupported interface is declared explicitly, with the cause distinguishing build from image.',
    variant(capabilities(), m => { m.interfaces.bluetooth = { supported: false, reason: 'No Bluetooth injection API in this build', cause: 'NOT_IMPLEMENTED' }; })],
  ['capabilities-no-modem-valid.json', 'radio.capabilities', 'ACCEPT', null, null,
    'An image with no modem declares cellular unsupported with the image as the cause.',
    variant(capabilities(), m => {
      m.imagePrerequisites.modemPresent = false;
      m.interfaces.cells = { supported: false, reason: 'This image reports no modem; getAllCellInfo returns empty', cause: 'IMAGE_LACKS_HARDWARE' };
    })],
  ['capabilities-system-scope-valid.json', 'radio.capabilities', 'ACCEPT', null, null,
    'Scope beyond the pattern requires a system module and observer evidence from outside it.',
    variant(capabilities(), m => {
      m.injectionScope = 'SYSTEM_MODULE'; m.artifacts.module.moduleType = 'system';
      m.systemScopeEvidence = { observerPackage: 'net.stakeout.duomove.outsider', observerProcess: 'net.stakeout.duomove.outsider', verifiedAtWallMs: 1789699000000 };
    })],
  ['capabilities-system-scope-unproven.json', 'radio.capabilities', 'REJECT', 'MALFORMED_MESSAGE', 'SCOPE_UNPROVEN',
    'Coverage beyond the injected packages cannot be asserted from one successful in-app callback.',
    variant(capabilities(), m => { m.injectionScope = 'SYSTEM_MODULE'; })],
  ['capabilities-empty-pattern.json', 'radio.capabilities', 'REJECT', 'MALFORMED_MESSAGE', 'SCOPE_UNDECLARED',
    'The supported scope is a package list, so it cannot be empty.',
    variant(capabilities(), m => { m.pattern = []; })],
  ['capabilities-scope-fingerprint-mismatch.json', 'radio.capabilities', 'REJECT', 'MALFORMED_MESSAGE', 'SCOPE_FINGERPRINT_MISMATCH',
    'The fingerprint frames are bound to must be derivable from the declared pattern.',
    variant(capabilities(), m => { m.pattern = [...PATTERN, 'com.example.extra']; })],
  ['capabilities-cells-without-modem.json', 'radio.capabilities', 'REJECT', 'MALFORMED_MESSAGE', 'PREREQUISITE_CONFLICT',
    'Cellular cannot be declared supported on an image probed as having no modem.',
    variant(capabilities(), m => { m.imagePrerequisites.modemPresent = false; })],
  ['capabilities-missing-signer.json', 'radio.capabilities', 'REJECT', 'MALFORMED_MESSAGE', null,
    'The signing certificate digest is what distinguishes an in-place update from a rebuild under a new key.',
    variant(capabilities(), m => { delete m.artifacts.agent.signerCertSha256; })],
  ['capabilities-single-artifact.json', 'radio.capabilities', 'REJECT', 'MALFORMED_MESSAGE', null,
    'Applier module and control agent are separate artifacts with separate identities.',
    variant(capabilities(), m => { delete m.artifacts.module; })],

  // --- session lifecycle -----------------------------------------------------------
  ['session-open-valid.json', 'radio.session.open', 'ACCEPT', null, null,
    'The controller opens a session against expected artifacts and scope; boot and agent identity come back from the phone.',
    {
      ...envelope('radio.session.open', 80),
      identity: { tenantId: identity.tenantId, imageId: identity.imageId, sessionId: SESSION, datasetRevision: identity.datasetRevision },
      expectedArtifacts: { agentApkSha256: AGENT_SHA, agentVersionCode: 1, moduleApkSha256: MODULE_SHA, moduleName: 'duomove-radio' },
      expectedScopeFingerprint: SCOPE,
      simStartWallMs: 1789699999000,
    }],
  ['session-opened-valid.json', 'radio.session.opened', 'ACCEPT', null, null,
    'The only sanctioned bridge between simulation time and phone boot time, plus the dataset pin.',
    {
      ...envelope('radio.session.opened', 81),
      identity,
      clockAnchor: { bootId: BOOT, bootCount: 41, bootIdSource: 'BOOT_COUNT_UUID', simElapsedMs: 0, phoneBootMs: 918100, wallMs: 1789699999120, uncertaintyMs: 120 },
      capabilitiesMessageId: messageId(60),
      scopeFingerprint: SCOPE,
      datasetRevisionPinned: true,
    }],
  ['session-opened-foreign-anchor.json', 'radio.session.opened', 'REJECT', 'MALFORMED_MESSAGE', 'BOOT_MISMATCH',
    'A clock anchor from another boot would let a pre-reboot frame look fresh.',
    {
      ...envelope('radio.session.opened', 82),
      identity,
      clockAnchor: { bootId: 'boot-4410-earlier', bootCount: 40, bootIdSource: 'BOOT_COUNT_UUID', simElapsedMs: 0, phoneBootMs: 918100, wallMs: 1789699999120, uncertaintyMs: 120 },
      capabilitiesMessageId: messageId(60),
      scopeFingerprint: SCOPE,
      datasetRevisionPinned: true,
    }],
  ['session-opened-unpinned-dataset.json', 'radio.session.opened', 'REJECT', 'MALFORMED_MESSAGE', 'DATASET_UNPINNED',
    'Bounded spatial loading means a run must be pinned to the dataset revision it was planned against.',
    {
      ...envelope('radio.session.opened', 87),
      identity,
      clockAnchor: { bootId: BOOT, bootCount: 41, bootIdSource: 'BOOT_COUNT_UUID', simElapsedMs: 0, phoneBootMs: 918100, wallMs: 1789699999120, uncertaintyMs: 120 },
      capabilitiesMessageId: messageId(60),
      scopeFingerprint: SCOPE,
      datasetRevisionPinned: false,
    }],
  ['session-closed-valid.json', 'radio.session.closed', 'ACCEPT', null, null,
    'Cleanup confirmed, with nothing left injected.',
    {
      ...envelope('radio.session.closed', 83), identity, cleanupOk: true, residualState: [], message: null,
    }],
  ['session-closed-residual-state.json', 'radio.session.closed', 'REJECT', 'MALFORMED_MESSAGE', 'CLEANUP_CONFLICT',
    'Confirmed cleanup cannot leave injected state behind.',
    {
      ...envelope('radio.session.closed', 84), identity, cleanupOk: true, residualState: ['BLUETOOTH'],
      message: 'Bluetooth replacement could not be reverted',
    }],
  ['status-unknown-sequence-valid.json', 'radio.status', 'ACCEPT', null, null,
    'Reconciliation after a timeout: an unknown sequence is reported as unknown, not as failed.',
    {
      ...envelope('radio.status', 85), identity, sequence: 47, known: false, result: null,
      nowBootMs: 919400, lastAppliedSequence: 46,
    }],
  ['status-known-without-result.json', 'radio.status', 'REJECT', 'MALFORMED_MESSAGE', 'STATUS_RESULT_MISSING',
    'A known sequence must return the stored result the controller reconciles against.',
    {
      ...envelope('radio.status', 86), identity, sequence: 47, known: true, result: null,
      nowBootMs: 919400, lastAppliedSequence: 47,
    }],
];

mkdirSync(resolve(target, 'fixtures'), { recursive: true });
for (const file of readdirSync(resolve(target, 'fixtures'))) rmSync(resolve(target, 'fixtures', file));

const manifest = {
  protocol: PROTOCOL,
  protocolVersion: VERSION,
  description: 'Shared radio-plugin protocol fixtures. Both the controller and the plugin APK must produce the stated outcome for every case.',
  outcomes: {
    ACCEPT: 'The validator must accept the message.',
    REJECT: 'The validator must refuse the message with the stated code, and with the stated detail when present.',
  },
  cases: [],
};

for (const [file, messageType, expect, code, detail, why, message] of cases) {
  writeFileSync(resolve(target, 'fixtures', file), `${JSON.stringify(message, null, 2)}\n`);
  manifest.cases.push({ file: `fixtures/${file}`, messageType, expect, code, detail, why });
}
writeFileSync(resolve(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`Wrote ${manifest.cases.length} radio contract fixtures to contracts/radio/v1\n`);
