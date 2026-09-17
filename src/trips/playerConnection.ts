import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { PlayerSocket } from './playerProtocol.js';
import { logger } from '../logger.js';
import { readPhoneLocation, PHONE_LOCATION_COMMAND } from '../api/phoneNavigation.js';
const exec = promisify(execFile);
const pkg = 'net.stakeout.duomove.player';
export const playerImage = () => process.env.DUOMOVE_IMAGE_ID || '';
export const usesPlayer = (imageId: string) => Boolean(playerImage() && imageId === playerImage());
function endpoint() {
  const value = process.env.ADB_PREFLIGHT_ENDPOINT || '';
  const [host, port, extra] = value.split(':');
  if (extra || isIP(host!) !== 4 || !/^\d+$/.test(port || '') || +port! < 1 || +port! > 65535) throw new Error('Player ADB endpoint is invalid');
  return value;
}
async function adb(args: string[], timeout = 12000) {
  try { return (await exec('adb', args, { timeout, maxBuffer: 65536 })).stdout.trim(); }
  catch { throw new Error('Player ADB command failed; check the phone connection'); }
}
const tokenPath = () => `${process.env.DUOMOVE_STATE_DIR || '/app/data'}/duomove-control-token`;
async function connectAdb() {
  await adb(['connect', endpoint()]);
  if (await adb(['-s', endpoint(), 'get-state']) !== 'device') throw new Error('Player phone is not connected');
}
export async function withPlayer<T>(work: (client: PlayerSocket) => Promise<T>): Promise<T> {
  await connectAdb();
  const token = (await readFile(tokenPath(), 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('Player setup is incomplete');
  const port = await adb(['-s', endpoint(), 'forward', 'tcp:0', 'tcp:9999']);
  if (!/^\d+$/.test(port)) throw new Error('Player tunnel was not created');
  let client: PlayerSocket | undefined;
  try { client = await PlayerSocket.connect(Number(port), token); return await work(client); }
  finally { client?.close(); await adb(['-s', endpoint(), 'forward', '--remove', `tcp:${port}`]).catch(() => {}); }
}
// Fixed commands only. Token is passed on stdin into app-private storage, never in argv/logs.
export async function initializePlayer(): Promise<void> {
  if (!playerImage()) return;
  try {
    await connectAdb();
    if (!(await adb(['-s', endpoint(), 'shell', 'pm', 'path', pkg])).startsWith('package:')) throw new Error('DuoMove Player is not installed');
    await mkdir(process.env.DUOMOVE_STATE_DIR || '/app/data', { recursive: true, mode: 0o700 });
    try { await writeFile(tokenPath(), randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const token = await readFile(tokenPath(), 'utf8');
    await adb(['-s', endpoint(), 'shell', 'am', 'force-stop', pkg]);
    await new Promise<void>((resolve, reject) => {
      const child = spawn('adb', ['-s', endpoint(), 'shell', 'run-as', pkg, 'sh', '-c', "'umask 077; mkdir -p files; cat > files/control-token'"], { stdio: ['pipe', 'ignore', 'ignore'] });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Player token setup timed out')); }, 12000);
      child.on('error', () => { clearTimeout(timer); reject(new Error('Player token setup failed')); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Player token setup failed')); });
      child.stdin.on('error', () => {}); child.stdin.end(token);
    });
    for (const permission of ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION', 'POST_NOTIFICATIONS']) {
      await adb(['-s', endpoint(), 'shell', 'pm', 'grant', pkg, `android.permission.${permission}`]);
    }
    await adb(['-s', endpoint(), 'shell', 'appops', 'set', pkg, 'android:mock_location', 'allow']);
    await adb(['-s', endpoint(), 'shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`]);
    let ready = false;
    for (let i = 0; i < 5; i++) {
      try {
        const status = await withPlayer(c => c.request({ op: 'status' }));
        if (status.cleanup_ok !== true || status.state !== 'IDLE') throw new Error();
        ready = true; break;
      } catch { await new Promise(r => setTimeout(r, 1000)); }
    }
    if (!ready) throw new Error('Player did not become ready; check location permissions');
    logger.info({ event: 'duomove_setup', imageId: playerImage(), state: 'READY' }, 'DuoMove Player connected');
  } catch (error) {
    logger.warn({ event: 'duomove_setup', imageId: playerImage(), state: 'FAILED', reason: error instanceof Error ? error.message : 'Setup failed' }, 'DuoMove setup requires attention');
  }
}

export async function observePlayerPhone() {
  const startedAt = Date.now();
  const content = await adb(['-s', endpoint(), 'shell', PHONE_LOCATION_COMMAND], 2500);
  return readPhoneLocation(content, new Date(), Date.now() - startedAt);
}
