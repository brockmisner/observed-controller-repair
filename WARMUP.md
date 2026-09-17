# Observatory profile warmup

Warmup lives in the existing Observatory Controller Railway service. It prepares existing DuoPlus images; it does not perform rank tracking or capture ingestion.

## Set up a campaign

1. Open **Warmup → Add city**. Set the area center, radius, and IANA timezone.
2. Optionally import a saved WiGLE upload or normalized JSON. The city dataset is shared only within the workspace; record source dates are preserved. Records outside the city radius are excluded. There are no per-tick WiGLE requests.
3. Choose **New campaign**. Assign a registered phone, client folder, city, fixed anchor, start date and duration (3–730 days). A synced DuoPlus folder can be linked when the phone is actually a member. The client folder is a controller label; this does not move the phone between DuoPlus folders.
4. Load DuoPlus templates or enter template IDs. Add up to 12 daily tasks with local time, applicable day range, expected duration, and JSON variables. Choose templates that preserve accounts and app data. Template bodies are administered in DuoPlus and are not rewritten or certified by this controller.
5. Set **DuoPlus scheduler timezone** to the timezone used by the provider account. This is independent of the phone's local campaign timezone.
6. Save the draft and **Start campaign**. Automatic startup/shutdown is opt-in. With it off, tasks wait for a freshly confirmed ON phone. With it on, the planner checks unexpired free subscription slots; it only automatically stops phones whose startup it confirmed.

Variable placeholders: `{{day}}`, `{{city}}`, `{{latitude}}`, `{{longitude}}`, and `{{imageId}}`. Values may be strings, finite numbers, or booleans. Account passwords and authentication material should stay on the phone, not in task variables.

## What is preserved

A campaign holds a unique reservation on the existing DuoPlus image. It does not clone, reset, replace, clear app data, inject cookies, or change SIM identifiers. The Wi-Fi hardware MAC is checked for continuity; user-selected RPA templates remain responsible for their own actions. Browser accounts and cookies are not exported to the server. This preserves existing state; it cannot prevent an app from expiring a session or externally administered templates from clearing data.

While the campaign owns the phone, legacy navigation, profile editing, independent client jobs, and legacy RPA dispatch are blocked. Pause blocks new warmup submissions. It does not pretend that an already scheduled provider task has stopped. History continues reconciling until the provider reports the result. To interrupt an in-flight task, cancel it in DuoPlus; the next task-list poll records cancellation. An uncertain task can be resolved with an explicit operator confirmation that it stopped. No uncertain task is replayed automatically.

## Geographic settings

Before each submission, the controller confirms power and checks the provider's GPS configuration against the campaign anchor. When necessary, it applies the anchor once and waits for readback. It avoids the per-point REST update loop used by the old driving engine. Existing DuoMove drive support and APK remain installed; campaign scheduling does not require a new APK.

Wi-Fi modes:
- **Preserve:** do not change the Wi-Fi profile.
- **City:** select an eligible historical Wi-Fi observation within 120 m of the anchor, preserve the phone MAC, apply supported Wi-Fi fields, and confirm provider readback. Pin that AP for campaign continuity; dataset imports do not silently rotate it.

Provider configuration readback is not an Android scan or an on-screen app observation. Cell and Bluetooth observations are retained as geographic reference data. Android radio scan/cell/Bluetooth playback is not implemented. The campaign does not change proxy, timezone, or SIM settings; use matching phone/proxy settings in DuoPlus. Campaign timezone governs scheduling, not Android's operating-system timezone.

## Scheduling and history

The database stores campaign configuration, a rolling seven-day task window, execution evidence, and activity events. Local calendar dates determine campaign days. DST fall-back runs once at the earlier occurrence; nonexistent spring-forward times advance to the first valid local minute. A task that misses its daily window is marked MISSED instead of replayed in a burst. Pause does not extend the calendar; use Extend to add time.

A 200 response from `addTask` is only acceptance. The planner polls `taskList` using a unique immutable submission name and subsequently the exact task ID. Status 3 is recorded as provider-reported success, not Google trust or independently observed browsing. A transport failure after send remains UNCONFIRMED and reserves the phone. Confirmed failed/cancelled tasks may be explicitly retried within their original daily window; previous evidence is retained in activity history.

After the last calendar day, the campaign becomes COMPLETED with its success/missed/failure counts. Completion of the period does not mean every task succeeded. The dashboard shows the latest scheduler scan separately from task outcomes.

SQLite uses the existing `/app/data` volume and additive Prisma schema changes. PostgreSQL has an additive migration. Keep one controller replica for SQLite. The physical-device Redis lease and database image reservation protect dispatch identity. Reconciliation and campaign state survive restarts.

## Verification

- `npm test`: unit and existing driving regression tests.
- `npm run test:warmup`: temporary SQLite database lifecycle tests with stubbed provider I/O; no real phones are touched.
- `npm run build`: TypeScript compilation.

Provider documentation: [Create scheduled task](https://help.duoplus.net/docs/Create-Scheduled-Task), [Task list and execution statuses](https://help.duoplus.net/docs/scheduled-task-list), [Subscription Startup inventory](https://help.duoplus.net/docs/Subscription-Startup-List).
