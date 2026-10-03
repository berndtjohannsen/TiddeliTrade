/**
 * Dynamic stop loss: trail profit by ratcheting IG stop (no take profit).
 * Applies per scope: rules-buy, rules-sell, or manual (deal/order panels).
 */

import type { UserConfig } from '../config';
import type { IgSession, Position } from './ig';
import { pollDealConfirmation, updatePositionStop } from './ig';

export interface DynamicStopLossSettings {
  enabled: boolean;
  /** Unrealized profit (deal currency) before trailing starts. */
  triggerProfit: number;
  /** Initial locked profit once trigger is hit. */
  lockProfit: number;
  /** Only amend if locked profit improves by at least this much. */
  minStepProfit: number;
  /** Minimum ms between IG amend attempts per deal. */
  updateIntervalMs: number;
}

export interface DynamicStopLossStatus {
  dealId: string;
  epic: string;
  enabled: true;
  triggerProfit: number;
  lockProfit: number;
  minStepProfit: number;
  highestLockApplied: number;
  lastStopLevel: number | null;
  lastMessage: string;
  updatedAt: number;
}

interface Tracked {
  dealId: string;
  epic: string;
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  size: number;
  contractSize: number;
  settings: DynamicStopLossSettings;
  lastStopLevel: number | null;
  highestLockApplied: number;
  lastAmendAttemptMs: number;
  lastRejectLogMs: number;
  lastMessage: string;
  /** True once unrealized profit has reached trigger (resets if profit drops below). */
  triggerReached: boolean;
  /** Throttle repeated diagnostic log lines per deal. */
  lastDiagLogMs: number;
  lastDiagLogKey: string;
}

const DIAG_LOG_INTERVAL_MS = 20000;
const REJECT_LOG_INTERVAL_MS = 15000;

function fmtMoney(n: number): string {
  return n.toFixed(2);
}

function fmtPrice(n: number): string {
  return n.toFixed(5);
}

function exitPrice(direction: 'BUY' | 'SELL', bid: number, offer: number): number {
  return direction === 'BUY' ? bid : offer;
}

function dealLogPrefix(t: Tracked): string {
  return 'Dynamic stop loss [' + t.dealId + '] ' + t.direction;
}

function logDiagThrottled(
  t: Tracked,
  key: string,
  message: string,
  log: DynamicStopLossLog,
  intervalMs: number = DIAG_LOG_INTERVAL_MS
): void {
  const now = Date.now();
  if (t.lastDiagLogKey === key && now - t.lastDiagLogMs < intervalMs) return;
  t.lastDiagLogKey = key;
  t.lastDiagLogMs = now;
  log(message);
}

function newTrackedBase(params: {
  dealId: string;
  epic: string;
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  size: number;
  contractSize: number;
  settings: DynamicStopLossSettings;
  lastStopLevel: number | null;
  highestLockApplied: number;
}): Tracked {
  return {
    dealId: params.dealId,
    epic: params.epic,
    direction: params.direction,
    entryPrice: params.entryPrice,
    size: params.size,
    contractSize: params.contractSize,
    settings: params.settings,
    lastStopLevel: params.lastStopLevel,
    highestLockApplied: params.highestLockApplied,
    lastAmendAttemptMs: 0,
    lastRejectLogMs: 0,
    lastMessage: 'Watching (dynamic SL)',
    triggerReached: false,
    lastDiagLogMs: 0,
    lastDiagLogKey: '',
  };
}

type PositionPriceSnapshot = {
  dealId: string;
  epic: string;
  bid?: number;
  offer?: number;
  level?: number;
  size?: number;
  contractSize?: number;
  stopLevel?: number | null;
};

function resolveSettingsForOpenPosition(
  epic: string,
  cfg: UserConfig,
  direction: 'BUY' | 'SELL'
): DynamicStopLossSettings | null {
  const scopes: DynamicStopLossScope[] =
    direction === 'SELL' ? ['rules-sell', 'manual'] : ['rules-buy', 'manual'];
  for (const scope of scopes) {
    const settings = resolveDynamicStopLossSettings(epic, cfg, scope);
    if (settings) return settings;
  }
  return null;
}

