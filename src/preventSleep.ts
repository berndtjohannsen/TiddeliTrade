/**
 * OS-independent sleep prevention. Prevents the system from sleeping when TiddeliTrade is running.
 * Windows/macOS: stay-awake. Linux: systemd-inhibit.
 */
import { spawn, ChildProcess } from 'child_process';

let linuxInhibitProcess: ChildProcess | null = null;

export function preventSleep(): string | null {
  const platform = process.platform;
  if (platform === 'win32' || platform === 'darwin') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const stayAwake = require('stay-awake');
      if (typeof stayAwake.prevent === 'function') {
        stayAwake.prevent(() => {});
        return 'Sleep prevention enabled';
      }
    } catch (e) {
      return 'Sleep prevention unavailable: ' + (e as Error).message;
    }
    return null;
  }
  if (platform === 'linux') {
    try {
      if (linuxInhibitProcess) return null; // already holding
      linuxInhibitProcess = spawn('systemd-inhibit', [
        '--what=idle:sleep',
        '--who=TiddeliTrade',
        '--why=TiddeliTrade running',
        'sleep',
        'infinity',
      ], { stdio: 'ignore' });
      linuxInhibitProcess.on('error', () => {
        linuxInhibitProcess = null;
      });
      linuxInhibitProcess.on('exit', () => {
        linuxInhibitProcess = null;
      });
      return 'Sleep prevention enabled (rules engine running)';
    } catch (e) {
      return 'Sleep prevention unavailable: ' + (e as Error).message;
    }
  }
  return null;
}

export function allowSleep(): string | null {
  const platform = process.platform;
  if (platform === 'win32' || platform === 'darwin') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const stayAwake = require('stay-awake');
      if (typeof stayAwake.allow === 'function') {
        stayAwake.allow(() => {});
        return 'Sleep prevention disabled';
      }
    } catch {
      /* ignore */
    }
    return null;
  }
  if (platform === 'linux') {
    if (linuxInhibitProcess) {
      linuxInhibitProcess.kill();
      linuxInhibitProcess = null;
      return 'Sleep prevention disabled';
    }
  }
  return null;
}
