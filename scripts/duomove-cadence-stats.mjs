// Pure statistics for the on-phone cadence acceptance run (checklist G02).
// Kept free of I/O so the numbers can be unit tested without a phone.

/** Linear-interpolated percentile over a copy of the values. */
export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function summarize(values) {
  if (!values.length) return { count: 0, min: null, median: null, p95: null, max: null, mean: null };
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    min: Math.min(...values),
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
    mean: total / values.length,
  };
}

export function histogram(values, edges) {
  const buckets = edges.map((edge, index) => ({
    from: index === 0 ? -Infinity : edges[index - 1],
    to: edge,
    count: 0,
  }));
  buckets.push({ from: edges.at(-1), to: Infinity, count: 0 });
  for (const value of values) {
    const bucket = buckets.find(candidate => value >= candidate.from && value < candidate.to);
    if (bucket) bucket.count += 1;
  }
  return buckets.map(bucket => ({
    label: `${bucket.from === -Infinity ? '<' : bucket.from}${bucket.from === -Infinity || bucket.to === Infinity ? '' : '..'}${bucket.to === Infinity ? '+' : bucket.to}`,
    from: bucket.from === -Infinity ? null : bucket.from,
    to: bucket.to === Infinity ? null : bucket.to,
    count: bucket.count,
  }));
}

/**
 * Reduce a poll series into one record per applied sample index.
 *
 * Each poll is `{ atMs, rttMs, status }` where `atMs` is the harness monotonic clock and
 * `status` is the raw player response. The application instant is taken from the phone's own
 * `observer_elapsed_nanos`, so the resulting lateness lives in the device boot-relative clock
 * and is not limited by the harness poll rate. The harness clock is retained only to bound
 * measurement resolution.
 */
export function deriveApplications(polls) {
  const startNanos = polls.find(poll => Number(poll.status?.start_elapsed_nanos) > 0)?.status.start_elapsed_nanos;
  const applications = new Map();
  let previousObserverNanos = null;
  for (const poll of polls) {
    const status = poll.status ?? {};
    const seq = Number(status.framework_observed_seq);
    const observerNanos = Number(status.observer_elapsed_nanos);
    if (!Number.isInteger(seq) || seq < 0 || !Number.isFinite(observerNanos) || observerNanos <= 0) continue;
    // A repeated observer timestamp is the same measurement seen by a later poll, not a new one.
    if (observerNanos === previousObserverNanos) continue;
    previousObserverNanos = observerNanos;
    if (!applications.has(seq)) {
      applications.set(seq, { seq, observerElapsedNanos: observerNanos, firstSeenAtMs: poll.atMs, rttMs: poll.rttMs });
    }
  }
  return {
    startElapsedNanos: Number(startNanos) || null,
    applications: [...applications.values()].sort((a, b) => a.seq - b.seq),
  };
}

/**
 * Build the G02 figures.
 *
 * `plannedIntervalMs` and `startDelayMs` are the player's own contract (1 Hz plan, 500 ms delay
 * before the first sample). `phases` optionally labels index ranges so lateness can be reported
 * for acceleration, the turn, the stop and the dwell separately.
 */
