/**
 * Persist server "Log" messages (socket `log` events) to app.log for post-mortems.
 * Browser pop-out still holds the latest ~500 lines only.
 */
import fs from 'fs';
import path from 'path';

const APP_LOG_PATH = path.join(process.cwd(), 'app.log');
const MAX_BYTES = 2 * 1024 * 1024;

function lineBytes(line: string): Buffer {
  return Buffer.from(line.endsWith('\n') ? line : line + '\n', 'utf-8');
}

/** Append one line (ISO timestamp prefix added here). */
export function appendAppLogMessage(message: string): void {
  const raw = (message || '').trim();
  if (!raw) return;
  const line = `[${new Date().toISOString()}] ${raw}\n`;
  try {
    const dir = path.dirname(APP_LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(APP_LOG_PATH, line, 'utf-8');
    trimAppLogIfOversize();
  } catch {
    /* logging must not break trading */
  }
}

function trimAppLogIfOversize(): void {
  try {
    const st = fs.statSync(APP_LOG_PATH);
    if (st.size <= MAX_BYTES) return;
    const buf = fs.readFileSync(APP_LOG_PATH, 'utf-8');
    const keepFrom = Math.max(0, buf.length - Math.floor(MAX_BYTES * 0.85));
    const slice = buf.slice(keepFrom);
    const firstNl = slice.indexOf('\n');
    const trimmed = firstNl >= 0 ? slice.slice(firstNl + 1) : slice;
    fs.writeFileSync(APP_LOG_PATH, trimmed, 'utf-8');
  } catch {
    /* ignore */
  }
}

/** Last N lines for API export (newest last). */
export function readAppLogTail(maxLines = 4000): string[] {
  try {
    if (!fs.existsSync(APP_LOG_PATH)) return [];
    const raw = fs.readFileSync(APP_LOG_PATH, 'utf-8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= maxLines) return lines;
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

export function getAppLogPath(): string {
  return APP_LOG_PATH;
}

export function clearAppLogFile(): void {
  try {
    fs.writeFileSync(APP_LOG_PATH, '', 'utf-8');
  } catch {
    /* ignore */
  }
}
