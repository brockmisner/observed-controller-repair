const windowMs = 60_000;
const calls: Array<{ t: number; tenantId?: string }> = [];

export function noteDuoPlusCall(_path: string, tenantId?: string): void {
  const t = Date.now();
  calls.push({ t, tenantId });
  const cut = t - windowMs;
  while (calls[0] && calls[0].t < cut) calls.shift();
}

export function qpsSnapshot(tenantId?: string, cap = 1): {
  callsLastMinute: number;
  qps: number;
  cap: number;
  hot: boolean;
  series: number[];
} {
  const now = Date.now();
  while (calls[0] && calls[0].t < now - windowMs) calls.shift();
  const stamps = calls.filter((call) => !tenantId || call.tenantId === tenantId).map((call) => call.t);
  const series = Array.from({ length: 12 }, (_, i) => {
    const start = now - (12 - i) * 5_000;
    const end = start + 5_000;
    return stamps.filter((t) => t >= start && t < end).length / 5;
  });
  const callsLastMinute = stamps.length;
  const qps = callsLastMinute / 60;
  return { callsLastMinute, qps: Number(qps.toFixed(3)), cap, hot: qps >= cap * 0.75, series };
}
