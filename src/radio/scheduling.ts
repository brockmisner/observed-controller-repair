import { LATENCY_BUDGET_MS } from './policy.js';

/**
 * B06. Radio-to-GPS clock arrangement. Recommended default is locally scheduled frames
 * from prepared data, with only arrival and cleanup delivered under the 3.5 s budget.
 * The recommendation is not signed off, so the mode is selected rather than hard-wired.
 */
export const RADIO_SCHEDULE_MODES = ['LOCAL_SCHEDULE', 'DELIVERED'] as const;
export type RadioScheduleMode = (typeof RADIO_SCHEDULE_MODES)[number];

export function radioScheduleMode(env: NodeJS.ProcessEnv = process.env): RadioScheduleMode {
  const raw = env.DUOMOVE_RADIO_SCHEDULE_MODE ?? 'LOCAL_SCHEDULE';
  if (raw === 'LOCAL_SCHEDULE' || raw === 'DELIVERED') return raw;
  throw new Error(`Unsupported radio schedule mode ${JSON.stringify(raw)}; expected LOCAL_SCHEDULE or DELIVERED`);
}

/** True when this frame must travel the delivered path even under LOCAL_SCHEDULE. */
export function requiresBoundedDelivery(phase: 'MOVING' | 'ARRIVED' | 'CLEANUP', mode: RadioScheduleMode): boolean {
  if (mode === 'DELIVERED') return true;
  return phase === 'ARRIVED' || phase === 'CLEANUP';
}

export const DELIVERED_TIMEOUT_MS = LATENCY_BUDGET_MS.deliveredTotal;
