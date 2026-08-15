/**
 * Persisted scheduled closes. Survives server restart.
 * Stored in scheduled-closes.json (UTC timestamps).
 */

import fs from 'fs';
import path from 'path';

const SCHEDULED_CLOSES_PATH = path.join(process.cwd(), 'scheduled-closes.json');

export interface ScheduledCloseEntry {
  dealId: string;
  direction: 'BUY' | 'SELL';
  size: number;
  closeAt: number;
  /** 'deal' = manual deal, 'order' = working order fill, 'rules' = rules engine deal */
  source?: 'deal' | 'order' | 'rules';
}

export function loadScheduledCloses(): ScheduledCloseEntry[] {
  try {
    const raw = fs.readFileSync(SCHEDULED_CLOSES_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as ScheduledCloseEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveScheduledCloses(entries: ScheduledCloseEntry[]): void {
  const dir = path.dirname(SCHEDULED_CLOSES_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SCHEDULED_CLOSES_PATH, JSON.stringify(entries, null, 2), 'utf-8');
}