function refreshTrackerFromPosition(track: Tracked, pos: PositionPriceSnapshot): void {
  if (pos.level != null && pos.level > 0) track.entryPrice = pos.level;
  if (pos.size != null && pos.size > 0) track.size = pos.size;
  if (pos.contractSize != null && pos.contractSize > 0) track.contractSize = pos.contractSize;
  if (pos.epic) track.epic = pos.epic;
  if (pos.stopLevel != null && !isNaN(pos.stopLevel)) {
    if (isStopImprovement(track.direction, pos.stopLevel, track.lastStopLevel)) {
      track.lastStopLevel = pos.stopLevel;
      track.highestLockApplied = Math.max(
        track.highestLockApplied,
        impliedLockProfit(track.direction, track.entryPrice, pos.stopLevel, track.size, track.contractSize)
      );
    }
  }
}

const trackedByDealId = new Map<string, Tracked>();

const DEFAULT_MIN_STEP = 0.01;
const DEFAULT_UPDATE_MS = 3000;

export type DynamicStopLossScope = 'rules-buy' | 'rules-sell' | 'manual';

function legacyEnabled(inst: Record<string, unknown>, ui: Record<string, unknown>): boolean {
  return (
    inst.dealDynamicStopLossEnabled === true ||
    (inst.dealDynamicStopLossEnabled == null && ui.dealDynamicStopLossEnabled === true)
  );
}

function legacyTrigger(inst: Record<string, unknown>, ui: Record<string, unknown>): unknown {
  return inst.dealDynamicStopLossTrigger ?? ui.dealDynamicStopLossTrigger;
}

function legacyLock(inst: Record<string, unknown>, ui: Record<string, unknown>): unknown {
  return inst.dealDynamicStopLossLock ?? ui.dealDynamicStopLossLock;
}

export interface DynamicStopLossOverride {
  enabled?: boolean;
  trigger?: string | number | null;
  lock?: string | number | null;
}

function settingsFromOverride(override: DynamicStopLossOverride | null | undefined): DynamicStopLossSettings | null {
  if (!override || override.enabled !== true) return null;
  const trigger =
    typeof override.trigger === 'number' ? override.trigger : parseFloat(String(override.trigger ?? '').trim());
  const lock = typeof override.lock === 'number' ? override.lock : parseFloat(String(override.lock ?? '').trim());
  if (isNaN(trigger) || isNaN(lock) || trigger <= 0 || lock <= 0) return null;
  return {
    enabled: true,
    triggerProfit: trigger,
    lockProfit: lock,
    minStepProfit: DEFAULT_MIN_STEP,
    updateIntervalMs: DEFAULT_UPDATE_MS,
  };
}

/** Profile/backtest override when `enabled` is present; otherwise saved config. */
export function resolveDynamicStopLossForBacktest(
  epic: string,
  cfg: UserConfig,
  scope: DynamicStopLossScope,
  override?: DynamicStopLossOverride | null
): DynamicStopLossSettings | null {
  if (override && typeof override === 'object' && 'enabled' in override) {
    return settingsFromOverride(override);
  }
  return resolveDynamicStopLossSettings(epic, cfg, scope);
}

export function resolveDynamicStopLossSettings(
  epic: string,
  cfg: UserConfig,
  scope: DynamicStopLossScope = 'manual'
): DynamicStopLossSettings | null {
  const ui = cfg.ui || {};
  const inst = (epic && ui.instruments?.[epic] ? ui.instruments[epic] : {}) as Record<string, unknown>;
  const uiRec = ui as Record<string, unknown>;
  let enabled = false;
  let triggerRaw: unknown;
  let lockRaw: unknown;
  const legOn = legacyEnabled(inst, uiRec);
  if (scope === 'rules-buy') {
    enabled =
      inst.rulesDynamicStopLossEnabledBuy === true ||
      (inst.rulesDynamicStopLossEnabledBuy == null && legOn);
    triggerRaw = inst.rulesDynamicStopLossTriggerBuy ?? legacyTrigger(inst, uiRec);
    lockRaw = inst.rulesDynamicStopLossLockBuy ?? legacyLock(inst, uiRec);
  } else if (scope === 'rules-sell') {
    enabled =
      inst.rulesDynamicStopLossEnabledSell === true ||
      (inst.rulesDynamicStopLossEnabledSell == null && legOn);
    triggerRaw = inst.rulesDynamicStopLossTriggerSell ?? legacyTrigger(inst, uiRec);
    lockRaw = inst.rulesDynamicStopLossLockSell ?? legacyLock(inst, uiRec);
  } else {
    enabled =
      inst.dealDynamicStopLossEnabled === true ||
      (inst.dealDynamicStopLossEnabled == null && uiRec.dealDynamicStopLossEnabled === true);
    triggerRaw = inst.dealDynamicStopLossTrigger ?? uiRec.dealDynamicStopLossTrigger;
    lockRaw = inst.dealDynamicStopLossLock ?? uiRec.dealDynamicStopLossLock;
  }
  if (!enabled) return null;
  const trigger = typeof triggerRaw === 'number' ? triggerRaw : parseFloat(String(triggerRaw ?? '').trim());
  const lock = typeof lockRaw === 'number' ? lockRaw : parseFloat(String(lockRaw ?? '').trim());
  if (isNaN(trigger) || isNaN(lock) || trigger <= 0 || lock <= 0) return null;
  const minStepRaw = inst.dealDynamicStopLossMinStep ?? uiRec.dealDynamicStopLossMinStep;
  const minStep = typeof minStepRaw === 'number' ? minStepRaw : parseFloat(String(minStepRaw ?? '').trim());
  const intervalRaw = inst.dealDynamicStopLossUpdateSec ?? uiRec.dealDynamicStopLossUpdateSec;
  const intervalSec = typeof intervalRaw === 'number' ? intervalRaw : parseFloat(String(intervalRaw ?? '').trim());
  return {
    enabled: true,
    triggerProfit: trigger,
    lockProfit: lock,
    minStepProfit: !isNaN(minStep) && minStep > 0 ? minStep : DEFAULT_MIN_STEP,
    updateIntervalMs: !isNaN(intervalSec) && intervalSec > 0 ? Math.min(intervalSec, 60) * 1000 : DEFAULT_UPDATE_MS,
  };
}

