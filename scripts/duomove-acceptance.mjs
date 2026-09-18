#!/usr/bin/env node
// On-phone acceptance harness for checklist G01, G02 and the G03 readback attempt, plus the
// image probe from docs/radio-apk-build-brief.md §11.
//
// One run produces one JSON evidence file and one Markdown summary. It is read-only against the
// phone apart from the drive itself: it never installs, uninstalls, clears data, writes settings,
// force-stops a package, provisions a token or reboots. Every shell command is a fixed literal
// and is checked against a denylist before it runs.
//
//   node scripts/duomove-acceptance.mjs --endpoint <ipv4:port> --out ./evidence
//   node scripts/duomove-acceptance.mjs --endpoint <ipv4:port> --probe-only
//   node scripts/duomove-acceptance.mjs --direct-port 19999 --token-file tok  # harness self-test
//
// Run it from a host whose egress the phone/provider already accepts. See
// docs/onphone-test-report.md for why that currently means the deployed controller.
import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { cadenceReport } from './duomove-cadence-stats.mjs';
import { readApkSigners, hasV1Signature } from './duomove-apk-signer.mjs';
import { PROBES, probeVerdicts } from './duomove-image-probe.mjs';

const exec = promisify(execFile);
const PACKAGE = 'net.stakeout.duomove.player';
const PINNED_APK_SHA256 = '620d7714280e98048a16d7fcd0320fed3d8925c7377997eadad4b99adfcd5dbf';
const PLAYER_CONTROL_PORT = 9999;
const CHUNK_BYTES = 48_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
// Anything that could change installed software, stored profile state or device settings.
const FORBIDDEN = /\b(install|uninstall|clear|reboot|force-stop|svc\s|settings\s+put|content\s+insert|input\s|rm\s|mv\s|dd\s|pm\s+grant|appops\s+set|dplus\s+(install|uninstall))\b/;

