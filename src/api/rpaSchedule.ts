import { siteIssueAt } from '../sites/readiness.js';

export function defaultRpaIssueAt(now = new Date(), schedulerTimezone = process.env.SITE_RPA_TIMEZONE): string {
  // At least one full minute remains after formatting to the provider's minute precision.
  return siteIssueAt(new Date((Math.floor(now.getTime() / 60_000) + 2) * 60_000), schedulerTimezone ?? '');
}
