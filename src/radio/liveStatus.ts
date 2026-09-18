import { describeAges, EVIDENCE_CLAIM, LATENCY_BUDGET_MS, type AgeReport, type ComparisonResult } from './policy.js';
import type { PlayerReadiness, PlayerReadinessCode } from '../trips/playerReadiness.js';
import type { ArrivalLifecycleTick, BluetoothIntent } from './lifecycle.js';
import type { TripRadioRuntime } from './runtime.js';

/**
 * F01/F03. Live per-phone radio status for the operator UI.
 * Requested (model), applied (plugin write) and observed (independent collector) stay separate.
 * The radio APK is not in this delivery, so observed is NEVER invented from a stub or local frame.
 */

export const RADIO_READINESS_CODES = [
  'TRANSPORT_UNREACHABLE',
  'WRONG_BUILD',
  'DATASET_INVALID',
  'PLUGIN_MISSING',
  'INTERFACE_UNSUPPORTED',
  'READY',
] as const;
export type RadioReadinessCode = (typeof RADIO_READINESS_CODES)[number];

export const OPERATOR_RADIO_STATES = [
  'IDLE', 'PROGRESSING', 'STALE', 'BLOCKED', 'MISMATCHED', 'UNCERTAIN',
] as const;
export type OperatorRadioState = (typeof OPERATOR_RADIO_STATES)[number];

export const OBSERVED_AVAILABILITY = ['NOT_OBSERVED', 'UNSUPPORTED_IN_SCOPE'] as const;
export type ObservedAvailability = (typeof OBSERVED_AVAILABILITY)[number];

const UNREACHABLE_PLAYER: PlayerReadinessCode[] = [
  'NOT_CONFIGURED', 'MISCONFIGURED', 'ENDPOINT_CHANGED', 'UNREACHABLE', 'STARTING', 'UNAUTHENTICATED',
];

export interface LiveRadioSessionSummary {
  sessionId: string;
  bootId: string;
  instanceId: string;
  tripId: string;
  datasetRevision: string;
  lastRequestedSequence: number | null;
  lastAppliedSequence: number | null;
  lastObservedSequence: number | null;
  lastServing: string | null;
  lastHandover: { from: string | null; to: string | null } | null;
  bluetoothAction: BluetoothIntent | 'HOLD' | 'REPLACE' | 'CLEAR';
  uncertain: boolean;
  lifecycle: string | null;
  detail: string;
  simElapsedMs: number | null;
  tickWallMs: number | null;
  source: 'PLUGIN' | 'STUB_RECEIVER' | 'LOCAL_PREPARE' | 'CONTROLLER';
  applied: boolean;
  scanAges: AgeReport[];
}

export interface LiveRadioInputs {
  imageId: string;
  deviceId: string;
  mcc: string;
  mnc: string;
  nowMs: number;
  trip: { id: string; status: string } | null;
  dataset: { revision: string | null; recordsPresent: boolean };
  playerReadiness: Pick<PlayerReadiness, 'code' | 'ready' | 'detail' | 'checkedAt' | 'endpoint'> | null;
  verification: {
    outcome: string;
    checkedAt: string;
    installed: { matchesUploadedApk: boolean; packageName: string } | null;
    radios: { wifi: string; cell: string; bluetooth: string };
  } | null;
  session: LiveRadioSessionSummary | null;
  arrival?: Pick<ArrivalLifecycleTick, 'stage' | 'gateReason' | 'bluetoothIntent' | 'uncertain' | 'detail'> | null;
  comparison?: Pick<ComparisonResult, 'overall' | 'role' | 'claim' | 'scopeLimited'> | null;
  radioPluginPresent?: boolean;
  unsupportedInterfaces?: readonly string[];
}

export interface LiveRadioLane {
  sequence: number | null;
  atMs: number | null;
  source: string;
  detail: string;
}

