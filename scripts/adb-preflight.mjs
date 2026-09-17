import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
const exec = promisify(execFile);
export async function adbPreflight() {
  const endpoint = process.env.ADB_PREFLIGHT_ENDPOINT;
  if (!endpoint) return;
  const [host, port, extra] = endpoint.split(':');
  if (extra || isIP(host) !== 4 || !/^\d+$/.test(port ?? '') || +port < 1 || +port > 65535) {
    console.log(JSON.stringify({event:'adb_preflight',state:'INVALID_ENDPOINT'})); return;
  }
  const run = (args) => exec('adb', args, {timeout:15000, maxBuffer:65536});
  try {
    try {
      const ip = (await (await fetch('https://api.ipify.org', {signal:AbortSignal.timeout(5000)})).text()).trim();
      if (isIP(ip)) console.log(JSON.stringify({event:'adb_preflight',egressIp:ip}));
    } catch { /* Network diagnosis may proceed without egress discovery. */ }
    const connected = await run(['connect', endpoint]);
    const output = connected.stdout + connected.stderr;
    if (!/(?:already )?connected to /.test(output)) {
      const reason = /refused/i.test(output) ? 'CONNECTION_REFUSED' : /timed out/i.test(output) ? 'TIMEOUT' :
        /unreachable/i.test(output) ? 'NETWORK_UNREACHABLE' : /authenticate/i.test(output) ? 'AUTHENTICATION_REQUIRED' : 'CONNECT_FAILED';
      console.log(JSON.stringify({event:'adb_preflight',state:reason})); return;
    }
    const {stdout:state} = await run(['-s',endpoint,'get-state']);
    if (state.trim() !== 'device') { console.log(JSON.stringify({event:'adb_preflight',state:'NOT_READY'})); return; }
    const {stdout:version} = await run(['-s',endpoint,'shell','getprop','ro.build.version.release']);
    const {stdout:player} = await run(['-s',endpoint,'shell','pm','path','net.stakeout.duomove.player']);
    console.log(JSON.stringify({event:'adb_preflight',state:'CONNECTED',androidVersion:version.trim().slice(0,32),playerInstalled:player.trim().startsWith('package:')}));
  } catch(error) {
    console.log(JSON.stringify({event:'adb_preflight',state:error.killed ? 'TIMEOUT' : error.code === 'ENOENT' ? 'ADB_MISSING' : 'COMMAND_FAILED'}));
  } finally {
    try { await run(['disconnect',endpoint]); } catch { /* No persistent connection is needed for this read-only probe. */ }
  }
}
