/**
 * C04. After arrival and radio cleanup, the phone's durable location is the drive destination
 * by default. The campaign anchor stays a planning reference, not a restoration target.
 * The policy is selectable because it still needs sign-off.
 */
export const DESTINATION_POLICIES = ['HOLD_DESTINATION', 'RETURN_TO_ANCHOR', 'RESTORE_PROVIDERS'] as const;
export type DestinationPolicy = (typeof DESTINATION_POLICIES)[number];
export const DEFAULT_DESTINATION_POLICY: DestinationPolicy = 'HOLD_DESTINATION';

export function destinationPolicy(env: NodeJS.ProcessEnv = process.env): DestinationPolicy {
  const raw = env.DUOMOVE_DESTINATION_POLICY ?? DEFAULT_DESTINATION_POLICY;
  if (raw === 'HOLD_DESTINATION' || raw === 'RETURN_TO_ANCHOR' || raw === 'RESTORE_PROVIDERS') return raw;
  throw new Error(`Unsupported destination policy ${JSON.stringify(raw)}; expected ${DESTINATION_POLICIES.join(', ')}`);
}

export function durableLocationAfterTrip(
  policy: DestinationPolicy,
  destination: { lat: number; lng: number },
  anchor: { lat: number; lng: number },
): { lat: number; lng: number; source: 'DESTINATION' | 'ANCHOR'; restoreProviders: boolean } {
  if (policy === 'RETURN_TO_ANCHOR') {
    return { lat: anchor.lat, lng: anchor.lng, source: 'ANCHOR', restoreProviders: false };
  }
  return {
    lat: destination.lat, lng: destination.lng, source: 'DESTINATION',
    restoreProviders: policy === 'RESTORE_PROVIDERS',
  };
}