export interface LiveRadioStatus {
  phone: { imageId: string; deviceId: string; sessionId: string | null; bootId: string | null; instanceId: string | null; tripId: string | null };
  operator: { code: OperatorRadioState; label: string; tone: 'good' | 'warn' | 'bad' | 'neutral'; detail: string };
  requested: LiveRadioLane & { servingCell: string | null; simElapsedMs: number | null };
  applied: LiveRadioLane & { applied: boolean; uncertain: boolean; lifecycle: string | null };
  observed: LiveRadioLane & {
    availability: ObservedAvailability;
    overall: ComparisonResult['overall'] | null;
    role: ComparisonResult['role'] | null;
    claim: string;
  };
  carrier: { requestedMcc: string; requestedMnc: string; servingCellRequested: string | null; servingCellObserved: ObservedAvailability; handover: LiveRadioSessionSummary['lastHandover'] };
  scanAge: Array<AgeReport & { label: string }>;
  bluetooth: { intent: BluetoothIntent | 'HOLD' | 'REPLACE' | 'CLEAR'; observed: ObservedAvailability; detail: string };
  failure: { uncertain: boolean; blocked: boolean; detail: string | null };
  readiness: { code: RadioReadinessCode; label: string; tone: 'good' | 'warn' | 'bad' | 'neutral'; detail: string; checkedAt: string | null };
  display: { pollIntervalMs: number; interpolation: 'PRESENTATION_ONLY'; note: string };
}

const transportCodes = new Set<PlayerReadinessCode>(UNREACHABLE_PLAYER);

function lane(sequence: number | null, atMs: number | null, source: string, detail: string): LiveRadioLane {
  return { sequence, atMs, source, detail };
}

function realApplication(session: LiveRadioSessionSummary | null): boolean {
  return Boolean(session && session.source === 'PLUGIN' && session.applied === true);
}

export function sessionSummaryFromRuntime(runtime: TripRadioRuntime): LiveRadioSessionSummary {
  const identity = runtime.identity();
  const tick = runtime.lastAccepted();
  const apply = tick?.apply ?? null;
  return {
    sessionId: runtime.sessionId,
    bootId: identity.bootId,
    instanceId: identity.instanceId,
    tripId: identity.tripId,
    datasetRevision: identity.datasetRevision,
    lastRequestedSequence: tick?.sequence ?? null,
    lastAppliedSequence: tick?.applied ? tick.sequence : null,
    lastObservedSequence: null,
    lastServing: runtime.summary().lastServing,
    lastHandover: tick?.frame?.handover ?? null,
    bluetoothAction: (apply?.bluetooth.directive ?? tick?.frame?.bluetoothAction ?? 'HOLD') as LiveRadioSessionSummary['bluetoothAction'],
    uncertain: tick?.uncertain ?? false,
    lifecycle: tick?.evidence.lifecycle ?? null,
    detail: tick?.evidence.detail ?? 'No radio frame has been requested yet',
    simElapsedMs: tick?.frame?.elapsedMs ?? apply?.simElapsedMs ?? null,
    tickWallMs: apply?.sentAtWallMs ?? null,
    source: identity.source,
    applied: tick?.applied ?? false,
    scanAges: apply ? describeAges(apply) : [],
  };
}

function scanLabels(ages: AgeReport[]): Array<AgeReport & { label: string }> {
  return ages.map((age) => {
    if (age.held) return { ...age, label: `${age.interface} HOLD; no model sample this frame` };
    const freshness = age.freshness ?? 'UNKNOWN';
    return {
      ...age,
      label: `${age.interface} model cache age ${age.ageMs} ms (${freshness}); not an Android scan timestamp`,
    };
  });
}

function liveTrip(status: string | undefined): boolean {
  return status === 'RUNNING' || status === 'ARRIVING' || status === 'PAUSED';
}