export function clearDynamicStopLossTracking(): void {
  trackedByDealId.clear();
}

export function unregisterDynamicStopLoss(dealId: string): void {
  trackedByDealId.delete(dealId);
}

export function getDynamicStopLossStatuses(): DynamicStopLossStatus[] {
  const out: DynamicStopLossStatus[] = [];
  const now = Date.now();
  for (const t of trackedByDealId.values()) {
    out.push({
      dealId: t.dealId,
      epic: t.epic,
      enabled: true,
      triggerProfit: t.settings.triggerProfit,
      lockProfit: t.settings.lockProfit,
      minStepProfit: t.settings.minStepProfit,
      highestLockApplied: t.highestLockApplied,
      lastStopLevel: t.lastStopLevel,
      lastMessage: t.lastMessage,
      updatedAt: now,
    });
  }
  return out;
}

export function registerDynamicStopLoss(params: {
  dealId: string;
  epic: string;
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  size: number;
  contractSize: number;
  settings: DynamicStopLossSettings;
  initialStopLevel?: number | null;
  log?: DynamicStopLossLog;
}): void {
  if (!params.dealId || !params.settings.enabled) return;
  let highestLockApplied = 0;
  const initialStop = params.initialStopLevel ?? null;
  const contractSize = params.contractSize > 0 ? params.contractSize : 1;
  if (initialStop != null && !isNaN(initialStop)) {
    highestLockApplied = Math.max(
      0,
      impliedLockProfit(
        params.direction,
        params.entryPrice,
        initialStop,
        params.size,
        contractSize
      )
    );
  }
  const track = newTrackedBase({
    dealId: params.dealId,
    epic: params.epic,
    direction: params.direction,
    entryPrice: params.entryPrice,
    size: params.size,
    contractSize,
    settings: params.settings,
    lastStopLevel: initialStop,
    highestLockApplied,
  });
  trackedByDealId.set(params.dealId, track);
  if (params.log) {
    const s = params.settings;
    const stopNote =
      initialStop != null && !isNaN(initialStop)
        ? ' initial IG stop ' + fmtPrice(initialStop) + ' (~lock ' + fmtMoney(highestLockApplied) + ')'
        : ' no initial IG stop';
    params.log(
      dealLogPrefix(track) +
        ': watching – trigger +' +
        fmtMoney(s.triggerProfit) +
        ' lock +' +
        fmtMoney(s.lockProfit) +
        ', entry ' +
        fmtPrice(params.entryPrice) +
        ', size ' +
        params.size +
        '×' +
        contractSize +
        stopNote
    );
  }
}

