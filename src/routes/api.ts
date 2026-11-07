import { Router, Request, Response } from 'express';
import { getClientConfig, loadConfig, updateConfig, UserConfig } from '../config';
import { notifyProfileChange } from '../onProfileChange';
import { getTransactions, resetTransactions, transactionsToCsv } from '../transactionLog';
import { getEpicsWithData, getRecordedSampleCount, getDbPath } from '../services/priceRecorder';
import {
  applyProfileMarketSnapshot,
  type BacktestProfileMarketSnapshot,
} from '../services/backtestMarketSnapshot';
import { VERSION } from '../version';
import { clearAppLogFile, getAppLogPath, readAppLogTail } from '../activityLogFile';

const router = Router();

router.get('/version', (_req: Request, res: Response) => {
  res.json({ version: VERSION });
});

router.get('/config', (_req: Request, res: Response) => {
  res.json(getClientConfig());
});

router.post('/config', (req: Request, res: Response) => {
  try {
    const current = loadConfig();
    const body = req.body as Partial<UserConfig> & { activeProfile?: string };
    const merged = updateConfig(body);
    if (body.activeProfile !== undefined && current.activeProfile !== merged.activeProfile) {
      notifyProfileChange();
    }
    res.json(getClientConfig());
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get('/transactions', (_req: Request, res: Response) => {
  res.json(getTransactions());
});

/** Download persisted server Log messages (header “Log” / pop-out). */
router.get('/app-log.txt', (_req: Request, res: Response) => {
  const lines = readAppLogTail(8000);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tiddelitrade-app-log.txt"');
  res.send(lines.join('\n') + (lines.length ? '\n' : ''));
});

router.get('/app-log/path', (_req: Request, res: Response) => {
  res.json({ path: getAppLogPath() });
});

router.post('/app-log/clear', (_req: Request, res: Response) => {
  clearAppLogFile();
  res.json({ ok: true });
});

router.post('/transactions/reset', (_req: Request, res: Response) => {
  resetTransactions();
  res.json(getTransactions());
});

/** JSON export of persisted deals log (full rows). */
router.get('/transactions/export.json', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tiddelitrade-deals.json"');
  res.json({ exportedAt: new Date().toISOString(), transactions: getTransactions() });
});

/** CSV export of closed deals only. */
router.get('/transactions/export.csv', (_req: Request, res: Response) => {
  const csv = transactionsToCsv(getTransactions());
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tiddelitrade-deals.csv"');
  res.send(csv);
});

/** Apply dealing schedule + day-start cache from an imported/loaded profile. */
router.post('/backtest-market-snapshot', (req: Request, res: Response) => {
  try {
    const epic = typeof req.body?.epic === 'string' ? req.body.epic.trim() : '';
    const snapshot = req.body?.snapshot as BacktestProfileMarketSnapshot | undefined;
    if (!epic) {
      res.status(400).json({ error: 'epic required' });
      return;
    }
    if (!snapshot || typeof snapshot.dealingSnapshotAt !== 'number') {
      res.status(400).json({ error: 'snapshot with dealingSnapshotAt required' });
      return;
    }
    applyProfileMarketSnapshot(epic, snapshot);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get('/recorded-stats', (_req: Request, res: Response) => {
  const epics = getEpicsWithData();
  const byEpic: Record<string, number> = {};
  for (const e of epics) {
    byEpic[e] = getRecordedSampleCount(e);
  }
  res.json({ epics, byEpic, configEpic: loadConfig().epic || null, dbPath: getDbPath() });
});

export default router;
