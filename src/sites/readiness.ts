import { HttpError } from '../http/errors.js';

type SiteEnvironment = Record<string, string | undefined>;

export function siteCallbackBase(env: SiteEnvironment = process.env): string {
  try {
    const url = new URL(env.SITE_RESULT_BASE_URL ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new HttpError(409, "Set SITE_RESULT_BASE_URL to this service's public HTTPS origin before running jobs"); }
}

export function siteIssueAt(date: Date, zone = process.env.SITE_RPA_TIMEZONE): string {
  if (!zone) throw new HttpError(409, 'Set SITE_RPA_TIMEZONE to the DuoPlus automation scheduler timezone');
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const value = (type: string) => parts.find((part) => part.type === type)!.value;
    return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`;
  } catch { throw new HttpError(409, 'SITE_RPA_TIMEZONE is not a valid timezone'); }
}

export function siteJobReadiness(env: SiteEnvironment = process.env, dryRun = false) {
  const issues: string[] = [];
  let callbackConfigured = false, schedulerTimezone: string | null = null;
  try { siteCallbackBase(env); callbackConfigured = true; }
  catch (error) { issues.push((error as HttpError).message); }
  try {
    // Pass an explicit empty value so callers using a supplied environment never fall back to process.env.
    siteIssueAt(new Date(), env.SITE_RPA_TIMEZONE ?? '');
    schedulerTimezone = env.SITE_RPA_TIMEZONE!;
  } catch (error) { issues.push((error as HttpError).message); }
  if (dryRun) issues.push('Tracker jobs cannot submit in dry-run mode');
  return { ready: issues.length === 0, callbackConfigured, schedulerTimezone, dryRun, issues };
}

export function assertSiteJobReady(env: SiteEnvironment = process.env, dryRun = false): void {
  const readiness = siteJobReadiness(env, dryRun);
  if (!readiness.ready) throw new HttpError(409, readiness.issues.join('; '));
}
