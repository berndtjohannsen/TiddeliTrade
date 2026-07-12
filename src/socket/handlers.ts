import { Server, Socket } from 'socket.io';
import { loadConfig, updateConfig } from '../config';
import { loadScheduledCloses, saveScheduledCloses, type ScheduledCloseEntry } from '../scheduledCloses';
import {
  closePosition,
  createPosition,
  createWorkingOrder,
  deleteWorkingOrder,
  getPositions,
  getWorkingOrders,
  createSession,
  getWatchlistEpics,
  IgSession,
  listWatchlists,
  inferExpiry,
  pollDealConfirmation,
  getHistoryTransactions,
  getMarketDetails,
  getMarketTradingInfo,
  getIndicativeCostsOpen,
  getHistoricalPrices,
  getDayStartPrice,
  getClientSentiment,
  type MarketDetails,
} from '../services/ig';
import { isStreaming, startStream, stopStream, switchEpic } from '../services/stream';
import { appendTransaction, appendTransactionOpen } from '../transactionLog';
import { setOnProfileChangeListener } from '../onProfileChange';
import { preventSleep, allowSleep } from '../preventSleep';
import {
  recordPrice,
  startRecording,
  stopRecording,
  isRecording,
  getRecordingStatus,
  getRecordedSamples,
  getRecordedSamplesFiltered,
  getRecordedSampleCount,
  getRecordedDays,
  getDayStats,
  getAllDayStats,
  getEpicsWithData,
  deleteSamplesByDays,
  deleteSparseDays,
} from '../services/priceRecorder';
import path from 'path';
import { Worker } from 'worker_threads';
import {
  dealingWeekFromMarketTimes,
  defaultDealingWeekLondonMonFri,
  type BacktestConfig,
  type BacktestReport,
  type BacktestDaySummary,
  type RuleBlockerCountRow,
  type RuleSetConfig,
  buildDynamicSlReportMeta,
  dayKeyFromTimestamp,
} from '../services/rulesBacktest';
import {
  clearDynamicStopLossTracking,
  getDynamicStopLossStatuses,
  onDynamicStopLossPriceTick,
  onDynamicStopLossPositionPoll,
  registerDynamicStopLoss,
  resolveDynamicStopLossSettings,
  resolveDynamicStopLossForBacktest,
  type DynamicStopLossOverride,
  shouldOmitTakeProfitForDeal,
  syncDynamicStopLossWithPositions,
  unregisterDynamicStopLoss,
} from '../services/dynamicStopLoss';
import { analyzeSampleQuality, type SampleQualityReport } from '../services/sampleQuality';

let scheduledCloses: ScheduledCloseEntry[] = [];
let recordingStatusTimer: ReturnType<typeof setInterval> | null = null;
const rulesEngineRunningBySocket = new Map<string, boolean>();
const activeAnalyseBySocket = new Map<string, (err?: string) => void>();

function updateSleepPrevention(io: Server, appRunning: boolean): void {
  const msg = appRunning ? preventSleep() : allowSleep();
  if (msg) {
    io.emit('log', msg);
    io.emit('sleep_prevention_status', msg);
  }
}

function emitRecordingStatus(io: Server): void {
  const status = getRecordingStatus();
  const epic = loadConfig().epic || null;
  const recordedCount = epic ? getRecordedSampleCount(epic) : null;
  io.emit('recording_status', {
    recording: status.recording,
    epic,
    sampleCount: status.sampleCount,
    durationMs: status.durationMs,
    recordedCount,
  });
}
let closeSchedulerTimer: ReturnType<typeof setInterval> | null = null;
let positionsPollTimer: ReturnType<typeof setInterval> | null = null;
let ordersPollTimer: ReturnType<typeof setInterval> | null = null;
const recentlyDeletedOrderIds: Record<string, number> = {};
let previousWorkingOrderIds = new Set<string>();
const pendingOrderCloses: Record<string, { closeAt: number; size: number; direction: 'BUY' | 'SELL'; epic: string }> = {};
let previousPositions: Awaited<ReturnType<typeof getPositions>> = [];
const recentlyClosedByUs: Record<string, number> = {};
const RECENTLY_CLOSED_TTL_MS = 120000;
/** Prevents duplicate close rows when overlapping polls both see a position disappear before either finishes await (appendTransaction dedupe races on load/save). */
const loggedClosedDealIds = new Set<string>();
/** Serializes position polls so only one run updates `previousPositions` / close detection at a time. */
let pollPositionsChain: Promise<unknown> = Promise.resolve();

const BACKFILL_CACHE_TTL_MS = 60000;
let lastBackfillCache: { epic: string; at: number; samples: { ts: number; mid: number; spread: number }[]; allowance: { total: number; remaining: number; expirySeconds: number } } | null = null;
const lastClientSentimentByEpic: Record<string, { longPct: number; shortPct: number } | null> = {};

async function pollAndEmitWorkingOrders(session: IgSession, io: Server): Promise<void> {
  try {
    const orders = await getWorkingOrders(session);
    const now = Date.now();
    const currentIds = new Set(orders.map((o) => (o.dealId || '').toString().trim()).filter(Boolean));
    const filtered = orders.filter((o) => {
      const id = (o.dealId || '').toString().trim();
      if (id && recentlyDeletedOrderIds[id] && now - recentlyDeletedOrderIds[id] < 60000) return false;
      return true;
    });
    const enriched = filtered.map((o) => {
      const id = (o.dealId || '').toString().trim();
      const pending = id ? pendingOrderCloses[id] : undefined;
      return {
        ...o,
        scheduledClose: pending && pending.closeAt > now ? new Date(pending.closeAt).toISOString() : undefined,
      };
    });
    io.emit('working_orders', enriched);

    for (const prevId of previousWorkingOrderIds) {
      if (currentIds.has(prevId)) continue;
      if (recentlyDeletedOrderIds[prevId] && now - recentlyDeletedOrderIds[prevId] < 60000) continue;
      const pending = pendingOrderCloses[prevId];
      if (!pending || pending.closeAt <= now) {
        if (pending) delete pendingOrderCloses[prevId];
        continue;
      }
      try {
        const positions = await getPositions(session);
        const scheduledDealIds = new Set(scheduledCloses.map((s) => s.dealId));
        const match = positions.find(
          (p) =>
            p.epic === pending.epic &&
            p.direction === pending.direction &&
            Math.abs((p.size || 0) - pending.size) < 0.001 &&
            !scheduledDealIds.has(p.dealId)
        );
        if (match) {
          const closeDirection = match.direction === 'BUY' ? 'SELL' : 'BUY';
          scheduledCloses.push({
            dealId: match.dealId,
            direction: closeDirection,
            size: match.size || pending.size,
            closeAt: pending.closeAt,
            source: 'order',
          });
          saveScheduledCloses(scheduledCloses);
          emitScheduledCloses(io);
          io.emit('log', 'Order filled: scheduled close added for ' + match.dealId);
          try {
            const sizeNum = match.size ?? pending.size;
            const entry = match.level ?? 0;
            const tx = appendTransactionOpen({
              timestamp: new Date().toISOString(),
              epic: match.epic ?? '',
              instrumentName: match.instrumentName,
              direction: match.direction,
              size: sizeNum,
              entry: typeof entry === 'number' && !isNaN(entry) ? entry : 0,
              currency: match.currency ?? 'GBP',
            });
            io.emit('transaction_added', tx);
          } catch { /* ignore */ }
          await pollAndEmitPositions(session, io, positions);
        }
      } catch {
        /* ignore */
      }
      delete pendingOrderCloses[prevId];
    }
    previousWorkingOrderIds = currentIds;
  } catch {
    io.emit('working_orders', []);
  }
}

async function pollAndEmitPositionsImpl(
  session: IgSession,
  io: Server,
  positionsOverride?: Awaited<ReturnType<typeof getPositions>>
): Promise<Awaited<ReturnType<typeof getPositions>>> {
  try {
    const positions = positionsOverride ?? (await getPositions(session));
    const currentDealIds = new Set(positions.map((p) => p.dealId));
    const now = Date.now();
    for (const prev of previousPositions) {
      const id = prev.dealId;
      if (currentDealIds.has(id)) continue;
      unregisterDynamicStopLoss(id);
      if (recentlyClosedByUs[id] && now - recentlyClosedByUs[id] < RECENTLY_CLOSED_TTL_MS) continue;
      const size = prev.size ?? 0;
      if (size > 0) {
        const closeConf = await enrichCloseConfFromHistory(session, prev, undefined, session.currencyIsoCode);
        await recordTransactionFromPosition(io, session, prev, size, closeConf, session.currencyIsoCode);
        io.emit('log', 'Position closed by IG (TP/SL): ' + id + ' – recorded in transaction log');
      }
    }
    previousPositions = positions;
    for (const id of Object.keys(recentlyClosedByUs)) {
      if (now - recentlyClosedByUs[id] >= RECENTLY_CLOSED_TTL_MS) delete recentlyClosedByUs[id];
    }
    const enriched = positions.map((p) => {
      const sched = scheduledCloses.find((s) => s.dealId === p.dealId);
      return { ...p, closeAt: sched ? new Date(sched.closeAt).toISOString() : undefined };
    });
    io.emit('positions', enriched);
    const cfg = loadConfig();
    const streamEpic = cfg.epic || '';
    if (streamEpic) syncDynamicStopLossWithPositions(positions, streamEpic, cfg);
    onDynamicStopLossPositionPoll(
      session,
      enriched.map((p) => ({
        dealId: p.dealId,
        epic: p.epic,
        bid: p.bid,
        offer: p.offer,
        level: p.level,
        size: p.size,
        contractSize: p.contractSize,
        stopLevel: p.stopLevel,
      })),
      (msg) => io.emit('log', msg)
    );
    io.emit('dynamic_stop_loss_status', getDynamicStopLossStatuses());
    return positions;
  } catch {
    io.emit('positions', []);
    io.emit('dynamic_stop_loss_status', []);
    return [];
  }
}

function pollAndEmitPositions(
  session: IgSession,
  io: Server,
  positionsOverride?: Awaited<ReturnType<typeof getPositions>>
): Promise<Awaited<ReturnType<typeof getPositions>>> {
  const p = pollPositionsChain.then(() => pollAndEmitPositionsImpl(session, io, positionsOverride));
  pollPositionsChain = p.then(() => {}).catch(() => {});
  return p as Promise<Awaited<ReturnType<typeof getPositions>>>;
}

function emitScheduledCloses(io: Server): void {
  io.emit('scheduled_closes', scheduledCloses);
}

type PositionLike = {
  dealId?: string;
  epic: string;
  instrumentName?: string;
  direction: 'BUY' | 'SELL';
  level: number;
  bid?: number;
  offer?: number;
  contractSize?: number;
  currency?: string;
  limitLevel?: number;
  stopLevel?: number;
  /** IG position open time – prefer for transaction log "open" row timestamp. */
  createdAt?: string;
};