/** Sync tracker with open positions (register missing, drop closed, refresh fields). */
export function syncDynamicStopLossWithPositions(
  positions: Position[],
  _streamEpic: string,
  cfg: UserConfig,
  log?: DynamicStopLossLog
): void {
  const openIds = new Set(positions.map((p) => p.dealId));
  for (const id of [...trackedByDealId.keys()]) {
    if (!openIds.has(id)) trackedByDealId.delete(id);
  }
  for (const p of positions) {
    const snap: PositionPriceSnapshot = {
      dealId: p.dealId,
      epic: p.epic,
      bid: p.bid,
      offer: p.offer,
      level: p.level,
      size: p.size,
      contractSize: p.contractSize,
      stopLevel: p.stopLevel,
    };
    const existing = trackedByDealId.get(p.dealId);
    if (existing) {
      refreshTrackerFromPosition(existing, snap);
      continue;
    }
    const settings = resolveSettingsForOpenPosition(p.epic, cfg, p.direction);
    if (!settings) continue;
    const entry = p.level ?? 0;
    if (!(entry > 0)) continue;
    registerDynamicStopLoss({
      dealId: p.dealId,
      epic: p.epic,
      direction: p.direction,
      entryPrice: entry,
      size: p.size,
      contractSize: p.contractSize ?? 1,
      settings,
      initialStopLevel: p.stopLevel ?? null,
      log,
    });
  }
}

function denom(size: number, contractSize: number): number {
  const d = size * contractSize;
  return d > 0 ? d : 1;
}

/** Unrealized P/L in deal currency at current market. */
export function unrealizedProfit(
  direction: 'BUY' | 'SELL',
  entry: number,
  size: number,
  contractSize: number,
  bid: number,
  offer: number
): number {
  const d = denom(size, contractSize);
  if (direction === 'BUY') return (bid - entry) * d;
  return (entry - offer) * d;
}

/** Stop price that locks approximately `lockProfit` currency. */
export function lockProfitToStopLevel(
  direction: 'BUY' | 'SELL',
  entry: number,
  lockProfit: number,
  size: number,
  contractSize: number
): number {
  const d = denom(size, contractSize);
  const delta = lockProfit / d;
  return direction === 'BUY' ? entry + delta : entry - delta;
}

function impliedLockProfit(
  direction: 'BUY' | 'SELL',
  entry: number,
  stopLevel: number,
  size: number,
  contractSize: number
): number {
  const d = denom(size, contractSize);
  return direction === 'BUY' ? (stopLevel - entry) * d : (entry - stopLevel) * d;
}

function isStopImprovement(
  direction: 'BUY' | 'SELL',
  newStop: number,
  oldStop: number | null
): boolean {
  if (oldStop == null || isNaN(oldStop)) return true;
  return direction === 'BUY' ? newStop > oldStop + 1e-9 : newStop < oldStop - 1e-9;
}

export function desiredLockProfit(unrealized: number, settings: DynamicStopLossSettings): number | null {
  if (unrealized < settings.triggerProfit) return null;
  const trail = settings.lockProfit + (unrealized - settings.triggerProfit);
  return Math.max(settings.lockProfit, trail);
}

/** In-memory trailing stop for backtest (no IG amend interval). */
export interface TrailingStopSimState {
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  size: number;
  contractSize: number;
  settings: DynamicStopLossSettings;
  lastStopLevel: number | null;
  highestLockApplied: number;
  /** True once unrealized profit reached trigger (trailing active). */
  triggerReached: boolean;
}

export function createTrailingStopSimState(
  direction: 'BUY' | 'SELL',
  entryPrice: number,
  size: number,
  contractSize: number,
  settings: DynamicStopLossSettings,
  initialStopLevel: number | null
): TrailingStopSimState {
  let highestLockApplied = 0;
  if (initialStopLevel != null && !isNaN(initialStopLevel)) {
    highestLockApplied = Math.max(
      0,
      impliedLockProfit(direction, entryPrice, initialStopLevel, size, contractSize)
    );
  }
  return {
    direction,
    entryPrice,
    size,
    contractSize,
    settings,
    lastStopLevel: initialStopLevel,
    highestLockApplied,
    triggerReached: false,
  };
}

/** Ratchet simulated stop from bid/offer (one sample; no amend throttle). */
export function advanceTrailingStopSim(state: TrailingStopSimState, bid: number, offer: number): void {
  const unrealized = unrealizedProfit(
    state.direction,
    state.entryPrice,
    state.size,
    state.contractSize,
    bid,
    offer
  );
  const desiredLock = desiredLockProfit(unrealized, state.settings);
  if (desiredLock == null) return;
  state.triggerReached = true;
  if (desiredLock <= state.highestLockApplied + state.settings.minStepProfit - 1e-9) return;
  const targetStop = lockProfitToStopLevel(
    state.direction,
    state.entryPrice,
    desiredLock,
    state.size,
    state.contractSize
  );
  if (!isStopImprovement(state.direction, targetStop, state.lastStopLevel)) return;
  state.lastStopLevel = targetStop;
  state.highestLockApplied = desiredLock;
}