export function cadenceReport(polls, options = {}) {
  const plannedIntervalMs = options.plannedIntervalMs ?? 1000;
  const startDelayMs = options.startDelayMs ?? 500;
  const expectedSamples = options.expectedSamples ?? null;
  const phases = options.phases ?? [];

  const { startElapsedNanos, applications } = deriveApplications(polls);
  const intervals = [];
  const absoluteLateness = [];
  const relativeLateness = [];
  const perSample = [];

  const firstDeviceMs = applications.length ? applications[0].observerElapsedNanos / 1e6 : null;
  for (let index = 0; index < applications.length; index++) {
    const application = applications[index];
    const deviceMs = application.observerElapsedNanos / 1e6;
    const previous = applications[index - 1];
    const intervalMs = previous ? deviceMs - previous.observerElapsedNanos / 1e6 : null;
    const scheduledFromStartMs = startElapsedNanos === null
      ? null : startDelayMs + application.seq * plannedIntervalMs;
    const absoluteMs = scheduledFromStartMs === null
      ? null : deviceMs - startElapsedNanos / 1e6 - scheduledFromStartMs;
    const relativeMs = deviceMs - firstDeviceMs - (application.seq - applications[0].seq) * plannedIntervalMs;
    if (intervalMs !== null && previous.seq === application.seq - 1) intervals.push(intervalMs);
    if (absoluteMs !== null) absoluteLateness.push(absoluteMs);
    relativeLateness.push(relativeMs);
    perSample.push({
      seq: application.seq,
      deviceElapsedMs: deviceMs,
      intervalMs,
      absoluteLatenessMs: absoluteMs,
      relativeLatenessMs: relativeMs,
      phase: phases.find(phase => application.seq >= phase.fromSeq && application.seq <= phase.toSeq)?.name ?? null,
    });
  }

  const observedSeqs = new Set(applications.map(application => application.seq));
  const highestSeq = applications.length ? applications.at(-1).seq : -1;
  const unobserved = [];
  for (let seq = applications.length ? applications[0].seq : 0; seq <= highestSeq; seq++) {
    if (!observedSeqs.has(seq)) unobserved.push(seq);
  }

  const last = polls.at(-1)?.status ?? {};
  const pollGaps = polls.slice(1).map((poll, index) => poll.atMs - polls[index].atMs);
  const rtts = polls.map(poll => poll.rttMs).filter(value => Number.isFinite(value));

  const phaseBreakdown = phases.map(phase => {
    const inPhase = perSample.filter(sample => sample.phase === phase.name);
    return {
      name: phase.name,
      fromSeq: phase.fromSeq,
      toSeq: phase.toSeq,
      samplesObserved: inPhase.length,
      intervalMs: summarize(inPhase.map(sample => sample.intervalMs).filter(Number.isFinite)),
      relativeLatenessMs: summarize(inPhase.map(sample => sample.relativeLatenessMs).filter(Number.isFinite)),
    };
  });

  return {
    clockDomain: 'device boot-relative (SystemClock.elapsedRealtimeNanos), from the player observer',
    startElapsedNanos,
    plannedIntervalMs,
    startDelayMs,
    expectedSamples,
    samplesObserved: applications.length,
    unobservedSeqs: unobserved,
    lateness: {
      absoluteMs: summarize(absoluteLateness),
      relativeToFirstSampleMs: summarize(relativeLateness),
      deviceReportedMaxMs: Number.isFinite(Number(last.max_lateness_ms)) ? Number(last.max_lateness_ms) : null,
    },
    intervalMs: summarize(intervals),
    intervalHistogramMs: histogram(intervals, [900, 950, 990, 1010, 1050, 1100, 1250, 1500, 2500]),
    deviceCounters: {
      appliedSeq: Number.isInteger(Number(last.applied_seq)) ? Number(last.applied_seq) : null,
      skippedSamples: Number.isInteger(Number(last.skipped_samples)) ? Number(last.skipped_samples) : null,
      observerMismatches: Number.isInteger(Number(last.observer_mismatches)) ? Number(last.observer_mismatches) : null,
      frameworkObservedSeq: Number.isInteger(Number(last.framework_observed_seq)) ? Number(last.framework_observed_seq) : null,
      fusedObservedSeq: Number.isInteger(Number(last.fused_observed_seq)) ? Number(last.fused_observed_seq) : null,
      delivery: typeof last.delivery === 'string' ? last.delivery : null,
      observerScope: typeof last.observer_scope === 'string' ? last.observer_scope : null,
      state: typeof last.state === 'string' ? last.state : null,
      cleanupOk: typeof last.cleanup_ok === 'boolean' ? last.cleanup_ok : null,
      error: last.error || null,
    },
    observerLagSeq: summarize(polls
      .map(poll => Number(poll.status?.applied_seq) - Number(poll.status?.framework_observed_seq))
      .filter(Number.isFinite)),
    measurement: {
      pollGapMs: summarize(pollGaps),
      requestRoundTripMs: summarize(rtts),
      note: 'Application instants are timestamped on the phone, so poll gap bounds only whether an index was caught, not the lateness precision. Lateness additionally carries the in-process observer callback delay, which is bounded by comparing absolute lateness against the phone-reported max_lateness_ms.',
    },
    perSample,
    phaseBreakdown,
  };
}