function openTxTimestamp(pos: Pick<PositionLike, 'createdAt'>): string {
  const raw = pos.createdAt?.trim();
  if (raw) {
    const t = Date.parse(raw);
    if (!isNaN(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

function inferExitPrice(pos: PositionLike): number {
  const entry = pos.level ?? 0;
  if (pos.direction === 'BUY') {
    if (pos.limitLevel != null && !isNaN(pos.limitLevel)) return pos.limitLevel;
    if (pos.stopLevel != null && !isNaN(pos.stopLevel)) return pos.stopLevel;
    return pos.bid ?? entry;
  } else {
    if (pos.limitLevel != null && !isNaN(pos.limitLevel)) return pos.limitLevel;
    if (pos.stopLevel != null && !isNaN(pos.stopLevel)) return pos.stopLevel;
    return pos.offer ?? entry;
  }
}

type CloseConfirmation = { level?: number; profit?: number; profitCurrency?: string };

/** When confirmation lacks level/profit, fetch from history. When we have profit in deal currency but need
 * conversion and no rate, history may return profit in account currency – prefer that. */
async function enrichCloseConfFromHistory(
  session: IgSession,
  pos: PositionLike,
  closeConf?: CloseConfirmation,
  accountCurrency?: string
): Promise<CloseConfirmation | undefined> {
  const hasConf = closeConf && (typeof closeConf.level === 'number' || typeof closeConf.profit === 'number');
  await new Promise((r) => setTimeout(r, hasConf ? 1500 : 2500));
  try {
    const txs = await getHistoryTransactions(session, { type: 'ALL_DEAL', maxSpanSeconds: 90, pageSize: 30 });
    const iname = (pos.instrumentName || '').toLowerCase();
    const entryLevel = typeof pos.level === 'number' && !isNaN(pos.level) ? pos.level : undefined;
    const candidates = txs.filter(
      (t) =>
        t.closeLevel != null &&
        t.instrumentName &&
        (iname.includes((t.instrumentName || '').toLowerCase()) || (t.instrumentName || '').toLowerCase().includes(iname)) &&
        // Match by openLevel when available: IG history can differ from pos.level by the spread (e.g. offer vs bid).
        (entryLevel == null ||
          (t.openLevel != null && !isNaN(t.openLevel) && Math.abs(t.openLevel - entryLevel) < 10))
    );
    // Pick the history entry with the closest openLevel to avoid wrong match when multiple same-instrument trades close
    const match =
      candidates.length === 0
        ? undefined
        : entryLevel != null
          ? candidates.reduce((best, t) => {
              const d = Math.abs((t.openLevel ?? Infinity) - entryLevel);
              const bestD = Math.abs((best.openLevel ?? Infinity) - entryLevel);
              return d < bestD ? t : best;
            })
          : candidates[0];
    if (match) {
      const histCur = normalizeCurrency(match.currency, accountCurrency);
      const accCur = (accountCurrency || '').trim().toUpperCase();
      if (accCur && histCur === accCur && typeof match.profitAndLoss === 'number' && !isNaN(match.profitAndLoss)) {
        return { level: match.closeLevel, profit: match.profitAndLoss, profitCurrency: histCur };
      }
      if (!hasConf) return { level: match.closeLevel, profit: match.profitAndLoss, profitCurrency: match.currency };
    }
  } catch {
    /* ignore */
  }
  return closeConf;
}

/** IG sometimes returns non-standard codes (e.g. SK for SEK). Normalize for display. */
function normalizeCurrency(raw: string | undefined, accountCurrency?: string): string {
  const c = (raw || accountCurrency || 'GBP').trim().toUpperCase();
  if (c === 'SK') return 'SEK'; // IG may return SK for Swedish Krona
  return c || 'GBP';
}

/**
 * Instrument / deal P&L denomination for FX. Never infer from account currency alone — if we treat
 * the account code as the "instrument" when IG omits market/position currency, we skip conversion
 * and log confirmation P&L (often USD on metals) as bare numbers with a wrong currency label.
 */
function instrumentCurrencyForPnl(
  market: MarketDetails | null,
  pos: PositionLike,
  closeConfirmation: CloseConfirmation | undefined,
  accountCurrency: string | undefined
): string {
  const fromMarket = (market?.currencyCode || '').trim();
  if (fromMarket) return normalizeCurrency(fromMarket, accountCurrency);
  const acc = (accountCurrency || '').trim();
  const accNorm = acc ? normalizeCurrency(acc, accountCurrency) : '';
  const fromPos = (pos.currency || '').trim();
  if (fromPos) {
    const posNorm = normalizeCurrency(fromPos, accountCurrency);
    if (!accNorm || posNorm !== accNorm) return posNorm;
  }
  const fromConf = (closeConfirmation?.profitCurrency || '').trim();
  if (fromConf) return normalizeCurrency(fromConf, accountCurrency);
  return 'GBP';
}

async function recordTransactionFromPosition(
  io: Server,
  session: IgSession,
  pos: PositionLike,
  size: number,
  closeConfirmation?: CloseConfirmation,
  accountCurrency?: string
): Promise<void> {
  const dealIdKey = (pos.dealId || '').trim();
  if (!dealIdKey) return;
  if (loggedClosedDealIds.has(dealIdKey)) return;
  loggedClosedDealIds.add(dealIdKey);
  let persisted = false;
  try {
    const contractSize = pos.contractSize ?? 1;
    const level = pos.level ?? 0;
    const entry = level; // IG position.level is the actual open/fill price
    const exit = (typeof closeConfirmation?.level === 'number' && !isNaN(closeConfirmation.level))
      ? closeConfirmation.level
      : inferExitPrice(pos);
    const rawProfitInDealCurrency =
      pos.direction === 'BUY'
        ? (exit - entry) * size * contractSize
        : (entry - exit) * size * contractSize;

    const market = pos.epic ? await getMarketDetails(session, pos.epic) : null;
    const instrumentCurrency = instrumentCurrencyForPnl(market, pos, closeConfirmation, accountCurrency);
    const accCur = (accountCurrency || '').trim().toUpperCase();
    const rate = market?.exchangeRateToAccount;

    let profitLoss: number;
    let currency: string;

    const igProfit = typeof closeConfirmation?.profit === 'number' && !isNaN(closeConfirmation.profit)
      ? closeConfirmation.profit
      : undefined;
    const igProfitCurrency = closeConfirmation?.profitCurrency
      ? normalizeCurrency(closeConfirmation.profitCurrency, accountCurrency)
      : undefined;

    /** Quote CCY for P&L when raw move matches IG profit (price diff is in quote units, not account). */
    const quoteCurrencyForFx =
      (market?.currencyCode?.trim() && normalizeCurrency(market.currencyCode.trim(), accountCurrency)) ||
      (igProfitCurrency && igProfitCurrency !== accCur ? igProfitCurrency : '') ||
      instrumentCurrency;

    if (igProfit != null) {
      const profitMatchesRaw = Math.abs(igProfit - rawProfitInDealCurrency) < 0.01;
      if (profitMatchesRaw && accCur && quoteCurrencyForFx !== accCur && rate != null && !isNaN(rate) && rate > 0) {
        profitLoss = igProfit * rate;
        currency = accCur;
      } else if (igProfitCurrency === accCur) {
        profitLoss = igProfit;
        currency = accCur;
      } else if (quoteCurrencyForFx !== accCur && rate != null && !isNaN(rate) && rate > 0) {
        profitLoss = igProfit * rate;
        currency = accCur;
      } else {
        profitLoss = igProfit;
        currency = igProfitCurrency || instrumentCurrency;
      }
    } else {
      profitLoss = rawProfitInDealCurrency;
      currency = instrumentCurrency;
      if (accCur && instrumentCurrency !== accCur && rate != null && !isNaN(rate) && rate > 0) {
        profitLoss = profitLoss * rate;
        currency = accCur;
      }
    }

    const tx = appendTransaction({
      timestamp: new Date().toISOString(),
      type: 'closed',
      dealId: dealIdKey,
      epic: pos.epic ?? '',
      instrumentName: pos.instrumentName,
      direction: pos.direction,
      size,
      entry,
      exit,
      profitLoss,
      currency,
    });
    persisted = true;
    if (tx) io.emit('transaction_added', tx);
  } catch {
    if (!persisted) loggedClosedDealIds.delete(dealIdKey);
    /* ignore – transaction log is best-effort */
  }
}

async function fetchAndEmitProbesBackfill(session: IgSession, epic: string, io: Server): Promise<void> {
  const now = Date.now();
  if (lastBackfillCache && lastBackfillCache.epic === epic && now - lastBackfillCache.at < BACKFILL_CACHE_TTL_MS) {
    io.emit('probes_backfill', { samples: lastBackfillCache.samples, allowance: lastBackfillCache.allowance });
    io.emit('log', 'Probes backfill: served from cache (avoid duplicate request within 60s)');
    return;
  }
  const cfg = loadConfig();
  const maxDays = cfg.ui?.probesBackfillDays ?? 30;
  if (maxDays <= 0) {
    io.emit('probes_backfill_error', 'Backfill disabled (probesBackfillDays ≤ 0 in config)');
    io.emit('log', 'Probes backfill: disabled (probesBackfillDays ≤ 0)');
    return;
  }
  const short = cfg.ui?.probesShortPeriod ?? 5;
  const medium = cfg.ui?.probesMediumPeriod ?? 60;
  const long = cfg.ui?.probesLongPeriod ?? 1440;
  const longestMinutes = Math.max(short, medium, long);
  const days = Math.min(Math.max(1, Math.ceil(longestMinutes / (24 * 60))), maxDays);
  try {
    const { samples, allowance } = await getHistoricalPrices(session, epic, { resolution: 'HOUR', days });
    lastBackfillCache = { epic, at: Date.now(), samples, allowance };
    const used = samples.length;
    const { total, remaining, expirySeconds } = allowance;
    const pct = total > 0 ? ((total - remaining) / total * 100).toFixed(1) : '?';
    io.emit('probes_backfill', { samples, allowance: { total, remaining, expirySeconds } });
    io.emit('log', `Probes backfill: ${used} points (${days}d). IG quota: ${remaining}/${total} remaining (${pct}% used this period, resets in ${expirySeconds}s)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isQuotaExceeded = /exceeded-account-historical-data-allowance|allowance/i.test(msg);
    const userMsg = isQuotaExceeded
      ? 'IG historical data allowance exhausted. Try again after the quota resets.'
      : msg;
    io.emit('probes_backfill_error', userMsg);
    io.emit('log', 'Probes backfill: ' + msg);
  }
}

function persistAndRunScheduler(session: IgSession, io: Server): void {
  saveScheduledCloses(scheduledCloses);
  emitScheduledCloses(io);
  if (closeSchedulerTimer) return;
  closeSchedulerTimer = setInterval(async () => {
    const now = Date.now();
    const toRun = scheduledCloses.filter((s) => now >= s.closeAt);
    scheduledCloses = scheduledCloses.filter((s) => now < s.closeAt);
    saveScheduledCloses(scheduledCloses);
    emitScheduledCloses(io);
    for (const s of toRun) {
      try {
        let posBeforeClose: Awaited<ReturnType<typeof getPositions>>[number] | undefined;
        try {
          const positions = await getPositions(session);
          posBeforeClose = positions.find((p) => p.dealId === s.dealId);
        } catch {
          /* ignore */
        }
        recentlyClosedByUs[s.dealId] = Date.now();
        const closeResult = await closePosition(session, { dealId: s.dealId, direction: s.direction, size: s.size });
        let closeConf: CloseConfirmation | undefined;
        try {
          const conf = await pollDealConfirmation(session, closeResult.dealReference, { maxAttempts: 15, intervalMs: 300 });
          if (conf?.dealStatus === 'ACCEPTED') closeConf = { level: conf.level, profit: conf.profit, profitCurrency: conf.profitCurrency };
        } catch { /* ignore */ }
        if (posBeforeClose) {
          closeConf = await enrichCloseConfFromHistory(session, posBeforeClose, closeConf, session.currencyIsoCode);
          await recordTransactionFromPosition(io, session, posBeforeClose, s.size, closeConf, session.currencyIsoCode);
        }
        io.emit('log', 'Position closed at scheduled time: ' + s.dealId);
        io.emit('position_closed', { dealId: s.dealId });
        await pollAndEmitPositions(session, io);
      } catch (err) {
        delete recentlyClosedByUs[s.dealId];
        const msg = err instanceof Error ? err.message : 'Close failed';
        io.emit('log', 'Scheduled close error: ' + msg);
      }
    }
    if (scheduledCloses.length === 0 && closeSchedulerTimer) {
      clearInterval(closeSchedulerTimer);
      closeSchedulerTimer = null;
    }
  }, 5000);
}

async function runOverdueCloses(session: IgSession, io: Server): Promise<void> {
  const now = Date.now();
  const toRun = scheduledCloses.filter((s) => now >= s.closeAt);
  scheduledCloses = scheduledCloses.filter((s) => now < s.closeAt);
  saveScheduledCloses(scheduledCloses);
  emitScheduledCloses(io);
  for (const s of toRun) {
    try {
      let posBeforeClose: Awaited<ReturnType<typeof getPositions>>[number] | undefined;
      try {
        const positions = await getPositions(session);
        posBeforeClose = positions.find((p) => p.dealId === s.dealId);
      } catch {
        /* ignore */
      }
      recentlyClosedByUs[s.dealId] = Date.now();
      const closeResult = await closePosition(session, { dealId: s.dealId, direction: s.direction, size: s.size });
      let closeConf: CloseConfirmation | undefined;
      try {
        const conf = await pollDealConfirmation(session, closeResult.dealReference, { maxAttempts: 15, intervalMs: 300 });
        if (conf?.dealStatus === 'ACCEPTED') closeConf = { level: conf.level, profit: conf.profit, profitCurrency: conf.profitCurrency };
      } catch { /* ignore */ }
      if (posBeforeClose) {
        closeConf = await enrichCloseConfFromHistory(session, posBeforeClose, closeConf, session.currencyIsoCode);
        await recordTransactionFromPosition(io, session, posBeforeClose, s.size, closeConf, session.currencyIsoCode);
      }
      io.emit('log', 'Position closed (overdue): ' + s.dealId);
      io.emit('position_closed', { dealId: s.dealId });
      await pollAndEmitPositions(session, io);
    } catch (err) {
      delete recentlyClosedByUs[s.dealId];
      const msg = err instanceof Error ? err.message : 'Close failed';
      io.emit('log', 'Scheduled close error: ' + msg);
    }
  }
}

type EngineStatus = 'ready' | 'running' | 'stopped';

function accountToClient(session: IgSession) {
  const cfg = loadConfig();
  return {
    accountId: session.accountId,
    accountType: session.accountType,
    accountName: session.accountName,
    currencyIsoCode: session.currencyIsoCode,
    reroutingEnvironment: session.reroutingEnvironment,
    activeProfile: cfg.activeProfile || 'demo',
  };
}

export function registerSocketHandlers(io: Server): void {
  let engineStatus: EngineStatus = 'ready';
  let currentSession: IgSession | null = null;
  /** Lightstreamer can fire far faster than 1 Hz; throttling socket emits avoids starving the ping/pong and the browser main thread. */
  let lastPriceSocketEmitTs = 0;
  const PRICE_SOCKET_EMIT_MIN_MS = 100;

  function doStop(logMsg?: string): void {
    lastPriceSocketEmitTs = 0;
    loggedClosedDealIds.clear();
    stopStream();
    currentSession = null;
    scheduledCloses = [];
    previousPositions = [];
    previousWorkingOrderIds = new Set();
    for (const k of Object.keys(pendingOrderCloses)) delete pendingOrderCloses[k];
    if (closeSchedulerTimer) {
      clearInterval(closeSchedulerTimer);
      closeSchedulerTimer = null;
    }
    if (positionsPollTimer) {
      clearInterval(positionsPollTimer);
      positionsPollTimer = null;
    }
    if (ordersPollTimer) {
      clearInterval(ordersPollTimer);
      ordersPollTimer = null;
    }
    clearDynamicStopLossTracking();
    engineStatus = 'stopped';
    io.emit('status', engineStatus);
    io.emit('account', null);
    io.emit('price_update', null);
    io.emit('positions', []);
    io.emit('working_orders', []);
    io.emit('scheduled_closes', []);
    io.emit('dynamic_stop_loss_status', []);
    if (recordingStatusTimer) {
      clearInterval(recordingStatusTimer);
      recordingStatusTimer = null;
    }
    stopRecording();
    emitRecordingStatus(io);
    updateSleepPrevention(io, false);
    io.emit('log', logMsg || 'Stopped');
  }

  setOnProfileChangeListener(() => doStop('Account switched – click Start to connect with new credentials'));

  io.on('connection', async (socket: Socket) => {
    io.emit('log', 'Client connected: ' + socket.id);
    const cfg = loadConfig();
    socket.emit('status', engineStatus);
    if (currentSession) {
      socket.emit('account', accountToClient(currentSession));
      try {
        const positions = await getPositions(currentSession);
        socket.emit('positions', positions);
      } catch {
        socket.emit('positions', []);
      }
      try {
        await pollAndEmitWorkingOrders(currentSession, io);
      } catch {
        socket.emit('working_orders', []);
      }
      socket.emit('scheduled_closes', scheduledCloses);
      const epic = cfg.epic || '';
      if (epic) {
        try {
          const [market, trading, dayStartBuy, clientSentiment] = await Promise.all([
            getMarketDetails(currentSession, epic),
            getMarketTradingInfo(currentSession, epic).catch(() => ({ defaultCloseAt: null, is24_7: false })),
            getDayStartPrice(currentSession, epic).catch(() => null),
            getClientSentiment(currentSession, epic, {
              debugLog: (msg) => io.emit('log', msg),
            }).catch((err) => {
              io.emit('log', 'Sentiment: ' + (err?.message || err));
              return null;
            }),
          ]);
          if (clientSentiment) {
            io.emit('log', 'Sentiment: ' + clientSentiment.longPct + '% long / ' + clientSentiment.shortPct + '% short');
          }
          lastClientSentimentByEpic[epic] = clientSentiment ?? null;
          socket.emit('marketDetails', { epic, minDealSize: market?.minDealSize ?? null, currencyCode: market?.currencyCode ?? null, contractSize: market?.contractSize ?? null, marginFactor: market?.marginFactor ?? null, lotSize: market?.lotSize ?? null, valueOfOnePip: market?.valueOfOnePip ?? null, scalingFactor: market?.scalingFactor ?? null, exchangeRateToAccount: market?.exchangeRateToAccount ?? null, defaultCloseAt: trading.defaultCloseAt, is24_7: trading.is24_7, dayStartBuy: dayStartBuy ?? null, clientSentiment: clientSentiment ?? null });
        } catch {
          lastClientSentimentByEpic[epic] = null;
          socket.emit('marketDetails', { epic, minDealSize: null, currencyCode: null, contractSize: null, marginFactor: null, lotSize: null, valueOfOnePip: null, scalingFactor: null, exchangeRateToAccount: null, defaultCloseAt: null, is24_7: false, dayStartBuy: null, clientSentiment: null });
        }
      }
    }
    socket.emit('epic', cfg.epic || '');
    socket.emit('watchlistId', cfg.watchlistId || '');
    emitRecordingStatus(io);
    updateSleepPrevention(io, currentSession !== null);

    socket.on('rules_engine_running', (running: boolean) => {
      rulesEngineRunningBySocket.set(socket.id, !!running);
    });

    socket.on('disconnect', () => {
      io.emit('log', 'Client disconnected: ' + socket.id);
      rulesEngineRunningBySocket.delete(socket.id);
      const cancel = activeAnalyseBySocket.get(socket.id);
      if (cancel) {
        activeAnalyseBySocket.delete(socket.id);
        cancel('Cancelled');
      }
    });

    socket.on('start', async () => {
      if (engineStatus === 'running') return;
      try {
        socket.emit('status', 'connecting');
        io.emit('log', 'Connecting to IG...');
        const session = await createSession();
        currentSession = session;
        engineStatus = 'running';
        io.emit('status', engineStatus);
        io.emit('account', accountToClient(session));
        const cfg = loadConfig();
        io.emit('epic', cfg.epic || '');
        io.emit('watchlistId', cfg.watchlistId || '');
        io.emit('log', 'Logged in: ' + session.accountId + ' (' + session.accountType + ')');
        scheduledCloses = loadScheduledCloses();
        await runOverdueCloses(session, io);
        let positions: Awaited<ReturnType<typeof getPositions>> = [];
        try {
          positions = await pollAndEmitPositions(session, io);
        } catch {
          io.emit('positions', []);
        }
        const openDealIds = new Set(positions.map((p) => p.dealId));
        const before = scheduledCloses.length;
        scheduledCloses = scheduledCloses.filter((s) => openDealIds.has(s.dealId));
        if (scheduledCloses.length !== before) {
          saveScheduledCloses(scheduledCloses);
          if (before > 0 && scheduledCloses.length === 0) {
            io.emit('log', 'Cleared stale scheduled closes (no open positions)');
          }
        }
        io.emit('scheduled_closes', scheduledCloses);
        if (positionsPollTimer) clearInterval(positionsPollTimer);
        positionsPollTimer = setInterval(() => {
          if (currentSession) pollAndEmitPositions(currentSession, io);
        }, 15000);
        try {
          await pollAndEmitWorkingOrders(session, io);
        } catch {
          io.emit('working_orders', []);
        }
        if (ordersPollTimer) clearInterval(ordersPollTimer);
        ordersPollTimer = setInterval(() => {
          if (currentSession) pollAndEmitWorkingOrders(currentSession, io);
        }, 15000);
        if (scheduledCloses.length > 0) {
          persistAndRunScheduler(session, io);
          io.emit('log', 'Scheduled closes loaded: ' + scheduledCloses.length);
        }
        const epic = cfg.epic || 'CS.D.CFDGOLD.CFD.IP';
        try {
          getClientSentiment(session, epic, { debugLog: (msg) => io.emit('log', msg) })
            .then((s) => { lastClientSentimentByEpic[epic] = s ?? null; })
            .catch(() => { lastClientSentimentByEpic[epic] = null; });
          startStream(
          session,
          epic,
          (data) => {
            const cfg = loadConfig();
            if (cfg.epic && isRecording()) {
              if (recordPrice(cfg.epic, data, lastClientSentimentByEpic[cfg.epic] ?? null)) {
                io.emit('recorded_sample', { epic: cfg.epic, ts: Date.now(), bid: data.bid, offer: data.offer, spread: data.spread });
              }
            }
            const now = Date.now();
            if (now - lastPriceSocketEmitTs < PRICE_SOCKET_EMIT_MIN_MS) return;
            lastPriceSocketEmitTs = now;
            io.emit('price_update', data);
            if (currentSession && data && typeof data.bid === 'number' && typeof data.offer === 'number') {
              const epicNow = loadConfig().epic || epic;
              onDynamicStopLossPriceTick(
                currentSession,
                epicNow,
                data.bid,
                data.offer,
                (msg) => io.emit('log', msg)
              );
              io.emit('dynamic_stop_loss_status', getDynamicStopLossStatuses());
            }
          },
          (msg) => io.emit('log', msg)
        );
          io.emit('log', 'Streaming: ' + epic);
        } catch (streamErr) {
          const msg = streamErr instanceof Error ? streamErr.message : 'Stream failed';
          io.emit('log', 'Stream: ' + msg);
        }
        updateSleepPrevention(io, true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Login failed';
        io.emit('log', 'Error: ' + msg);
        socket.emit('login_error', msg);
        engineStatus = 'ready';
        socket.emit('status', engineStatus);
      }
    });

    socket.on('stop', () => doStop());

    socket.on('getWatchlists', async () => {
      if (!currentSession) {
        socket.emit('watchlists_error', 'Not logged in');
        return;
      }
      try {
        const watchlists = await listWatchlists(currentSession);
        socket.emit('watchlists', watchlists);
        io.emit('log', 'Watchlists loaded: ' + watchlists.length);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to load watchlists';
        socket.emit('watchlists_error', msg);
      }
    });

    socket.on('getEpics', async (watchlistId: string) => {
      if (!currentSession) {
        socket.emit('epics_error', 'Not logged in');
        return;
      }
      if (!watchlistId || !watchlistId.trim()) {
        socket.emit('epics', []);
        return;
      }
      try {
        const epics = await getWatchlistEpics(currentSession, watchlistId);
        socket.emit('epics', epics);
        io.emit('log', 'Epics loaded: ' + epics.length);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to load epics';
        socket.emit('epics_error', msg);
      }
    });

    socket.on('setEpic', async (epic: string) => {
      updateConfig({ epic: epic || undefined });
      io.emit('epic', epic);
      io.emit('log', 'Epic set: ' + (epic || '—'));
      if (currentSession && epic) {
        try {
          const [market, trading, dayStartBuy, clientSentiment] = await Promise.all([
            getMarketDetails(currentSession, epic),
            getMarketTradingInfo(currentSession, epic).catch(() => ({ defaultCloseAt: null, is24_7: false })),
            getDayStartPrice(currentSession, epic).catch(() => null),
            getClientSentiment(currentSession, epic, {
              debugLog: (msg) => io.emit('log', msg),
            }).catch((err) => {
              io.emit('log', 'Sentiment: ' + (err?.message || err));
              return null;
            }),
          ]);
          if (clientSentiment) {
            io.emit('log', 'Sentiment: ' + clientSentiment.longPct + '% long / ' + clientSentiment.shortPct + '% short');
          }
          lastClientSentimentByEpic[epic] = clientSentiment ?? null;
          const payload = {
            epic,
            minDealSize: market?.minDealSize ?? null,
            currencyCode: market?.currencyCode || null,
            contractSize: market?.contractSize ?? null,
            marginFactor: market?.marginFactor ?? null,
            lotSize: market?.lotSize ?? null,
            valueOfOnePip: market?.valueOfOnePip ?? null,
            scalingFactor: market?.scalingFactor ?? null,
            exchangeRateToAccount: market?.exchangeRateToAccount ?? null,
            defaultCloseAt: trading.defaultCloseAt,
            is24_7: trading.is24_7,
            dayStartBuy: dayStartBuy ?? null,
            clientSentiment: clientSentiment ?? null,
          };
          io.emit('marketDetails', payload);
        } catch {
          lastClientSentimentByEpic[epic] = null;
          io.emit('marketDetails', { epic, minDealSize: null, currencyCode: null, contractSize: null, marginFactor: null, lotSize: null, valueOfOnePip: null, scalingFactor: null, exchangeRateToAccount: null, defaultCloseAt: null, is24_7: false, dayStartBuy: null, clientSentiment: null });
        }
      } else {
        if (epic) lastClientSentimentByEpic[epic] = null;
        io.emit('marketDetails', { epic: epic || '', minDealSize: null, currencyCode: null, contractSize: null, marginFactor: null, lotSize: null, valueOfOnePip: null, scalingFactor: null, exchangeRateToAccount: null, defaultCloseAt: null, is24_7: false, dayStartBuy: null, clientSentiment: null });
      }
      if (isStreaming() && epic) {
        try {
          switchEpic(epic);
        } catch (err) {
          io.emit('log', 'Stream switch failed: ' + (err instanceof Error ? err.message : ''));
        }
      }
      emitRecordingStatus(io);
    });

    socket.on('setWatchlist', (watchlistId: string) => {
      updateConfig({ watchlistId: watchlistId || undefined });
      io.emit('watchlistId', watchlistId);
      io.emit('log', 'Watchlist set: ' + (watchlistId || '—'));
    });

    socket.on('probes_backfill_request', async () => {
      const epic = loadConfig().epic;
      if (!currentSession || !epic) {
        io.emit('probes_backfill_error', 'Not connected or no instrument selected');
        return;
      }
      try {
        await fetchAndEmitProbesBackfill(currentSession, epic, io);
      } catch {
        io.emit('probes_backfill_error', 'Backfill failed');
      }
    });

    socket.on('recording_start', () => {
      const epic = loadConfig().epic;
      if (!isStreaming() || !epic) {
        io.emit('log', 'Recording: need streaming and an instrument selected');
        emitRecordingStatus(io);
        return;
      }
      startRecording();
      if (recordingStatusTimer) clearInterval(recordingStatusTimer);
      recordingStatusTimer = setInterval(() => emitRecordingStatus(io), 10000);
      emitRecordingStatus(io);
      io.emit('log', 'Recording started: ' + epic);
    });

    socket.on('recording_stop', () => {
      stopRecording();
      if (recordingStatusTimer) {
        clearInterval(recordingStatusTimer);
        recordingStatusTimer = null;
      }
      emitRecordingStatus(io);
      io.emit('log', 'Recording stopped');
    });

    socket.on('recording_status_request', () => {
      emitRecordingStatus(io);
    });

    socket.on('get_recorded_days', (_epic: string) => {
      // Return days for ALL epics so UI can show them with clear labels
      const dayStats = getAllDayStats();
      const days = dayStats.map((s) => s.day);
      const epicsWithData = getEpicsWithData();
      socket.emit('recorded_days', { dayStats, days, epicsWithData, allEpics: true });
    });

    /** Mid/bid/offer series for trade chart (Test rules modal). Downsampled if huge. */
    socket.on('trade_chart_samples', (params: { epic?: string; fromTs?: number; toTs?: number; days?: string[]; reqId?: number }) => {
      const reqId = typeof params?.reqId === 'number' ? params.reqId : 0;
      const epic = (params?.epic || '').trim();
      const days = Array.isArray(params?.days) ? params.days.filter((d) => typeof d === 'string' && d.length > 0) : [];
      const fromTs = params?.fromTs;
      const toTs = params?.toTs;
      if (!epic) {
        socket.emit('trade_chart_samples_result', { reqId, error: 'Invalid epic' });
        return;
      }
      const MAX_POINTS = 8000;
      let raw: ReturnType<typeof getRecordedSamplesFiltered>;
      if (days.length > 0) {
        raw = getRecordedSamplesFiltered(epic, { days });
      } else if (
        typeof fromTs === 'number' &&
        typeof toTs === 'number' &&
        Number.isFinite(fromTs) &&
        Number.isFinite(toTs) &&
        toTs >= fromTs
      ) {
        raw = getRecordedSamplesFiltered(epic, { fromTs, toTs });
      } else {
        socket.emit('trade_chart_samples_result', { reqId, error: 'Invalid epic or time range' });
        return;
      }
      if (raw.length === 0) {
        socket.emit('trade_chart_samples_result', { reqId, samples: [], count: 0, thinned: false });
        return;
      }
      type Pt = { ts: number; mid: number; bid: number; offer: number };
      const points: Pt[] = raw.map((s) => ({
        ts: s.ts,
        mid: (s.bid + s.offer) / 2,
        bid: s.bid,
        offer: s.offer,
      }));
      let thinned = false;
      let out = points;
      if (points.length > MAX_POINTS) {
        thinned = true;
        const step = Math.ceil(points.length / MAX_POINTS);
        out = [];
        for (let i = 0; i < points.length; i += step) out.push(points[i]);
        const last = points[points.length - 1];
        if (out[out.length - 1].ts !== last.ts) out.push(last);
      }
      socket.emit('trade_chart_samples_result', { reqId, samples: out, count: raw.length, thinned });
    });

    socket.on('delete_recorded_days', (params: { epic?: string; days?: string[]; items?: string[] }) => {
      // Support items: ['day|epic', ...] for multi-epic, or legacy epic + days
      let toDelete: Array<{ epic: string; days: string[] }> = [];
      const items = Array.isArray(params?.items) ? params.items : [];
      if (items.length > 0) {
        const byEpic: Record<string, string[]> = {};
        for (const item of items) {
          const pipe = typeof item === 'string' ? item.indexOf('|') : -1;
          const [day, epic] = pipe >= 0 ? [item.slice(0, pipe), item.slice(pipe + 1)] : [item, ''];
          if (day && epic) {
            if (!byEpic[epic]) byEpic[epic] = [];
            byEpic[epic].push(day);
          }
        }
        toDelete = Object.entries(byEpic).map(([epic, days]) => ({ epic, days }));
      } else {
        const epic = (params?.epic || '').trim();
        const days = Array.isArray(params?.days) ? params.days : [];
        if (epic && days.length > 0) toDelete = [{ epic, days }];
      }
      if (toDelete.length === 0) {
        socket.emit('delete_recorded_days_result', { error: 'Select days to delete (items or epic+days required)' });
        return;
      }
      let totalDeleted = 0;
      const daysRemoved: string[] = [];
      for (const { epic, days } of toDelete) {
        totalDeleted += deleteSamplesByDays(epic, days);
        daysRemoved.push(...days.map((d) => d + '|' + epic));
      }
      socket.emit('delete_recorded_days_result', { deleted: totalDeleted, daysRemoved, recordedCount: null });
    });

    socket.on('prune_sparse_days', (params: { epic: string; minCount: number }) => {
      const epic = (params?.epic || '').trim();
      const minCount = typeof params?.minCount === 'number' && params.minCount >= 0 ? params.minCount : 0;
      if (!epic) {
        socket.emit('prune_sparse_days_result', { error: 'Epic required' });
        return;
      }
      const { deleted, daysRemoved } = deleteSparseDays(epic, minCount);
      socket.emit('prune_sparse_days_result', { deleted, daysRemoved, recordedCount: getRecordedSampleCount(epic) });
    });

    socket.on('analyse_recording', async (params: {
      epic: string;
      intradayOnly?: boolean;
      fromDate?: string | null;
      toDate?: string | null;
      selectedDays?: string[];
      rules?: Array<{ left: string; op: string; right: string; enabled?: boolean }>;
      ruleSets?: Array<{ direction: 'BUY' | 'SELL'; rules: Array<{ left: string; op: string; right: string; enabled?: boolean }>; takeProfit?: string | null; stopLoss?: string | null; tpSlMode?: string; dealSize?: string }>;
      backtestRuleSets?: ('BUY' | 'SELL')[];
      probeShortMinutes: number;
      probeMediumMinutes: number;
      probeLongMinutes: number;
      is24_7: boolean;
      takeProfit?: string | null;
      stopLoss?: string | null;
      tpSlMode?: 'value' | 'rate' | 'pct';
      dealSize?: string;
      contractSize?: number;
      dynamicSlBuy?: DynamicStopLossOverride;
      dynamicSlSell?: DynamicStopLossOverride;
      stopAfterLossBuy?: boolean;
      stopAfterLossSell?: boolean;
      autoStopEnabledBuy?: boolean;
      autoStopEnabledSell?: boolean;
      autoStopBeforeMinutesBuy?: number;
      autoStopBeforeMinutesSell?: number;
      pauseOnLossSecondsBuy?: number;
      pauseOnLossSecondsSell?: number;
    }) => {
      const epic = (params?.epic || '').trim();
      if (!epic) {
        socket.emit('analyse_recording_report', { error: 'No epic specified' });
        return;
      }
      const fromDate = params?.fromDate?.trim();
      const toDate = params?.toDate?.trim();
      const selectedDaysRaw = Array.isArray(params?.selectedDays) ? params.selectedDays : null;
      const selectedDays = selectedDaysRaw
        ? Array.from(new Set(selectedDaysRaw.map((d) => (d || '').trim()).filter(Boolean))).sort()
        : null;
      const intradayOnly = params.intradayOnly !== false;
      const dateFilterUsed = !!(fromDate || toDate || (selectedDays && selectedDays.length > 0));
      const noDataMsgSuffix = dateFilterUsed ? ' in date range' : '';
      const MAX_CARRYOVER_SAMPLES = 150000;
      const usePerDay = intradayOnly;
      const cfg = loadConfig();
      const inst = epic && cfg.ui?.instruments?.[epic] ? cfg.ui.instruments[epic] : null;
      const defaultDealSize = params.dealSize ?? inst?.dealSize ?? cfg.ui?.dealSize ?? cfg.defaultSize ?? '1';

      const ruleSets = Array.isArray(params.ruleSets) ? params.ruleSets : undefined;
      const backtestRuleSets = Array.isArray(params.backtestRuleSets) ? params.backtestRuleSets : undefined;
      const useRuleSets = ruleSets && ruleSets.length > 0 && backtestRuleSets && backtestRuleSets.length > 0;

      let dealingWeekLondon: ReturnType<typeof dealingWeekFromMarketTimes> = null;
      let apiIs24_7 = false;
      let dealingScheduleSource: 'ig' | 'default' | 'off' = 'off';
      if (currentSession) {
        try {
          const info = await getMarketTradingInfo(currentSession, epic);
          apiIs24_7 = info.is24_7;
          dealingWeekLondon = dealingWeekFromMarketTimes(info.marketTimes, info.is24_7);
          if (dealingWeekLondon) dealingScheduleSource = 'ig';
        } catch {
          /* use fallback below when not 24/7 */
        }
      }
      const effectiveIs24_7 = currentSession ? apiIs24_7 : !!params.is24_7;
      if (effectiveIs24_7) {
        dealingWeekLondon = null;
        dealingScheduleSource = 'off';
      } else if (!dealingWeekLondon) {
        dealingWeekLondon = defaultDealingWeekLondonMonFri();
        dealingScheduleSource = 'default';
      }

      const ui = cfg.ui;
      const resolveAutoStopEnabled = (
        instVal: boolean | undefined,
        legacyInst: boolean | undefined,
        uiSide: boolean | undefined,
        uiLegacy: boolean | undefined
      ): boolean => {
        if (instVal != null) return instVal !== false;
        if (legacyInst != null) return legacyInst !== false;
        if (uiSide != null) return uiSide !== false;
        if (uiLegacy != null) return uiLegacy !== false;
        return true;
      };
      const resolveAutoStopMinutes = (
        instVal: number | undefined,
        legacyInst: number | undefined,
        uiSide: number | undefined,
        uiLegacy: number | undefined
      ): number => {
        const pick = instVal ?? legacyInst ?? uiSide ?? uiLegacy;
        return typeof pick === 'number' && !isNaN(pick) && pick >= 0 ? Math.min(pick, 1440) : 60;
      };

      const resolvePauseOnLossSeconds = (
        instVal: number | undefined,
        legacyInst: number | undefined,
        uiLegacy: number | undefined
      ): number => {
        const pick = instVal ?? legacyInst ?? uiLegacy;
        if (typeof pick !== 'number' || isNaN(pick) || pick < 0) return 0;
        return Math.min(pick, 86400);
      };

      const config: BacktestConfig = {
        rules: useRuleSets ? undefined : (Array.isArray(params.rules) ? params.rules : []),
        ruleSets: useRuleSets ? (ruleSets as RuleSetConfig[]) : undefined,
        backtestRuleSets: useRuleSets ? backtestRuleSets : undefined,
        probeShortMinutes: typeof params.probeShortMinutes === 'number' ? params.probeShortMinutes : 5,
        probeMediumMinutes: typeof params.probeMediumMinutes === 'number' ? params.probeMediumMinutes : 60,
        probeLongMinutes: typeof params.probeLongMinutes === 'number' ? params.probeLongMinutes : 1440,
        is24_7: effectiveIs24_7,
        takeProfit: params.takeProfit ?? inst?.dealTakeProfit ?? cfg.ui?.dealTakeProfit ?? null,
        stopLoss: params.stopLoss ?? inst?.dealStopLoss ?? cfg.ui?.dealStopLoss ?? null,
        tpSlMode: params.tpSlMode ?? (inst?.dealTpSlMode ?? cfg.ui?.dealTpSlMode ?? 'rate') as 'value' | 'rate' | 'pct',
        dealSize: defaultDealSize,
        contractSize: typeof params.contractSize === 'number' ? params.contractSize : 1,
        dealingWeekLondon,
        dynamicStopLossBuy: resolveDynamicStopLossForBacktest(epic, cfg, 'rules-buy', params.dynamicSlBuy),
        dynamicStopLossSell: resolveDynamicStopLossForBacktest(epic, cfg, 'rules-sell', params.dynamicSlSell),
        stopAfterLossBuy: typeof params.stopAfterLossBuy === 'boolean'
          ? params.stopAfterLossBuy
          : (inst?.tradingRulesStopAfterLossBuy ?? ui?.tradingRulesStopAfterLossBuy) === true,
        stopAfterLossSell: typeof params.stopAfterLossSell === 'boolean'
          ? params.stopAfterLossSell
          : (inst?.tradingRulesStopAfterLossSell ?? ui?.tradingRulesStopAfterLossSell) === true,
        autoStopEnabledBuy: typeof params.autoStopEnabledBuy === 'boolean'
          ? params.autoStopEnabledBuy
          : resolveAutoStopEnabled(
              inst?.tradingRulesAutoStopEnabledBuy,
              inst?.tradingRulesAutoStopEnabled,
              ui?.tradingRulesAutoStopEnabledBuy,
              ui?.tradingRulesAutoStopEnabled
            ),
        autoStopEnabledSell: typeof params.autoStopEnabledSell === 'boolean'
          ? params.autoStopEnabledSell
          : resolveAutoStopEnabled(
              inst?.tradingRulesAutoStopEnabledSell,
              inst?.tradingRulesAutoStopEnabled,
              ui?.tradingRulesAutoStopEnabledSell,
              ui?.tradingRulesAutoStopEnabled
            ),
        autoStopBeforeMinutesBuy: typeof params.autoStopBeforeMinutesBuy === 'number'
          ? Math.min(Math.max(params.autoStopBeforeMinutesBuy, 0), 1440)
          : resolveAutoStopMinutes(
              inst?.tradingRulesAutoStopBeforeMinutesBuy,
              inst?.tradingRulesAutoStopBeforeMinutes,
              ui?.tradingRulesAutoStopBeforeMinutesBuy,
              ui?.tradingRulesAutoStopBeforeMinutes
            ),
        autoStopBeforeMinutesSell: typeof params.autoStopBeforeMinutesSell === 'number'
          ? Math.min(Math.max(params.autoStopBeforeMinutesSell, 0), 1440)
          : resolveAutoStopMinutes(
              inst?.tradingRulesAutoStopBeforeMinutesSell,
              inst?.tradingRulesAutoStopBeforeMinutes,
              ui?.tradingRulesAutoStopBeforeMinutesSell,
              ui?.tradingRulesAutoStopBeforeMinutes
            ),
        pauseOnLossSecondsBuy: typeof params.pauseOnLossSecondsBuy === 'number'
          ? Math.min(Math.max(params.pauseOnLossSecondsBuy, 0), 86400)
          : resolvePauseOnLossSeconds(
              inst?.tradingRulesPauseOnLossSecondsBuy,
              inst?.tradingRulesPauseOnLossSeconds,
              ui?.tradingRulesPauseOnLossSeconds
            ),
        pauseOnLossSecondsSell: typeof params.pauseOnLossSecondsSell === 'number'
          ? Math.min(Math.max(params.pauseOnLossSecondsSell, 0), 86400)
          : resolvePauseOnLossSeconds(
              inst?.tradingRulesPauseOnLossSecondsSell,
              inst?.tradingRulesPauseOnLossSeconds,
              ui?.tradingRulesPauseOnLossSeconds
            ),
      };

      function getDaysToAnalyse(): string[] {
        if (selectedDays && selectedDays.length > 0) return selectedDays;
        const allDays = getRecordedDays(epic);
        if (!fromDate && !toDate) return allDays;
        return allDays.filter((d) => {
          if (fromDate && d < fromDate) return false;
          if (toDate && d > toDate) return false;
          return true;
        });
      }

      function blockerRowKey(row: Pick<RuleBlockerCountRow, 'left' | 'op' | 'right'> & { direction?: 'BUY' | 'SELL' }): string {
        return row.direction
          ? `${row.direction}\u0001${row.left}\u0001${row.op}\u0001${row.right}`
          : `legacy\u0001${row.left}\u0001${row.op}\u0001${row.right}`;
      }

      function parseBlockerAggregateKey(key: string): Omit<RuleBlockerCountRow, 'soleBlockerCount'> | null {
        const parts = key.split('\u0001');
        if (parts.length !== 4) return null;
        const [tag, left, op, right] = parts;
        if (tag === 'legacy') return { left, op, right };
        if (tag === 'BUY' || tag === 'SELL') return { left, op, right, direction: tag };
        return null;
      }

      function mergeBlockerAggregateMap(blockerAggregate: Map<string, number>): RuleBlockerCountRow[] {
        const out: RuleBlockerCountRow[] = [];
        for (const [key, count] of blockerAggregate.entries()) {
          if (count <= 0) continue;
          const parsed = parseBlockerAggregateKey(key);
          if (!parsed) continue;
          out.push({ ...parsed, soleBlockerCount: count });
        }
        out.sort((a, b) => b.soleBlockerCount - a.soleBlockerCount);
        return out;
      }

      function buildAnalysedDaySummariesFromTrades(
        days: string[],
        trades: BacktestReport['trades'],
        pnlDenom: number
      ): BacktestDaySummary[] {
        const tradesByDay = new Map<string, BacktestReport['trades']>();
        for (const t of trades) {
          const day = dayKeyFromTimestamp(t.entryTs);
          const list = tradesByDay.get(day);
          if (list) list.push(t);
          else tradesByDay.set(day, [t]);
        }
        return days.map((day) => {
          const sampleCount = getRecordedSamplesFiltered(epic, { days: [day] }).length;
          const dayTrades = tradesByDay.get(day) ?? [];
          const totalGainLoss = dayTrades.reduce((sum, tr) => sum + tr.profitLoss, 0);
          return {
            day,
            sampleCount,
            tradeCount: dayTrades.length,
            totalGainLoss,
            totalGainLossPounds: pnlDenom > 0 ? totalGainLoss * pnlDenom : undefined,
            ...(sampleCount === 0 ? { status: 'noSamples' as const } : {}),
          };
        });
      }

      function emitFinalReport(report: BacktestReport, sampleQuality?: SampleQualityReport): void {
        const hasLegacyTpSl = !!(config.takeProfit || config.stopLoss);
        const hasRuleSetTpSl = config.ruleSets?.some((rs) => rs.takeProfit || rs.stopLoss);
        const usedTpSl = hasLegacyTpSl || !!hasRuleSetTpSl;
        const usedDynamicSl = !!(config.dynamicStopLossBuy || config.dynamicStopLossSell);
        const dslMeta = buildDynamicSlReportMeta(config);
        const trades = report.trades ?? [];
        const analysedDays = report.analysedDays;
        const reportOut: BacktestReport = { ...report, ...dslMeta, trades };
        socket.emit('analyse_recording_report', {
          report: reportOut,
          trades,
          analysedDays,
          analysedDayKeys: analysedDays?.map((d) => d.day) ?? [],
          sampleQuality,
          usedTpSl,
          usedDynamicSl,
          dealingScheduleGated: !effectiveIs24_7,
          dealingScheduleSource,
        });
      }

      if (usePerDay) {
        const days = getDaysToAnalyse();
        if (days.length === 0) {
          socket.emit('analyse_recording_report', { error: 'No recorded samples for ' + epic + noDataMsgSuffix });
          return;
        }
        let cancelled = false;
        let currentWorker: Worker | null = null;
        const workerPath = path.resolve(process.cwd(), 'dist', 'workers', 'backtestWorker.js');
        activeAnalyseBySocket.set(socket.id, () => {
          cancelled = true;
          if (currentWorker) currentWorker.terminate().catch(() => {});
        });
        const allTrades: BacktestReport['trades'] = [];
        let totalGainLoss = 0;
        let totalSamples = 0;
        let openAtEndTotal = 0;
        let startTs = 0;
        let endTs = 0;
        const blockerAggregate = new Map<string, number>();
        const analysedDays: BacktestDaySummary[] = [];
        const size = parseFloat(config.dealSize || '1') || 1;
        const contractSize = (config.contractSize != null && config.contractSize > 0) ? config.contractSize : 1;
        const pnlDenom = size * contractSize;
        socket.emit('analyse_recording_progress', { processed: 0, total: days.length });
        for (let i = 0; i < days.length; i++) {
          if (cancelled) {
            activeAnalyseBySocket.delete(socket.id);
            socket.emit('analyse_recording_report', { error: 'Cancelled' });
            return;
          }
          const day = days[i];
          const daySamples = getRecordedSamplesFiltered(epic, { days: [day] });
          if (daySamples.length > 0) {
            const dayReport = await new Promise<BacktestReport>((resolve, reject) => {
              const worker = new Worker(workerPath, { workerData: { samples: daySamples, config, usePerDay: false } });
              currentWorker = worker;
              let resolved = false;
              worker.on('message', (msg: { report?: unknown; error?: string }) => {
                if (resolved) return;
                if (msg.error) {
                  resolved = true;
                  currentWorker = null;
                  worker.terminate().catch(() => {});
                  reject(new Error(msg.error));
                } else if (msg.report) {
                  resolved = true;
                  currentWorker = null;
                  worker.terminate().catch(() => {});
                  resolve(msg.report as BacktestReport);
                }
              });
              worker.on('error', (err) => {
                if (resolved) return;
                resolved = true;
                currentWorker = null;
                worker.terminate().catch(() => {});
                reject(err);
              });
              worker.on('exit', (code) => {
                if (resolved) return;
                resolved = true;
                currentWorker = null;
                if (cancelled) reject(new Error('Cancelled'));
                else if (code !== 0) reject(new Error(`Backtest worker exited (code ${code}). Try fewer days or increase Node memory.`));
                else reject(new Error('Backtest worker exited without report'));
              });
            });
            allTrades.push(...dayReport.trades);
            totalGainLoss += dayReport.totalGainLoss;
            totalSamples += dayReport.sampleCount;
            openAtEndTotal += dayReport.openAtEnd ?? 0;
            if (dayReport.ruleBlockerCounts) {
              for (const b of dayReport.ruleBlockerCounts) {
                const k = blockerRowKey(b);
                blockerAggregate.set(k, (blockerAggregate.get(k) ?? 0) + b.soleBlockerCount);
              }
            }
            if (dayReport.startTs && (startTs === 0 || dayReport.startTs < startTs)) startTs = dayReport.startTs;
            if (dayReport.endTs && dayReport.endTs > endTs) endTs = dayReport.endTs;
            analysedDays.push({
              day,
              sampleCount: dayReport.sampleCount,
              tradeCount: dayReport.tradeCount,
              totalGainLoss: dayReport.totalGainLoss,
              totalGainLossPounds: pnlDenom > 0 ? dayReport.totalGainLoss * pnlDenom : undefined,
            });
          } else {
            analysedDays.push({
              day,
              sampleCount: 0,
              tradeCount: 0,
              totalGainLoss: 0,
              status: 'noSamples',
            });
          }
          socket.emit('analyse_recording_progress', { processed: i + 1, total: days.length });
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        activeAnalyseBySocket.delete(socket.id);
        if (totalSamples === 0) {
          socket.emit('analyse_recording_report', { error: 'No recorded samples for ' + epic + noDataMsgSuffix });
          return;
        }
        const winningTrades = allTrades.filter((t) => t.profitLoss > 0).length;
        const losingTrades = allTrades.filter((t) => t.profitLoss < 0).length;
        const denom = pnlDenom;
        const totalGainLossPounds = denom > 0 ? totalGainLoss * denom : undefined;
        const avgTradePnlPounds = (denom > 0 && allTrades.length > 0) ? (totalGainLoss / allTrades.length) * denom : undefined;
        const closeReasonCounts = {
          tp: allTrades.filter((t) => t.exitReason === 'tp').length,
          sl: allTrades.filter((t) => t.exitReason === 'sl').length,
          dsl: allTrades.filter((t) => t.exitReason === 'dsl').length,
          rules: allTrades.filter((t) => t.exitReason === 'rules').length,
          endOfPeriod: allTrades.filter((t) => t.exitReason === 'endOfPeriod').length,
        };
        const ruleBlockerCounts = mergeBlockerAggregateMap(blockerAggregate);
        const qualitySamples = getRecordedSamplesFiltered(epic, { days });
        const sampleQuality = analyzeSampleQuality(qualitySamples);
        emitFinalReport({
          trades: allTrades,
          totalGainLoss,
          totalGainLossPounds,
          tradeCount: allTrades.length,
          winningTrades,
          losingTrades,
          winRate: allTrades.length > 0 ? (winningTrades / allTrades.length) * 100 : 0,
          avgTradePnl: allTrades.length > 0 ? totalGainLoss / allTrades.length : 0,
          avgTradePnlPounds,
          sampleCount: totalSamples,
          startTs,
          endTs,
          openAtEnd: openAtEndTotal,
          daysAnalysed: days.length,
          closeReasonCounts,
          ruleBlockerCounts: ruleBlockerCounts.length > 0 ? ruleBlockerCounts : undefined,
          dynamicStopLossApplied: !!(config.dynamicStopLossBuy || config.dynamicStopLossSell),
          analysedDays,
        }, sampleQuality);
        return;
      }

      const days = getDaysToAnalyse();
      if (days.length === 0) {
        socket.emit('analyse_recording_report', { error: 'No recorded samples for ' + epic + noDataMsgSuffix });
        return;
      }
      function groupConsecutiveDays(daysSorted: string[]): string[][] {
        if (daysSorted.length === 0) return [];
        const blocks: string[][] = [];
        let current: string[] = [daysSorted[0]];
        for (let i = 1; i < daysSorted.length; i++) {
          const prev = new Date(current[current.length - 1]);
          const next = new Date(daysSorted[i]);
          const prevNext = new Date(prev);
          prevNext.setDate(prevNext.getDate() + 1);
          if (next.getTime() === prevNext.getTime()) current.push(daysSorted[i]);
          else {
            blocks.push(current);
            current = [daysSorted[i]];
          }
        }
        blocks.push(current);
        return blocks;
      }
      const blocks = groupConsecutiveDays(days);
      const nonConsecutiveWarning =
        blocks.length > 1
          ? `Days were not consecutive. Split into ${blocks.length} block(s); positions closed at end of each block.`
          : undefined;
      const workerPath = path.resolve(process.cwd(), 'dist', 'workers', 'backtestWorker.js');
      let cancelled = false;
      let currentWorker: Worker | null = null;
      activeAnalyseBySocket.set(socket.id, () => {
        cancelled = true;
        if (currentWorker) currentWorker.terminate().catch(() => {});
      });
      const allTrades: BacktestReport['trades'] = [];
      let totalGainLoss = 0;
      let totalSamples = 0;
      let openAtEndTotal = 0;
      let startTs = 0;
      let endTs = 0;
      const blockerAggregate = new Map<string, number>();
      let daysProcessed = 0;
      socket.emit('analyse_recording_progress', { processed: 0, total: days.length });
      for (const blockDays of blocks) {
        if (cancelled) {
          activeAnalyseBySocket.delete(socket.id);
          socket.emit('analyse_recording_report', { error: 'Cancelled' });
          return;
        }
        const blockSamples = getRecordedSamplesFiltered(epic, { days: blockDays });
        if (blockSamples.length === 0) {
          daysProcessed += blockDays.length;
          socket.emit('analyse_recording_progress', { processed: daysProcessed, total: days.length });
          continue;
        }
        if (blockSamples.length > MAX_CARRYOVER_SAMPLES) {
          activeAnalyseBySocket.delete(socket.id);
          socket.emit('analyse_recording_report', {
            error: `Too many samples in one consecutive carry-over block (${blockSamples.length.toLocaleString()}). Select fewer consecutive days.`,
          });
          return;
        }
        const report = await new Promise<BacktestReport>((resolve, reject) => {
          const worker = new Worker(workerPath, { workerData: { samples: blockSamples, config, usePerDay: false } });
          currentWorker = worker;
          let resolved = false;
          worker.on('message', (msg: { report?: unknown; error?: string }) => {
            if (resolved) return;
            if (msg.error) {
              resolved = true;
              currentWorker = null;
              worker.terminate().catch(() => {});
              reject(new Error(msg.error));
            } else if (msg.report) {
              resolved = true;
              currentWorker = null;
              worker.terminate().catch(() => {});
              resolve(msg.report as BacktestReport);
            }
          });
          worker.on('error', (err) => {
            if (resolved) return;
            resolved = true;
            currentWorker = null;
            worker.terminate().catch(() => {});
            reject(err);
          });
          worker.on('exit', (code) => {
            if (resolved) return;
            resolved = true;
            currentWorker = null;
            if (cancelled) reject(new Error('Cancelled'));
            else if (code !== 0) reject(new Error(`Backtest worker exited (code ${code}). Try fewer days or increase Node memory.`));
            else reject(new Error('Backtest worker exited without report'));
          });
        }).catch((err: Error) => {
          throw err;
        });
        allTrades.push(...report.trades);
        totalGainLoss += report.totalGainLoss;
        totalSamples += report.sampleCount;
        openAtEndTotal += report.openAtEnd ?? 0;
        if (report.ruleBlockerCounts) {
          for (const b of report.ruleBlockerCounts) {
            const k = blockerRowKey(b);
            blockerAggregate.set(k, (blockerAggregate.get(k) ?? 0) + b.soleBlockerCount);
          }
        }
        if (report.startTs && (startTs === 0 || report.startTs < startTs)) startTs = report.startTs;
        if (report.endTs && report.endTs > endTs) endTs = report.endTs;
        daysProcessed += blockDays.length;
        socket.emit('analyse_recording_progress', { processed: daysProcessed, total: days.length });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      activeAnalyseBySocket.delete(socket.id);
      if (cancelled) {
        socket.emit('analyse_recording_report', { error: 'Cancelled' });
        return;
      }
      if (totalSamples === 0) {
        socket.emit('analyse_recording_report', { error: 'No recorded samples for ' + epic + noDataMsgSuffix });
        return;
      }
      const winningTrades = allTrades.filter((t) => t.profitLoss > 0).length;
      const losingTrades = allTrades.filter((t) => t.profitLoss < 0).length;
      const size = parseFloat(config.dealSize || '1') || 1;
      const contractSize = (config.contractSize != null && config.contractSize > 0) ? config.contractSize : 1;
      const denom = size * contractSize;
      const totalGainLossPounds = denom > 0 ? totalGainLoss * denom : undefined;
      const avgTradePnlPounds = (denom > 0 && allTrades.length > 0) ? (totalGainLoss / allTrades.length) * denom : undefined;
      const closeReasonCounts = {
        tp: allTrades.filter((t) => t.exitReason === 'tp').length,
        sl: allTrades.filter((t) => t.exitReason === 'sl').length,
        dsl: allTrades.filter((t) => t.exitReason === 'dsl').length,
        rules: allTrades.filter((t) => t.exitReason === 'rules').length,
        endOfPeriod: allTrades.filter((t) => t.exitReason === 'endOfPeriod').length,
      };
      const ruleBlockerCounts = mergeBlockerAggregateMap(blockerAggregate);
      const qualitySamples = getRecordedSamplesFiltered(epic, { days });
      const sampleQuality = analyzeSampleQuality(qualitySamples);
      const analysedDays = buildAnalysedDaySummariesFromTrades(days, allTrades, denom);
      emitFinalReport({
        trades: allTrades,
        totalGainLoss,
        totalGainLossPounds,
        tradeCount: allTrades.length,
        winningTrades,
        losingTrades,
        winRate: allTrades.length > 0 ? (winningTrades / allTrades.length) * 100 : 0,
        avgTradePnl: allTrades.length > 0 ? totalGainLoss / allTrades.length : 0,
        avgTradePnlPounds,
        sampleCount: totalSamples,
        startTs,
        endTs,
        openAtEnd: openAtEndTotal,
        daysAnalysed: days.length,
        closeReasonCounts,
        nonConsecutiveWarning,
        ruleBlockerCounts: ruleBlockerCounts.length > 0 ? ruleBlockerCounts : undefined,
        dynamicStopLossApplied: !!(config.dynamicStopLossBuy || config.dynamicStopLossSell),
        analysedDays,
      }, sampleQuality);
    });

    socket.on('analyse_cancel', () => {
      const cancel = activeAnalyseBySocket.get(socket.id);
      if (cancel) {
        activeAnalyseBySocket.delete(socket.id);
        cancel('Cancelled');
      }
    });

    socket.on('getPositions', async () => {
      if (!currentSession) {
        socket.emit('positions', []);
        return;
      }
      try {
        await pollAndEmitPositions(currentSession, io);
      } catch {
        socket.emit('positions', []);
      }
    });

    socket.on('getWorkingOrders', async () => {
      if (!currentSession) {
        socket.emit('working_orders', []);
        return;
      }
      try {
        await pollAndEmitWorkingOrders(currentSession, io);
      } catch {
        socket.emit('working_orders', []);
      }
    });

    socket.on('cancelScheduledClose', async (dealId: string) => {
      const id = (dealId || '').trim();
      if (!id) return;
      const before = scheduledCloses.length;
      scheduledCloses = scheduledCloses.filter((s) => s.dealId !== id);
      if (scheduledCloses.length !== before) {
        saveScheduledCloses(scheduledCloses);
        emitScheduledCloses(io);
        io.emit('log', 'Cancelled scheduled close: ' + id);
        if (currentSession) {
          try {
            await pollAndEmitPositions(currentSession, io);
          } catch { /* ignore */ }
        }
      }
    });

    socket.on('deleteWorkingOrder', async (dealId: string) => {
      if (!currentSession) {
        socket.emit('delete_order_error', 'Not logged in');
        return;
      }
      const id = (dealId || '').trim();
      if (!id) {
        socket.emit('delete_order_error', 'Missing dealId');
        return;
      }
      try {
        await deleteWorkingOrder(currentSession, id);
        recentlyDeletedOrderIds[id] = Date.now();
        delete pendingOrderCloses[id];
        io.emit('log', 'Order cancelled: ' + id);
        io.emit('working_order_deleted', { dealId: id });
        socket.emit('order_deleted', { dealId: id });
        await pollAndEmitWorkingOrders(currentSession, io);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Cancel order failed';
        io.emit('log', 'Cancel order error: ' + msg);
        socket.emit('delete_order_error', msg);
      }
    });

    socket.on('closePosition', async (params: { dealId?: string; epic?: string; expiry?: string; direction: string; size: number }) => {
      if (!currentSession) {
        socket.emit('close_position_error', 'Not logged in');
        return;
      }
      const dealId = params.dealId?.trim();
      const epic = params.epic?.trim();
      const expiry = params.expiry?.trim();
      const size = typeof params.size === 'number' && !isNaN(params.size) ? params.size : parseFloat(String(params.size));
      const posDirection = (params.direction === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL';
      const closeDirection = posDirection === 'BUY' ? 'SELL' : 'BUY';
      if (!(size > 0 && !isNaN(size))) {
        socket.emit('close_position_error', 'Invalid size');
        return;
      }
      if (!dealId && (!epic || !expiry)) {
        socket.emit('close_position_error', 'Missing dealId or epic+expiry');
        return;
      }
      const id = (dealId || '').trim();
      try {
        let posBeforeClose: Awaited<ReturnType<typeof getPositions>>[number] | undefined;
        if (dealId) {
          const positions = await getPositions(currentSession);
          posBeforeClose = positions.find((p) => p.dealId === dealId);
        }
        if (id) {
          recentlyClosedByUs[id] = Date.now();
        }
        const closeResult = await closePosition(currentSession, { dealId: dealId || undefined, epic, expiry, direction: closeDirection, size });
        if (id) {
          const before = scheduledCloses.length;
          scheduledCloses = scheduledCloses.filter((s) => s.dealId !== id);
          if (scheduledCloses.length !== before) {
            saveScheduledCloses(scheduledCloses);
            emitScheduledCloses(io);
          }
          let closeConf: CloseConfirmation | undefined;
          try {
            const conf = await pollDealConfirmation(currentSession, closeResult.dealReference, { maxAttempts: 15, intervalMs: 300 });
            if (conf?.dealStatus === 'ACCEPTED') closeConf = { level: conf.level, profit: conf.profit, profitCurrency: conf.profitCurrency };
          } catch { /* ignore */ }
          if (posBeforeClose) {
            closeConf = await enrichCloseConfFromHistory(currentSession, posBeforeClose, closeConf, currentSession.currencyIsoCode);
            await recordTransactionFromPosition(io, currentSession, posBeforeClose, size, closeConf, currentSession.currencyIsoCode);
          }
        }
        io.emit('log', 'Position closed: ' + (epic || dealId));
        io.emit('position_closed', { dealId });
        await pollAndEmitPositions(currentSession, io);
      } catch (err) {
        if (id) delete recentlyClosedByUs[id];
        const msg = err instanceof Error ? err.message : 'Close failed';
        io.emit('log', 'Close position error: ' + msg);
        socket.emit('close_position_error', msg);
      }
    });

    socket.on('getIndicativeCosts', async (params: { epic: string; direction: string; size: string; bid: number; offer: number; currencyCode: string }) => {
      if (!currentSession) {
        socket.emit('indicativeCosts', { error: 'Not logged in' });
        return;
      }
      const epic = params.epic?.trim();
      const sizeNum = parseFloat(params.size || '0');
      const bid = typeof params.bid === 'number' && !isNaN(params.bid) ? params.bid : 0;
      const offer = typeof params.offer === 'number' && !isNaN(params.offer) ? params.offer : 0;
      const currencyCode = params.currencyCode?.trim() || 'USD';
      if (!epic || sizeNum <= 0) {
        socket.emit('indicativeCosts', { error: 'Epic and size required' });
        return;
      }
      const direction = (params.direction === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL';
      try {
        const result = await getIndicativeCostsOpen(currentSession, {
          epic,
          direction,
          size: sizeNum,
          bid,
          ask: offer,
          dealCurrencyCode: currencyCode,
        });
        if (result) {
          socket.emit('indicativeCosts', {
            openingSpread: result.openingSpread,
            closingSpread: result.closingSpread,
            currencyCodeISO: result.currencyCodeISO,
            totalCost: result.openingSpread + result.closingSpread,
          });
        } else {
          socket.emit('indicativeCosts', { error: 'Could not fetch costs' });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Indicative costs failed';
        socket.emit('indicativeCosts', { error: msg });
      }
    });

    socket.on('placeDeal', async (params: { epic: string; direction: string; size: string; takeProfit?: string; stopLoss?: string; closeAt?: string; bid?: number; offer?: number; source?: string }) => {
      if (!currentSession) {
        socket.emit('deal_error', 'Not logged in');
        return;
      }
      const epic = params.epic?.trim();
      const size = params.size?.trim();
      if (!epic || !size) {
        socket.emit('deal_error', 'Epic and size are required');
        return;
      }
      try {
        const existingPositions = await getPositions(currentSession);
        const hasOpenForEpic = existingPositions.some((p) => p.epic === epic);
        if (hasOpenForEpic) {
          io.emit('log', 'Place deal rejected: already have open position for ' + epic);
          socket.emit('deal_error', 'Already have an open position for this instrument');
          return;
        }
      } catch {
        /* continue – if we cannot fetch positions, allow the deal attempt */
      }
      const direction = (params.direction === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL';
      const cfg = loadConfig();
      let expiry = cfg.defaultExpiry || 'DFB';
      let currencyCode = cfg.currencyCode || 'GBP';
      let market: Awaited<ReturnType<typeof getMarketDetails>> = null;
      try {
        market = await getMarketDetails(currentSession, epic);
        if (market) {
          expiry = market.expiry;
          if (market.currencyCode) currencyCode = market.currencyCode;
        } else {
          expiry = inferExpiry(epic, cfg.defaultExpiry);
        }
      } catch {
        expiry = inferExpiry(epic, cfg.defaultExpiry);
      }
      const dslScope = params.source === 'rules' ? (direction === 'SELL' ? 'rules-sell' : 'rules-buy') : 'manual';
      const dslSettings = resolveDynamicStopLossSettings(epic, cfg, dslScope);
      const omitTp = shouldOmitTakeProfitForDeal(epic, cfg, dslScope);
      let takeProfit = params.takeProfit?.trim() ? parseFloat(params.takeProfit) : undefined;
      const stopLoss = params.stopLoss?.trim() ? parseFloat(params.stopLoss) : undefined;
      if (omitTp) takeProfit = undefined;
      const closeAtIso = params.closeAt?.trim();
      const bid = typeof params.bid === 'number' && !isNaN(params.bid) ? params.bid : undefined;
      const offer = typeof params.offer === 'number' && !isNaN(params.offer) ? params.offer : undefined;
      const entryPrice = direction === 'BUY' ? offer : bid;

      const dealRef = 'TT-' + Date.now();
      try {
        if (dslSettings) {
          const srcLabel = params.source === 'rules' ? 'rules deal' : 'deal';
          io.emit('log', 'Dynamic stop loss (' + srcLabel + '): no take profit; trailing from +' + dslSettings.triggerProfit);
        }
        const result = await createPosition(currentSession, {
          epic,
          direction,
          size,
          expiry,
          currencyCode,
          dealReference: dealRef,
          takeProfit: takeProfit && !isNaN(takeProfit) ? takeProfit : undefined,
          stopLoss: stopLoss && !isNaN(stopLoss) ? stopLoss : undefined,
          entryPrice: (takeProfit != null || stopLoss != null) ? entryPrice : undefined,
        });
        io.emit('log', 'Deal submitted: ' + result.dealReference + ' (waiting for confirmation...)');

        const conf = await pollDealConfirmation(currentSession, result.dealReference);
        if (conf.dealStatus === 'REJECTED') {
          let reason = conf.reason || 'Unknown';
          if (reason === 'ATTACHED_ORDER_LEVEL_ERROR') {
            reason = 'Stop/limit level invalid. Ensure stop loss is far enough from price (BUY: stop below entry, SELL: stop above entry).';
          }
          io.emit('log', 'Deal rejected: ' + reason + ' (expiry=' + expiry + ', currency=' + currencyCode + ')');
          socket.emit('deal_error', 'Deal rejected: ' + reason);
          return;
        }

        io.emit('log', 'Deal placed: ' + result.dealReference);
        socket.emit('deal_placed', {
          dealReference: result.dealReference,
          dealId: conf.dealId || undefined,
          epic,
          direction,
        });
        let placedPosition: Awaited<ReturnType<typeof getPositions>>[number] | undefined;
        if (currentSession) {
          try {
            const positions = await pollAndEmitPositions(currentSession, io);
            // Match by dealId (from confirmation) or dealReference – IG may not return dealReference in positions list
            placedPosition = positions.find(
              (p) => (conf.dealId && p.dealId === conf.dealId) || p.dealReference === dealRef
            );
          } catch { /* ignore */ }
        }
        if (placedPosition) {
          try {
            const sizeNum = placedPosition.size ?? parseFloat(size);
            const entry = placedPosition.level ?? (direction === 'BUY' ? params.offer : params.bid) ?? 0;
            const tx = appendTransactionOpen({
              timestamp: openTxTimestamp(placedPosition),
              dealId: placedPosition.dealId,
              epic: placedPosition.epic ?? epic,
              instrumentName: placedPosition.instrumentName,
              direction: placedPosition.direction,
              size: sizeNum,
              entry: typeof entry === 'number' && !isNaN(entry) ? entry : 0,
              currency: placedPosition.currency ?? currencyCode,
            });
            if (tx) io.emit('transaction_added', tx);
          } catch { /* ignore */ }
        }

        if (dslSettings) {
          const regId = placedPosition?.dealId ?? conf.dealId;
          const entry = placedPosition?.level ?? entryPrice ?? 0;
          const sizeNum = placedPosition?.size ?? parseFloat(size);
          const cs = market?.contractSize ?? 1;
          if (regId && entry > 0 && sizeNum > 0) {
            registerDynamicStopLoss({
              dealId: regId,
              epic,
              direction,
              entryPrice: entry,
              size: sizeNum,
              contractSize: cs,
              settings: dslSettings,
              initialStopLevel: placedPosition?.stopLevel ?? null,
            });
            io.emit('dynamic_stop_loss_status', getDynamicStopLossStatuses());
          }
        }

        if (closeAtIso) {
          const closeAtMs = new Date(closeAtIso).getTime();
          if (!isNaN(closeAtMs) && closeAtMs > Date.now()) {
            let dealId: string | undefined = conf.dealId;
            let closeSize = parseFloat(size);
            let closeDir = direction;
            if (!dealId) {
              await new Promise((r) => setTimeout(r, 2000));
              const positions = await getPositions(currentSession);
              const pos = positions.find((p) => p.dealReference === dealRef);
              if (pos) {
                dealId = pos.dealId;
                closeSize = pos.size;
                closeDir = pos.direction;
              }
            }
            if (dealId) {
              const closeDirection = closeDir === 'BUY' ? 'SELL' : 'BUY';
              scheduledCloses.push({ dealId, direction: closeDirection, size: closeSize, closeAt: closeAtMs, source: 'deal' });
              persistAndRunScheduler(currentSession, io);
              io.emit('log', 'Scheduled close at ' + closeAtIso);
              try {
                await pollAndEmitPositions(currentSession, io);
              } catch { /* ignore */ }
            } else {
              io.emit('log', 'Could not find position for scheduled close (dealRef: ' + dealRef + ')');
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Place deal failed';
        io.emit('log', 'Deal error: ' + msg);
        socket.emit('deal_error', msg);
      }
    });

    socket.on('placeOrder', async (params: { action: string; epic: string; direction: string; price: number; size?: string; takeProfit?: string; stopLoss?: string; closeAt?: string; stopAt?: string }) => {
      if (!currentSession) {
        socket.emit('order_error', 'Not logged in');
        return;
      }
      if (params.action === 'ALARM') {
        socket.emit('order_error', 'Alarm orders are not yet implemented');
        return;
      }
      if (params.action !== 'EXECUTE') {
        socket.emit('order_error', 'Invalid action');
        return;
      }
      const epic = params.epic?.trim();
      const size = params.size?.trim();
      const price = typeof params.price === 'number' && !isNaN(params.price) ? params.price : parseFloat(String(params.price || ''));
      if (!epic || !size || !(price > 0 && !isNaN(price))) {
        socket.emit('order_error', 'Epic, size and price are required');
        return;
      }
      const direction = (params.direction === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL';
      const cfg = loadConfig();
      let expiry = cfg.defaultExpiry || 'DFB';
      let currencyCode = cfg.currencyCode || 'GBP';
      try {
        const market = await getMarketDetails(currentSession, epic);
        if (market) {
          expiry = market.expiry;
          if (market.currencyCode) currencyCode = market.currencyCode;
        } else {
          expiry = inferExpiry(epic, cfg.defaultExpiry);
        }
      } catch {
        expiry = inferExpiry(epic, cfg.defaultExpiry);
      }
      const omitTp = shouldOmitTakeProfitForDeal(epic, cfg, 'manual');
      const takeProfitRaw = params.takeProfit?.trim() ? parseFloat(params.takeProfit) : undefined;
      const takeProfit = omitTp ? undefined : takeProfitRaw && !isNaN(takeProfitRaw) ? takeProfitRaw : undefined;
      const stopLoss = params.stopLoss?.trim() ? parseFloat(params.stopLoss) : undefined;
      const stopAtIso = params.stopAt?.trim();
      if (omitTp && takeProfitRaw != null && !isNaN(takeProfitRaw)) {
        io.emit('log', 'Dynamic stop loss enabled: take profit omitted on working order');
      }
      let timeInForce: 'GOOD_TILL_CANCELLED' | 'GOOD_TILL_DATE' = 'GOOD_TILL_CANCELLED';
      let goodTillDate: string | undefined;
      if (stopAtIso) {
        const stopAtMs = new Date(stopAtIso).getTime();
        if (!isNaN(stopAtMs) && stopAtMs > Date.now()) {
          timeInForce = 'GOOD_TILL_DATE';
          const d = new Date(stopAtMs);
          goodTillDate = d.getUTCFullYear() + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + String(d.getUTCDate()).padStart(2, '0') + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ':' + String(d.getUTCSeconds()).padStart(2, '0');
        }
      }
      const dealRef = 'TT-ORD-' + Date.now();
      try {
        const result = await createWorkingOrder(currentSession, {
          epic,
          direction,
          size,
          level: price,
          expiry,
          currencyCode,
          type: 'LIMIT',
          timeInForce,
          goodTillDate,
          takeProfit,
          stopLoss: stopLoss && !isNaN(stopLoss) ? stopLoss : undefined,
          dealReference: dealRef,
        });
        io.emit('log', 'Working order submitted: ' + result.dealReference + ' (waiting for confirmation...)');

        const conf = await pollDealConfirmation(currentSession, result.dealReference);
        if (conf.dealStatus === 'REJECTED') {
          const reason = conf.reason || 'Unknown';
          io.emit('log', 'Working order rejected: ' + reason);
          socket.emit('order_error', 'Order rejected: ' + reason);
          return;
        }

        io.emit('log', 'Working order accepted: ' + result.dealReference + '. Check IG: Orders / Working orders (not Positions – it becomes a position when price is reached).');
        const orderDealId = conf.dealId || result.dealReference;
        const orderData: Record<string, unknown> = {
          dealId: orderDealId,
          dealReference: result.dealReference,
          epic,
          direction,
          orderLevel: price,
          orderSize: parseFloat(size) || 0,
          limitLevel: takeProfit && !isNaN(takeProfit) ? takeProfit : undefined,
          stopLevel: stopLoss && !isNaN(stopLoss) ? stopLoss : undefined,
          orderType: 'LIMIT' as const,
        };
        const closeAtIso = params.closeAt?.trim();
        if (closeAtIso) {
          const closeAtMs = new Date(closeAtIso).getTime();
          if (!isNaN(closeAtMs) && closeAtMs > Date.now()) {
            pendingOrderCloses[orderDealId] = {
              closeAt: closeAtMs,
              size: parseFloat(size) || 0,
              direction,
              epic,
            };
            io.emit('log', 'Scheduled close will be added when order fills: ' + closeAtIso);
            orderData.scheduledClose = new Date(closeAtMs).toISOString();
          }
        }
        socket.emit('order_placed', { dealReference: result.dealReference, order: orderData });
        io.emit('working_order_added', orderData);
        pollAndEmitWorkingOrders(currentSession, io).catch(() => {});
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Place order failed';
        io.emit('log', 'Order error: ' + msg);
        if (msg.includes('404')) {
          io.emit('log', 'Working orders 404: ensure igBaseUrl is https://demo-api.ig.com (demo) or https://api.ig.com (live). Some regions may not support working orders.');
        }
        socket.emit('order_error', msg);
      }
    });
  });
}