function readinessOf(input: LiveRadioInputs): LiveRadioStatus['readiness'] {
  const checkedAt = input.playerReadiness?.checkedAt ?? input.verification?.checkedAt ?? null;
  if (input.playerReadiness && transportCodes.has(input.playerReadiness.code)) {
    return {
      code: 'TRANSPORT_UNREACHABLE', label: 'Unreachable transport', tone: 'warn',
      detail: input.playerReadiness.detail, checkedAt,
    };
  }
  if (input.verification?.installed && input.verification.installed.matchesUploadedApk === false) {
    return {
      code: 'WRONG_BUILD', label: 'Wrong build', tone: 'bad',
      detail: `${input.verification.installed.packageName} does not match the uploaded GPS player. The radio agent APK is a separate artifact and is not this package.`,
      checkedAt: input.verification.checkedAt,
    };
  }
  if (!/^\d{3}$/.test(input.mcc) || !/^\d{2,3}$/.test(input.mnc) || !input.dataset.recordsPresent) {
    return {
      code: 'DATASET_INVALID', label: 'Invalid dataset', tone: 'warn',
      detail: !input.dataset.recordsPresent
        ? 'No campaign city radio records are pinned for this phone.'
        : `Configured MCC/MNC ${input.mcc}/${input.mnc} is not a usable carrier identity.`,
      checkedAt: input.dataset.revision ? checkedAt : null,
    };
  }
  if (!input.radioPluginPresent) {
    return {
      code: 'PLUGIN_MISSING', label: 'Radio plugin missing', tone: 'warn',
      detail: 'The radio agent APK is not in this delivery. The GPS player is not the radio plugin; observed radio stays NOT_OBSERVED.',
      checkedAt,
    };
  }
  const unsupported = input.unsupportedInterfaces ?? [];
  if (unsupported.length) {
    return {
      code: 'INTERFACE_UNSUPPORTED', label: 'Unsupported interface', tone: 'warn',
      detail: `${unsupported.join(', ')} is UNSUPPORTED_IN_SCOPE for this build. That is not a readback mismatch.`,
      checkedAt,
    };
  }
  return { code: 'READY', label: 'Radio ready', tone: 'good', detail: 'Radio plugin and dataset are present.', checkedAt };
}

function operatorOf(input: LiveRadioInputs, readiness: LiveRadioStatus['readiness'], session: LiveRadioSessionSummary | null): LiveRadioStatus['operator'] {
  const comparison = input.comparison;
  if (comparison && (comparison.overall === 'MISMATCH' || comparison.overall === 'SCOPE_LEAK')) {
    return {
      code: 'MISMATCHED', label: comparison.overall === 'SCOPE_LEAK' ? 'Scope leak' : 'Mismatched',
      tone: 'bad',
      detail: comparison.overall === 'SCOPE_LEAK'
        ? 'SCOPE_LEAK: an out-of-scope observer saw injected values.'
        : 'Observed identities do not match the requested in-scope frame.',
    };
  }
  const blocked = input.arrival?.stage === 'BLOCKED' || readiness.code === 'TRANSPORT_UNREACHABLE';
  if (blocked) {
    return {
      code: 'BLOCKED', label: 'Blocked', tone: 'warn',
      detail: input.arrival?.gateReason ? `Arrival blocked: ${input.arrival.gateReason}` : readiness.detail,
    };
  }
  if (session?.uncertain || input.arrival?.uncertain) {
    return {
      code: 'UNCERTAIN', label: 'Uncertain application', tone: 'warn',
      detail: session?.detail || input.arrival?.detail || 'Application is not assumed after a lost or timed-out result.',
    };
  }
  if (session && liveTrip(input.trip?.status) && session.tickWallMs != null
      && input.nowMs - session.tickWallMs > LATENCY_BUDGET_MS.operatorVisibleWorstCase) {
    return {
      code: 'STALE', label: 'Stale', tone: 'warn',
      detail: `Last requested radio frame is older than ${LATENCY_BUDGET_MS.operatorVisibleWorstCase} ms. Browser poll is ${LATENCY_BUDGET_MS.uiSnapshotPollInterval} ms and is not a one-second feed.`,
    };
  }
  if (session && (input.trip?.status === 'RUNNING' || input.trip?.status === 'ARRIVING') && session.lastRequestedSequence != null) {
    return {
      code: 'PROGRESSING', label: 'Progressing', tone: 'neutral',
      detail: `Requested sequence ${session.lastRequestedSequence} under session ${session.sessionId}. Applied and observed remain separate.`,
    };
  }
  return {
    code: 'IDLE', label: 'No live radio session', tone: 'neutral',
    detail: 'No in-memory radio session is advancing for this phone.',
  };
}

