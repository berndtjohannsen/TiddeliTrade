#!/usr/bin/env node
/**
 * Kill process listening on a port. Default: 3000
 * Usage: node scripts/kill-port.js [port]
 * Or: npm run kill-port -- [port]
 */

const { execSync } = require('child_process');
const port = process.argv[2] || '3000';

if (!/^\d+$/.test(port)) {
  console.error('Usage: kill-port.js [port]');
  console.error('  port: port number (default: 3000)');
  process.exit(1);
}

const isWin = process.platform === 'win32';
let pid;

try {
  if (isWin) {
    const out = execSync('netstat -ano', { encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.includes(`:${port}`) && l.includes('LISTENING'));
    if (line) pid = line.trim().split(/\s+/).pop();
  } else {
    const out = execSync(`lsof -ti:${port}`, { encoding: 'utf8' });
    pid = out.trim().split('\n')[0];
  }
} catch {
  // lsof returns non-zero when nothing found
}

if (!pid) {
  console.log(`No process found on port ${port}`);
  process.exit(0);
}

console.log(`Killing PID ${pid}...`);
try {
  if (isWin) {
    execSync(`taskkill /PID ${pid} /F`, { stdio: 'inherit' });
  } else {
    execSync(`kill -9 ${pid}`, { stdio: 'inherit' });
  }
} catch (e) {
  process.exit(e.status || 1);
}
