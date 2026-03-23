import { Router, Request, Response } from 'express';
import { getClientConfig, loadConfig, updateConfig, UserConfig } from '../config';
import { notifyProfileChange } from '../onProfileChange';
import { getTransactions, resetTransactions } from '../transactionLog';
import { getEpicsWithData, getRecordedSampleCount, getDbPath } from '../services/priceRecorder';
import { VERSION } from '../version';

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

router.post('/transactions/reset', (_req: Request, res: Response) => {
  resetTransactions();
  res.json(getTransactions());
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
