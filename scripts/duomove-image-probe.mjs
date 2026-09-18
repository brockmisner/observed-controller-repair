// The image probe from docs/radio-apk-build-brief.md §11, plus the interpretation that turns its
// raw output into the yes/no answers the release scope depends on.
//
// Every command is a read. None of them installs, changes a setting or touches stored state.

/** `[name, command, outputLimitBytes]` — order is the order they run in. */
export const PROBES = [
  ['platform.release', 'getprop ro.build.version.release', 200],
  ['platform.sdk', 'getprop ro.build.version.sdk', 200],
  ['platform.fingerprint', 'getprop ro.build.fingerprint', 500],
  ['platform.model', 'getprop ro.product.model', 200],
  ['platform.abilist', 'getprop ro.product.cpu.abilist', 300],
  ['platform.debuggable', 'getprop ro.debuggable', 200],
  ['platform.selinux', 'getenforce', 200],
  ['platform.shellIdentity', 'id', 500],
  ['plugin.dplusDump', 'dplus dump', 8000],
  ['plugin.packages', 'pm list packages', 40_000],
  ['wifi.status', 'cmd wifi status', 4000],
  ['wifi.scanThrottle', 'settings get global wifi_scan_throttle_enabled', 200],
  ['wifi.dumpsys', 'dumpsys wifi', 12_000],
  ['cell.operatorNumeric', 'getprop gsm.operator.numeric', 200],
  ['cell.simState', 'getprop gsm.sim.state', 200],
  ['cell.rilImplementation', 'getprop gsm.version.ril-impl', 300],
  ['cell.serviceCheck', 'service check phone', 300],
  ['cell.telephonyRegistry', 'dumpsys telephony.registry', 16_000],
  ['bluetooth.serviceCheck', 'service check bluetooth', 300],
  ['bluetooth.enabled', 'settings get global bluetooth_on', 200],
  ['bluetooth.manager', 'dumpsys bluetooth_manager', 12_000],
  ['location.enabled', 'cmd location is-location-enabled', 500],
  ['location.mode', 'settings get secure location_mode', 200],
  ['identity.bootCount', 'settings get global boot_count', 200],
  ['clock.uptime', 'cat /proc/uptime', 200],
];

/** Turns raw probe output into the answers the brief's open questions 3 and 5 need. */
export function probeVerdicts(results) {
  const text = name => results[name]?.output ?? '';
  const operator = text('cell.operatorNumeric').trim();
  const simState = text('cell.simState').trim();
  const registry = text('cell.telephonyRegistry');
  const throttle = text('wifi.scanThrottle').trim();

  const modemEvidence = [];
  if (operator && operator !== 'null') modemEvidence.push(`gsm.operator.numeric=${operator}`);
  if (simState && !/^(null|ABSENT|UNKNOWN)$/i.test(simState)) modemEvidence.push(`gsm.sim.state=${simState}`);
  if (/mServiceState|mSignalStrength|mCellIdentity|CellIdentity(Lte|Gsm|Nr|Wcdma)/i.test(registry)) {
    modemEvidence.push('telephony.registry reports radio state');
  }
  if (/service phone: \[/.test(text('cell.serviceCheck'))) modemEvidence.push('phone binder service present');
  if (/voice(Reg|Radio)|mVoiceRegState\s*[:=]\s*0/i.test(registry)) modemEvidence.push('voice registration reported');

  const bluetoothEvidence = [];
  if (/service bluetooth: \[/.test(text('bluetooth.serviceCheck'))) bluetoothEvidence.push('bluetooth binder service present');
  if (/enabled(:|\s)+true|mState\s*[:=]\s*(ON|12)\b|AdapterState[^\n]*ON/i.test(text('bluetooth.manager'))) {
    bluetoothEvidence.push('adapter reports enabled');
  }
  if (text('bluetooth.enabled') === '1') bluetoothEvidence.push('global bluetooth_on=1');

  return {
    modemPresent: modemEvidence.length ? 'EVIDENCE_FOUND' : 'NO_EVIDENCE',
    modemEvidence,
    modemNote:
      'No modem evidence means cellular readback is unavailable regardless of what any plugin '
      + 'injects into an app, which shrinks E03, E06, E07 and the cellular half of G03 to '
      + 'modelled-only. Injection can still make an in-scope app report cells, but nothing on the '
      + 'device measures them.',
    bluetoothAdapterPresent: bluetoothEvidence.length ? 'EVIDENCE_FOUND' : 'NO_EVIDENCE',
    bluetoothEvidence,
    bluetoothNote:
      'No adapter means the arrival Bluetooth action (D02) has nothing to act on, and E08 reduces '
      + 'to modelled data with no physical discovery result to compare against.',
    wifiScanThrottle: throttle === '0' ? 'DISABLED'
      : throttle === '1' ? 'ENABLED'
        : throttle === '' || throttle === 'null' ? 'UNSET_PLATFORM_DEFAULT_APPLIES'
          : `UNEXPECTED:${throttle.slice(0, 32)}`,
    wifiScanThrottleNote:
      'The platform default is roughly 4 scans per 2 minutes in the foreground and 1 per 30 '
      + 'minutes in the background. While it applies, the arrival gate requirement for a Wi-Fi '
      + 'sample timestamped at or after frame issue is not reliably satisfiable, so E04/E05 need '
      + 'either this setting disabled on the image or a relaxed freshness rule.',
    dplusFrameworkPresent: results['plugin.dplusDump']?.ok && /module|package|name/i.test(text('plugin.dplusDump'))
      ? 'EVIDENCE_FOUND' : 'NO_EVIDENCE',
    playerPackageListed: /net\.stakeout\.duomove\.player/.test(text('plugin.packages')) ? 'YES' : 'NOT_LISTED',
    selinux: text('platform.selinux').trim() || null,
    androidRelease: text('platform.release').trim() || null,
    androidSdk: text('platform.sdk').trim() || null,
    bootCount: text('identity.bootCount').trim() || null,
    locationEnabled: text('location.enabled').trim() || null,
  };
}