export function isTrailingStopHit(
  direction: 'BUY' | 'SELL',
  stopLevel: number,
  bid: number,
  offer: number
): boolean {
  if (direction === 'BUY') return bid <= stopLevel;
  return offer >= stopLevel;
}

let amendChain: Promise<void> = Promise.resolve();

function queueAmend(fn: () => Promise<void>): void {
  amendChain = amendChain.then(fn).catch(() => {});
}

export type DynamicStopLossLog = (msg: string) => void;

function processDynamicStopLossTracker(
  session: IgSession,
  t: Tracked,
  bid: number,
  offer: number,
  log: DynamicStopLossLog
): void {
  const now = Date.now();
  const unrealized = unrealizedProfit(t.direction, t.entryPrice, t.size, t.contractSize, bid, offer);
  const market = exitPrice(t.direction, bid, offer);
  const desiredLock = desiredLockProfit(unrealized, t.settings);
  const prefix = dealLogPrefix(t);

  if (desiredLock == null) {
    t.triggerReached = false;
    t.lastMessage = 'Waiting for trigger (' + fmtMoney(t.settings.triggerProfit) + '+)';
    return;
  }

  if (!t.triggerReached) {
    t.triggerReached = true;
    log(
      prefix +
        ': trigger reached – profit ' +
        fmtMoney(unrealized) +
        ' (trigger +' +
        fmtMoney(t.settings.triggerProfit) +
        '), target lock +' +
        fmtMoney(desiredLock)
    );
  }

  if (desiredLock <= t.highestLockApplied + t.settings.minStepProfit - 1e-9) {
    t.lastMessage = 'Lock ' + fmtMoney(t.highestLockApplied) + ' (peak)';
    logDiagThrottled(
      t,
      'peak',
      prefix +
        ': no amend – profit ' +
        fmtMoney(unrealized) +
        ', desired lock +' +
        fmtMoney(desiredLock) +
        ' already applied (~+' +
        fmtMoney(t.highestLockApplied) +
        ', min step ' +
        fmtMoney(t.settings.minStepProfit) +
        ')',
      log
    );
    return;
  }

  const targetStop = lockProfitToStopLevel(
    t.direction,
    t.entryPrice,
    desiredLock,
    t.size,
    t.contractSize
  );

  if (!isStopImprovement(t.direction, targetStop, t.lastStopLevel)) {
    const curStop =
      t.lastStopLevel != null && !isNaN(t.lastStopLevel) ? fmtPrice(t.lastStopLevel) : '—';
    t.lastMessage =
      'Trailing (profit ' + fmtMoney(unrealized) + ', stop ' + curStop + ')';
    logDiagThrottled(
      t,
      'no-improve',
      prefix +
        ': skip amend – target stop ' +
        fmtPrice(targetStop) +
        ' not better than current ' +
        curStop +
        ' (profit ' +
        fmtMoney(unrealized) +
        ', desired lock +' +
        fmtMoney(desiredLock) +
        ', market ' +
        fmtPrice(market) +
        ')',
      log
    );
    return;
  }

  if (now - t.lastAmendAttemptMs < t.settings.updateIntervalMs) {
    const waitSec = Math.ceil((t.settings.updateIntervalMs - (now - t.lastAmendAttemptMs)) / 1000);
    t.lastMessage =
      'Trailing → lock ~' +
      fmtMoney(desiredLock) +
      ' @ ' +
      fmtPrice(targetStop) +
      ' (updating…)';
    logDiagThrottled(
      t,
      'throttle',
      prefix +
        ': amend queued – wait ~' +
        waitSec +
        's (interval ' +
        Math.round(t.settings.updateIntervalMs / 1000) +
        's), lock +' +
        fmtMoney(desiredLock) +
        ' → stop ' +
        fmtPrice(targetStop) +
        ' (profit ' +
        fmtMoney(unrealized) +
        ', market ' +
        fmtPrice(market) +
        ')',
      log
    );
    return;
  }

  t.lastAmendAttemptMs = now;
  const dealId = t.dealId;
  const direction = t.direction;
  const entry = t.entryPrice;
  const size = t.size;
  const contractSize = t.contractSize;
  const amendUnrealized = unrealized;
  const amendDesiredLock = desiredLock;
  const amendMarket = market;

  log(
    prefix +
      ': sending stop amend – lock +' +
      fmtMoney(desiredLock) +
      ' → stop ' +
      fmtPrice(targetStop) +
      ' (profit ' +
      fmtMoney(unrealized) +
      ', market ' +
      fmtPrice(market) +
      (t.lastStopLevel != null && !isNaN(t.lastStopLevel)
        ? ', prev stop ' + fmtPrice(t.lastStopLevel)
        : '') +
      ')'
  );

  queueAmend(async () => {
    const track = trackedByDealId.get(dealId);
    if (!track) return;
    const logNow = Date.now();
    try {
      const result = await updatePositionStop(session, dealId, { stopLevel: targetStop });
      try {
        const conf = await pollDealConfirmation(session, result.dealReference, {
          maxAttempts: 15,
          intervalMs: 300,
        });
        if (conf.dealStatus === 'REJECTED') {
          const reason = conf.reason || 'rejected';
          if (logNow - track.lastRejectLogMs > REJECT_LOG_INTERVAL_MS) {
            log(
              dealLogPrefix(track) +
                ': amend REJECTED – ' +
                reason +
                ' | profit ' +
                fmtMoney(amendUnrealized) +
                ' desired lock +' +
                fmtMoney(amendDesiredLock) +
                ' stop ' +
                fmtPrice(targetStop) +
                ' market ' +
                fmtPrice(amendMarket) +
                ' (IG stop unchanged)'
            );
            track.lastRejectLogMs = logNow;
          }
          track.lastMessage = 'Amend rejected: ' + reason;
          return;
        }
      } catch {
        log(
          dealLogPrefix(track) +
            ': amend confirmation timeout – stop ' +
            fmtPrice(targetStop) +
            ' may still apply (check position poll)'
        );
      }
      track.lastStopLevel = targetStop;
      track.highestLockApplied = amendDesiredLock;
      track.lastMessage = 'Locked ~' + fmtMoney(amendDesiredLock) + ' @ ' + fmtPrice(targetStop);
      log(
        dealLogPrefix(track) +
          ': amend OK – lock +' +
          fmtMoney(amendDesiredLock) +
          ' → stop ' +
          fmtPrice(targetStop) +
          ' (profit ' +
          fmtMoney(amendUnrealized) +
          ')'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (logNow - track.lastRejectLogMs > REJECT_LOG_INTERVAL_MS) {
        log(
          dealLogPrefix(track) +
            ': amend FAILED – ' +
            msg +
            ' | profit ' +
            fmtMoney(amendUnrealized) +
            ' desired lock +' +
            fmtMoney(amendDesiredLock) +
            ' stop ' +
            fmtPrice(targetStop) +
            ' market ' +
            fmtPrice(amendMarket)
        );
        track.lastRejectLogMs = logNow;
      }
      track.lastMessage = 'Amend failed: ' + msg;
      const current = track.lastStopLevel;
      if (current != null && !isNaN(current)) {
        track.highestLockApplied = Math.max(
          track.highestLockApplied,
          impliedLockProfit(direction, entry, current, size, contractSize)
        );
      }
    }
  });
}

/**
 * Called on throttled price ticks for the streamed epic.
 */
export function onDynamicStopLossPriceTick(
  session: IgSession,
  epic: string,
  bid: number,
  offer: number,
  log: DynamicStopLossLog
): void {
  if (!epic || isNaN(bid) || isNaN(offer)) return;
  for (const t of trackedByDealId.values()) {
    if (t.epic !== epic) continue;
    processDynamicStopLossTracker(session, t, bid, offer, log);
  }
}

/** Run trailing logic using IG position prices (position poll fallback). */
export function onDynamicStopLossPositionPoll(
  session: IgSession,
  positions: PositionPriceSnapshot[],
  log: DynamicStopLossLog
): void {
  for (const p of positions) {
    if (typeof p.bid !== 'number' || typeof p.offer !== 'number' || isNaN(p.bid) || isNaN(p.offer)) continue;
    const t = trackedByDealId.get(p.dealId);
    if (!t) continue;
    refreshTrackerFromPosition(t, p);
    processDynamicStopLossTracker(session, t, p.bid, p.offer, log);
  }
}

/** Strip take profit when dynamic SL is enabled for the given scope. */
export function shouldOmitTakeProfitForDeal(
  epic: string,
  cfg: UserConfig,
  scope: DynamicStopLossScope = 'manual'
): boolean {
  return resolveDynamicStopLossSettings(epic, cfg, scope) != null;
}