export function projectLiveRadioStatus(input: LiveRadioInputs): LiveRadioStatus {
  const session = input.session;
  const pluginWrite = realApplication(session);
  const readiness = readinessOf(input);
  const operator = operatorOf(input, readiness, session);
  const comparison = input.comparison && input.radioPluginPresent ? input.comparison : null;
  const observedAvailability: ObservedAvailability = 'NOT_OBSERVED';
  const observedClaim = comparison?.claim
    ?? (comparison?.role === 'OUT_OF_SCOPE_CONTROL' ? EVIDENCE_CLAIM.OUT_OF_SCOPE_CONTROL : EVIDENCE_CLAIM.IN_SCOPE_VERIFICATION);
  const noObservation = 'No independent radio collector has reported. Observed stays NOT_OBSERVED until a radio APK exists. Model frames are not observations.';

  const appliedDetail = !session
    ? 'Nothing has been applied.'
    : session.source !== 'PLUGIN'
      ? `${session.detail}. Stub or local-prepare results are not evidence of real application.`
      : pluginWrite
        ? session.detail
        : session.detail;

  return {
    phone: {
      imageId: input.imageId,
      deviceId: input.deviceId,
      sessionId: session?.sessionId ?? null,
      bootId: session?.bootId ?? null,
      instanceId: session?.instanceId ?? null,
      tripId: session?.tripId ?? input.trip?.id ?? null,
    },
    operator,
    requested: {
      ...lane(session?.lastRequestedSequence ?? null, session?.tickWallMs ?? null, 'MODEL_FRAME', session?.detail ?? 'No radio frame has been requested.'),
      servingCell: session?.lastServing ?? null,
      simElapsedMs: session?.simElapsedMs ?? null,
    },
    applied: {
      ...lane(pluginWrite ? session!.lastAppliedSequence : null, pluginWrite ? session!.tickWallMs : null, session?.source === 'PLUGIN' ? 'PLUGIN_WRITE' : 'NOT_APPLIED', appliedDetail),
      applied: pluginWrite,
      uncertain: session?.uncertain ?? false,
      lifecycle: session?.lifecycle ?? null,
    },
    observed: {
      ...lane(null, null, 'INDEPENDENT_COLLECTOR', comparison && input.radioPluginPresent ? comparison.claim : noObservation),
      availability: observedAvailability,
      overall: comparison && input.radioPluginPresent ? comparison.overall : null,
      role: comparison && input.radioPluginPresent ? comparison.role : null,
      claim: comparison && input.radioPluginPresent
        ? observedClaim
        : `${EVIDENCE_CLAIM.IN_SCOPE_VERIFICATION} No collector is present, so INJECTION_FIDELITY is unproven. OUT_OF_SCOPE_CONFIRMED and SCOPE_LEAK cannot be decided.`,
    },
    carrier: {
      requestedMcc: input.mcc,
      requestedMnc: input.mnc,
      servingCellRequested: session?.lastServing ?? null,
      servingCellObserved: 'NOT_OBSERVED',
      handover: session?.lastHandover ?? null,
    },
    scanAge: scanLabels(session?.scanAges ?? []),
    bluetooth: {
      intent: input.arrival?.bluetoothIntent ?? session?.bluetoothAction ?? 'HOLD',
      observed: 'NOT_OBSERVED',
      detail: 'Bluetooth REPLACE is an intended arrival action until an independent collector reports it.',
    },
    failure: {
      uncertain: Boolean(session?.uncertain || input.arrival?.uncertain),
      blocked: operator.code === 'BLOCKED',
      detail: operator.code === 'BLOCKED' || operator.code === 'UNCERTAIN' ? operator.detail : session?.lifecycle === 'REJECTED' || session?.lifecycle === 'UNREACHABLE' ? session.detail : null,
    },
    readiness,
    display: {
      pollIntervalMs: LATENCY_BUDGET_MS.uiSnapshotPollInterval,
      interpolation: 'PRESENTATION_ONLY',
      note: `Visible snapshots poll every ${LATENCY_BUDGET_MS.uiSnapshotPollInterval / 1000} s. Marker motion between polls is presentation, not new phone evidence. One-second player playback is not a one-second browser feed.`,
    },
  };
}

export function liveStatusFromRuntime(options: Omit<LiveRadioInputs, 'session'> & { runtime: TripRadioRuntime | null }): LiveRadioStatus {
  const { runtime, ...rest } = options;
  return projectLiveRadioStatus({ ...rest, session: runtime ? sessionSummaryFromRuntime(runtime) : null });
}