function options() {
  const argv = process.argv.slice(2);
  const value = name => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const flag = name => argv.includes(`--${name}`);
  return {
    endpoint: value('endpoint') ?? process.env.ADB_PREFLIGHT_ENDPOINT ?? '',
    directPort: value('direct-port') ? Number(value('direct-port')) : null,
    tokenFile: value('token-file') ?? null,
    pollMs: Number(value('poll-ms') ?? 150),
    out: value('out') ?? `./duomove-acceptance-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    planFile: value('plan') ?? null,
    origin: value('origin') ?? null,
    probeOnly: flag('probe-only'),
    skipProbe: flag('skip-probe'),
    pullApk: !flag('no-pull-apk'),
    imageId: value('image-id') ?? process.env.DUOMOVE_IMAGE_ID ?? null,
  };
}

const log = (...parts) => console.error(`[${new Date().toISOString()}]`, ...parts);

function requireEndpoint(endpoint) {
  const [host, port, extra] = endpoint.split(':');
  if (extra || isIP(host ?? '') !== 4 || !/^\d+$/.test(port ?? '') || +port < 1 || +port > 65535) {
    throw new Error('--endpoint must be <IPv4>:<port>, matching ADB_PREFLIGHT_ENDPOINT');
  }
  return endpoint;
}

async function adb(args, timeout = 15_000) {
  const joined = args.join(' ');
  if (FORBIDDEN.test(joined)) throw new Error(`Refusing a state-changing command: ${joined}`);
  const { stdout, stderr } = await exec('adb', args, { timeout, maxBuffer: 4 * 1024 * 1024 });
  return { stdout: stdout ?? '', stderr: stderr ?? '' };
}

/** Records every probe with the exact command, so the report can be re-derived. */
async function shell(endpoint, command, { timeout = 15_000, limit = 8000 } = {}) {
  if (FORBIDDEN.test(command)) throw new Error(`Refusing a state-changing shell command: ${command}`);
  const started = Date.now();
  try {
    const { stdout, stderr } = await adb(['-s', endpoint, 'shell', command], timeout);
    const output = `${stdout}${stderr}`.trim();
    return { command, ok: true, durationMs: Date.now() - started, truncated: output.length > limit, output: output.slice(0, limit) };
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    return { command, ok: false, durationMs: Date.now() - started, failure: error.killed ? 'TIMEOUT' : (error.code ?? 'FAILED'), output: output.slice(0, limit) };
  }
}

// ---------------------------------------------------------------- player control socket

class Player {
  #socket; #buffer = Buffer.alloc(0); #pending; #instance;

  constructor(socket) {
    this.#socket = socket;
    socket.setNoDelay(true);
    socket.on('data', chunk => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      const end = this.#buffer.indexOf(10);
      if (end < 0) return;
      const line = this.#buffer.subarray(0, end).toString('utf8');
      this.#buffer = this.#buffer.subarray(end + 1);
      const pending = this.#pending;
      if (!pending) return;
      try {
        const status = JSON.parse(line);
        if (status.id !== pending.id) throw new Error('response id mismatch');
        if (this.#instance && status.instance_id && this.#instance !== status.instance_id) {
          throw new Error('player process restarted mid-run');
        }
        if (status.instance_id) this.#instance = status.instance_id;
        clearTimeout(pending.timer);
        this.#pending = undefined;
        pending.resolve({ status, rttMs: Number(process.hrtime.bigint() - pending.sentAt) / 1e6 });
      } catch (error) {
        clearTimeout(pending.timer);
        this.#pending = undefined;
        pending.reject(error instanceof Error ? error : new Error('invalid player response'));
      }
    });
    socket.on('error', error => this.#fail(error.message));
    socket.on('close', () => this.#fail('player connection closed'));
  }

  get instanceId() { return this.#instance; }

  #fail(message) {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
  }

  request(body) {
    if (this.#pending) return Promise.reject(new Error('a player request is already in flight'));
    const id = randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail('player command timed out'), 7000);
      this.#pending = { id, resolve, reject, timer, sentAt: process.hrtime.bigint() };
      this.#socket.write(`${JSON.stringify({ ...body, id })}\n`);
    });
  }

  async status() { return this.request({ op: 'status' }); }
  close() { this.#socket.destroy(); }

  static async connect(port, token) {
    const socket = await new Promise((resolve, reject) => {
      const candidate = createConnection({ host: '127.0.0.1', port });
      candidate.once('connect', () => resolve(candidate));
      candidate.once('error', reject);
    });
    const player = new Player(socket);
    try {
      await player.request({ op: 'auth', token, version: 1 });
      return player;
    } catch (error) {
      player.close();
      throw error;
    }
  }
}

// ---------------------------------------------------------------- evidence collection

async function installedIdentity(endpoint, { pullApk }) {
  const path = await shell(endpoint, `pm path ${PACKAGE}`);
  const apkPath = /^package:(\/data\/app\/[A-Za-z0-9_~+=./-]+\/base\.apk)$/m.exec(path.output ?? '')?.[1] ?? null;
  const dump = apkPath ? await shell(endpoint, `dumpsys package ${PACKAGE}`, { limit: 20_000 }) : null;
  const checksum = apkPath ? await shell(endpoint, `sha256sum ${apkPath}`) : null;
  const onDeviceSha256 = /^([a-f0-9]{64})\s/i.exec(checksum?.output ?? '')?.[1]?.toLowerCase() ?? null;
  const field = pattern => pattern.exec(dump?.output ?? '')?.[1]?.trim() ?? null;

  let pulled = null;
  if (pullApk && apkPath) {
    // Copying the installed APK out is read-only; it is how the signer digest is established
    // without depending on a dumpsys output shape that varies by Android version.
    const local = `/tmp/duomove-installed-${randomUUID()}.apk`;
    try {
      await adb(['-s', endpoint, 'pull', apkPath, local], 120_000);
      const bytes = await readFile(local);
      const signing = readApkSigners(bytes);
      pulled = {
        localCopy: local,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        signatureSchemes: signing.schemes,
        v1JarSignature: hasV1Signature(bytes),
        signers: signing.signers,
      };
    } catch (error) {
      pulled = { error: `installed APK could not be copied for signer inspection: ${error.message}` };
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    packageName: PACKAGE,
    apkPath,
    versionName: field(/^\s*versionName=([^\r\n]{1,80})/m),
    versionCode: field(/^\s*versionCode=(\d+)\b/m),
    firstInstallTime: field(/^\s*firstInstallTime=([^\r\n]{1,60})/m),
    lastUpdateTime: field(/^\s*lastUpdateTime=([^\r\n]{1,60})/m),
    flags: field(/^\s*(?:pkgFlags|flags)=\[([^\]]*)\]/m),
    debuggable: /\bDEBUGGABLE\b/.test(dump?.output ?? '') ? true : dump ? false : null,
    onDeviceSha256,
    pinnedApkSha256: PINNED_APK_SHA256,
    matchesPinnedApk: onDeviceSha256 ? onDeviceSha256 === PINNED_APK_SHA256 : null,
    pinnedArtifactCaveat:
      'src/ops/playerVerification.ts pins exactly one package and one hash, so this result is '
      + 'evidence about that single artifact only. It is not a capability check and says nothing '
      + 'about any other package, including a future radio plugin.',
    signerDigestFrom: pulled?.signers?.length ? 'installed APK copy' : 'UNAVAILABLE',
    installedApkCopy: pulled,
    raw: { path, dump, checksum },
  };
}

async function probeImage(endpoint) {
  const results = {};
  for (const [name, command, limit] of PROBES) {
    results[name] = await shell(endpoint, command, { limit });
  }
  return { checkedAt: new Date().toISOString(), results, verdicts: probeVerdicts(results) };
}

function radioReadback(finalStatus, probe) {
  const radioFields = Object.keys(finalStatus ?? {}).filter(key => /wifi|cell|bluetooth|rsrp|rssi|scan/i.test(key));
  return {
    checkedAt: new Date().toISOString(),
    wifi: 'NOT_OBSERVED',
    cell: 'NOT_OBSERVED',
    bluetooth: 'NOT_OBSERVED',
    playerProtocolRadioFields: radioFields,
    reason:
      'The installed artifact is the GPS player. Its status response carries only session, '
      + 'playback and location-observer fields; there is no radio field in the protocol to read, '
      + 'and no class in the APK references a Wi-Fi, telephony or Bluetooth API. NOT_OBSERVED is '
      + 'therefore the absence of any collector, not a failed collection.',
    missingForG03: [
      'A receiver on the phone that accepts a radio frame (checklist A01, B03).',
      'An applier able to change what an app observes, which on a non-rooted image requires a dplus module (A01).',
      'A readback collector in a different process from the applier, reporting observer package, process, UID and in/out-of-scope status (A05).',
      'Per-value boot-relative measurement times, and availability distinct from empty (A05, B05).',
    ],
    outOfScopeShellComparison: probe ? {
      scope: 'ADB_SHELL_NOT_PLUGIN_SCOPE',
      caveat:
        'These are shell-scope reads from the host, not the app-scope observation A05 requires. '
        + 'They establish whether the hardware and platform data exist at all; they are not a '
        + 'radio readback and must not be recorded as one.',
      wifiStatus: probe.results['wifi.status'] ?? null,
      telephonyRegistry: probe.results['cell.telephonyRegistry'] ?? null,
      bluetoothManager: probe.results['bluetooth.serviceCheck'] ?? null,
    } : null,
  };
}

// ---------------------------------------------------------------- the drive

async function loadPlan({ planFile, origin }, endpoint) {
  if (planFile) return JSON.parse(await readFile(planFile, 'utf8'));
  let start = origin;
  if (!start && endpoint) {
    const location = await shell(endpoint, 'cat /proc/uptime; dumpsys location', { limit: 200_000 });
    const fix = /Location\[(?:fused|gps)\s+(-?\d+\.\d+),(-?\d+\.\d+)/.exec(location.output ?? '');
    if (fix) start = `${fix[1]},${fix[2]}`;
    if (start) log(`origin taken from the phone's last known fix: ${start}`);
  }
  if (!start) throw new Error('No --plan and no origin: pass --origin <lat>,<lng> so the route starts where the phone already is');
  const { stdout } = await exec('node', ['--import', 'tsx', 'scripts/duomove-acceptance-plan.ts', '--origin', start], {
    timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function drive(player, plan, phases, pollMs) {
  const sessionId = randomUUID();
  const bytes = Buffer.from(JSON.stringify(plan));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const timeline = [];
  const mark = (event, status) => timeline.push({ event, atMs: performance.now(), state: status?.state ?? null });

  const before = (await player.status()).status;
  if (!(before.state === 'IDLE' || ['COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(before.state))) {
    throw new Error(`Refusing to drive: the player is in state ${before.state}, so another writer may own it. `
      + 'Nothing was cancelled. Confirm no trip is running and retry.');
  }
  if (before.cleanup_ok !== true) throw new Error('Refusing to drive: the player reports cleanup_ok=false, so its test providers are unresolved.');
  mark('precondition', before);

  log(`uploading ${bytes.length} bytes, ${plan.samples.length} samples, session ${sessionId}`);
  let status = (await player.request({ op: 'prepare', session_id: sessionId, size: bytes.length, sha256 })).status;
  mark('prepare', status);
  if (status.state === 'UPLOADING') {
    for (let offset = status.received_bytes; offset < bytes.length; offset += CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
      status = (await player.request({ op: 'append', session_id: sessionId, offset, data: chunk.toString('base64') })).status;
      if (status.received_bytes !== offset + chunk.length) throw new Error('player upload acknowledgment mismatch');
    }
    status = (await player.request({ op: 'commit', session_id: sessionId })).status;
    mark('commit', status);
  }
  if (status.state !== 'READY') throw new Error(`player did not reach READY, got ${status.state} ${status.error ?? ''}`);

  const startedAtWall = new Date().toISOString();
  const startResult = await player.request({ op: 'start', session_id: sessionId });
  const startedAtMs = performance.now();
  mark('start', startResult.status);
  log(`started; polling status every ${pollMs} ms`);

  const polls = [{ atMs: startedAtMs, rttMs: startResult.rttMs, status: startResult.status }];
  const budgetMs = plan.duration_ms + 90_000;
  let last = startResult.status;
  while (performance.now() - startedAtMs < budgetMs) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    let poll;
    try { poll = await player.status(); }
    catch (error) { log(`status poll failed: ${error.message}`); break; }
    polls.push({ atMs: performance.now(), rttMs: poll.rttMs, status: poll.status });
    if (poll.status.session_id !== sessionId) throw new Error('player session changed mid-run; no replay attempted');
    if (poll.status.state !== last.state) { mark(`state:${poll.status.state}`, poll.status); log(`state ${last.state} -> ${poll.status.state} at applied_seq ${poll.status.applied_seq}`); }
    last = poll.status;
    if (['COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(poll.status.state)) break;
  }

  let cancelled = null;
  if (!['COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(last.state)) {
    log('run did not reach a terminal state inside its budget; cancelling this harness session only');
    cancelled = (await player.request({ op: 'cancel', session_id: sessionId }).catch(error => ({ status: { error: error.message } }))).status;
    mark('cancel', cancelled);
  }

  return {
    sessionId,
    instanceId: player.instanceId ?? null,
    planSha256: sha256,
    planBytes: bytes.length,
    startedAtWall,
    startedAtMonotonicMs: startedAtMs,
    terminalState: (cancelled ?? last).state ?? null,
    cleanupOk: (cancelled ?? last).cleanup_ok ?? null,
    playerError: (cancelled ?? last).error || null,
    timeline,
    polls,
    cadence: cadenceReport(polls, {
      plannedIntervalMs: plan.interval_ms ?? 1000,
      startDelayMs: 500,
      expectedSamples: plan.samples.length,
      phases,
    }),
  };
}

// ---------------------------------------------------------------- report

function markdown(evidence) {
  const cadence = evidence.drive?.cadence;
  const number = value => (value === null || value === undefined ? 'n/a' : (typeof value === 'number' ? value.toFixed(1) : String(value)));
  const lines = [
    '# DuoMove on-phone acceptance run',
    '',
    `- Run at: ${evidence.startedAt}`,
    `- Harness host egress: ${evidence.hostEgress ?? 'not determined'}`,
    `- ADB endpoint: ${evidence.endpoint ?? 'direct port (no ADB)'}`,
    `- Image id: ${evidence.imageId ?? 'not supplied'}`,
    `- Outcome: **${evidence.outcome}**`,
    '',
    '## G01 — installed artifact identity',
    '',
  ];
  const identity = evidence.identity;
  if (identity) {
    lines.push(
      `| Field | Value |`, `| --- | --- |`,
      `| package | \`${identity.packageName}\` |`,
      `| versionName / versionCode | ${identity.versionName ?? 'n/a'} / ${identity.versionCode ?? 'n/a'} |`,
      `| APK path | \`${identity.apkPath ?? 'n/a'}\` |`,
      `| on-device SHA-256 | \`${identity.onDeviceSha256 ?? 'n/a'}\` |`,
      `| matches pinned artifact | ${identity.matchesPinnedApk === null ? 'n/a' : identity.matchesPinnedApk} |`,
      `| signer cert SHA-256 | ${identity.installedApkCopy?.signers?.map(signer => `\`${signer.sha256}\` (${signer.scheme})`).join(', ') ?? 'UNAVAILABLE'} |`,
      `| signature schemes | ${identity.installedApkCopy?.signatureSchemes?.join(', ') ?? 'n/a'}${identity.installedApkCopy ? `, v1 JAR: ${identity.installedApkCopy.v1JarSignature}` : ''} |`,
      `| firstInstallTime | ${identity.firstInstallTime ?? 'n/a'} |`,
      `| lastUpdateTime | ${identity.lastUpdateTime ?? 'n/a'} |`,
      `| debuggable | ${identity.debuggable ?? 'n/a'} |`,
      '', `> ${identity.pinnedArtifactCaveat}`, '',
    );
  } else lines.push('Not collected.', '');

  lines.push('## G02 — measured cadence', '');
  if (cadence) {
    lines.push(
      `Clock domain: ${cadence.clockDomain}.`, '',
      `| Metric | Median | 95th | Max | Min | n |`, `| --- | --- | --- | --- | --- | --- |`,
      `| Interval (ms) | ${number(cadence.intervalMs.median)} | ${number(cadence.intervalMs.p95)} | ${number(cadence.intervalMs.max)} | ${number(cadence.intervalMs.min)} | ${cadence.intervalMs.count} |`,
      `| Lateness vs schedule (ms) | ${number(cadence.lateness.absoluteMs.median)} | ${number(cadence.lateness.absoluteMs.p95)} | ${number(cadence.lateness.absoluteMs.max)} | ${number(cadence.lateness.absoluteMs.min)} | ${cadence.lateness.absoluteMs.count} |`,
      `| Lateness vs first sample (ms) | ${number(cadence.lateness.relativeToFirstSampleMs.median)} | ${number(cadence.lateness.relativeToFirstSampleMs.p95)} | ${number(cadence.lateness.relativeToFirstSampleMs.max)} | ${number(cadence.lateness.relativeToFirstSampleMs.min)} | ${cadence.lateness.relativeToFirstSampleMs.count} |`,
      '',
      `- Samples observed: ${cadence.samplesObserved} of ${cadence.expectedSamples ?? 'n/a'}; unobserved indices: ${cadence.unobservedSeqs.length}`,
      `- Phone-reported max lateness: ${cadence.lateness.deviceReportedMaxMs ?? 'n/a'} ms`,
      `- Phone-reported skipped samples: ${cadence.deviceCounters.skippedSamples ?? 'n/a'}`,
      `- Phone-reported observer mismatches: ${cadence.deviceCounters.observerMismatches ?? 'n/a'}`,
      `- Delivery: ${cadence.deviceCounters.delivery ?? 'n/a'}; observer scope: ${cadence.deviceCounters.observerScope ?? 'n/a'}`,
      `- Terminal state: ${evidence.drive.terminalState}; cleanup ok: ${evidence.drive.cleanupOk}`,
      `- Measurement resolution: poll gap median ${number(cadence.measurement.pollGapMs.median)} ms, request round trip median ${number(cadence.measurement.requestRoundTripMs.median)} ms`,
      '',
      '### Interval distribution', '', '| Bucket (ms) | Count |', '| --- | --- |',
      ...cadence.intervalHistogramMs.filter(bucket => bucket.count).map(bucket => `| ${bucket.label} | ${bucket.count} |`),
      '',
      '### Per phase', '', '| Phase | Samples | Interval median | Interval p95 | Lateness p95 |', '| --- | --- | --- | --- | --- |',
      ...cadence.phaseBreakdown.map(phase => `| ${phase.name} | ${phase.samplesObserved} | ${number(phase.intervalMs.median)} | ${number(phase.intervalMs.p95)} | ${number(phase.relativeLatenessMs.p95)} |`),
      '',
      `> These tolerances are what this environment produced on this image on this run. They are `
      + `not a universal timing guarantee, and they do not describe the controller's own `
      + `supervision cadence, which re-checks roughly every 1.5 s.`, '',
    );
  } else lines.push(`Not collected: ${evidence.driveSkippedReason ?? 'the drive did not run'}.`, '');

  lines.push('## G03 — radio readback attempt', '');
  if (evidence.radio) {
    lines.push(
      `Wi-Fi: **${evidence.radio.wifi}** · cellular: **${evidence.radio.cell}** · Bluetooth: **${evidence.radio.bluetooth}**`, '',
      evidence.radio.reason, '',
      'Missing before G03 can be attempted:', '',
      ...evidence.radio.missingForG03.map(item => `- ${item}`), '',
    );
  } else lines.push('Not collected.', '');

  lines.push('## Image probe (build brief §11)', '');
  if (evidence.probe) {
    const verdicts = evidence.probe.verdicts;
    lines.push(
      `| Question | Answer |`, `| --- | --- |`,
      `| Modem present? | **${verdicts.modemPresent}** ${verdicts.modemEvidence.join('; ') || ''} |`,
      `| Bluetooth adapter present? | **${verdicts.bluetoothAdapterPresent}** ${verdicts.bluetoothEvidence.join('; ') || ''} |`,
      `| wifi_scan_throttle_enabled | **${verdicts.wifiScanThrottle}** |`,
      `| dplus framework present? | ${verdicts.dplusFrameworkPresent} |`,
      `| player package listed? | ${verdicts.playerPackageListed} |`,
      `| Android release / SDK | ${verdicts.androidRelease ?? 'n/a'} / ${verdicts.androidSdk ?? 'n/a'} |`,
      `| SELinux | ${verdicts.selinux ?? 'n/a'} |`,
      `| boot_count | ${verdicts.bootCount ?? 'n/a'} |`,
      '', `- ${verdicts.modemNote}`, `- ${verdicts.bluetoothNote}`, `- ${verdicts.wifiScanThrottleNote}`, '',
    );
  } else lines.push('Not collected.', '');

  lines.push('## Constraints honoured', '',
    '- No package installed, uninstalled, updated or force-stopped.',
    '- No app data, account, session or profile cleared; no control token written.',
    '- No device setting changed; every probe is a read.',
    '- The drive used a fresh session id and was cancelled only if it was this run\'s own session.',
    '');
  return lines.join('\n');
}

// ---------------------------------------------------------------- main

async function main() {
  const config = options();
  const evidence = {
    startedAt: new Date().toISOString(),
    harness: 'scripts/duomove-acceptance.mjs',
    endpoint: config.directPort ? null : config.endpoint || null,
    imageId: config.imageId,
    outcome: 'INCOMPLETE',
  };

  try {
    evidence.hostEgress = (await fetch('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(5000) })
      .then(response => response.text())).trim();
  } catch { evidence.hostEgress = null; }

  let player;
  let forwardedPort = null;
  const endpoint = config.directPort ? null : requireEndpoint(config.endpoint);
  if (config.directPort && !config.tokenFile) {
    throw new Error('--direct-port needs --token-file: without ADB there is no read-only way to fetch the existing token');
  }

  try {
    if (endpoint) {
      log(`connecting ADB to ${endpoint}`);
      const connected = await adb(['connect', endpoint]);
      const connectOutput = `${connected.stdout}${connected.stderr}`;
      if (!/(?:already )?connected to /.test(connectOutput)) throw new Error(`adb connect failed: ${connectOutput.trim().slice(0, 200)}`);
      const state = (await adb(['-s', endpoint, 'get-state'])).stdout.trim();
      evidence.adbState = state;
      if (state !== 'device') throw new Error(`adb reports state "${state}", not "device"; ADB is not authorized`);

      if (!config.skipProbe) { log('probing the image'); evidence.probe = await probeImage(endpoint); }
      log('reading installed artifact identity');
      evidence.identity = await installedIdentity(endpoint, config);
    }

    const token = config.tokenFile
      ? (await readFile(config.tokenFile, 'utf8')).trim()
      // Reading the existing token back is read-only. The harness never provisions one, because
      // replacing it would invalidate the controller's own credential.
      : (await shell(endpoint, `run-as ${PACKAGE} cat files/control-token`)).output.trim();
    if (!TOKEN_PATTERN.test(token)) {
      throw new Error('Control token was not readable in the expected format. Pass --token-file with the '
        + 'controller copy from ${DUOMOVE_STATE_DIR}/duomove-control-token. The harness will not create one.');
    }

    const port = config.directPort ?? Number((await adb(['-s', endpoint, 'forward', 'tcp:0', `tcp:${PLAYER_CONTROL_PORT}`])).stdout.trim());
    if (!Number.isInteger(port) || port <= 0) throw new Error('adb forward did not return a local port');
    if (!config.directPort) forwardedPort = port;
    log(`player control socket on 127.0.0.1:${port}`);
    player = await Player.connect(port, token);
    const initial = await player.status();
    evidence.playerStatusBefore = initial.status;

    if (config.probeOnly) {
      evidence.driveSkippedReason = '--probe-only was set';
      evidence.outcome = 'PROBE_ONLY';
    } else {
      const { plan, phases } = await loadPlan(config, endpoint);
      evidence.plan = { samples: plan.samples.length, durationMs: plan.duration_ms, distanceM: plan.total_distance_m, phases };
      evidence.drive = await drive(player, plan, phases, config.pollMs);
      evidence.outcome = evidence.drive.terminalState === 'COMPLETED' && evidence.drive.cleanupOk ? 'DRIVE_COMPLETED' : `DRIVE_${evidence.drive.terminalState ?? 'UNRESOLVED'}`;
    }
    evidence.radio = radioReadback(evidence.drive?.polls?.at(-1)?.status ?? evidence.playerStatusBefore, evidence.probe);
  } catch (error) {
    evidence.outcome = 'FAILED';
    evidence.failure = error.message;
    log(`FAILED: ${error.message}`);
  } finally {
    player?.close();
    // Only this run's forward is removed, and the ADB connection is deliberately left alone: the
    // controller may share this adb server, and disconnecting would drop its session too.
    if (forwardedPort) await adb(['-s', endpoint, 'forward', '--remove', `tcp:${forwardedPort}`]).catch(() => {});
  }

  evidence.finishedAt = new Date().toISOString();
  await mkdir(config.out, { recursive: true });
  await writeFile(`${config.out}/evidence.json`, JSON.stringify(evidence, null, 2));
  await writeFile(`${config.out}/report.md`, markdown(evidence));
  log(`wrote ${config.out}/evidence.json and ${config.out}/report.md`);
  console.log(markdown(evidence));
  process.exitCode = evidence.outcome === 'FAILED' ? 1 : 0;
}

await main();
