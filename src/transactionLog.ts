/**
 * Transaction log – persisted to transactions.json, rolls at 200 entries.
 */
import fs from 'fs';
import path from 'path';
import type { IgProfileId } from './config';

const TRANSACTIONS_PATH = path.join(process.cwd(), 'transactions.json');
const MAX_TRANSACTIONS = 200;

export type DealSource = 'rules' | 'manual' | 'order';

/** How the position was closed (best-effort; IG may not confirm). */
export type TransactionCloseReason =
  | 'dsl'
  | 'sl'
  | 'tp'
  | 'forced'
  | 'scheduled'
  | 'manual'
  | 'unknown';

export interface Transaction {
  id: string;
  timestamp: string;
  /** 'open' = deal placed, 'closed' = position closed. Omit for backward compat (treated as closed). */
  type?: 'open' | 'closed';
  /** IG deal id – used to avoid duplicate log rows for the same close/open. */
  dealId?: string;
  epic: string;
  instrumentName?: string;
  direction: 'BUY' | 'SELL';
  size: number;
  entry: number;
  /** Only for closed transactions. */
  exit?: number;
  /** Only for closed transactions. */
  profitLoss?: number;
  currency: string;
  /** IG account mode (demo/live) when the trade was logged. */
  profile?: IgProfileId;
  /** IG position open time (ISO). On closed rows, `timestamp` is close detection time. */
  openedAt?: string;
  /** rules = auto rules engine, manual = deal panel, order = working order fill. */
  source?: DealSource;
  /** Take profit level sent to IG at open (if any). */
  takeProfitLevel?: number;
  /** Initial stop level sent to IG at open (if any). */
  stopLossLevel?: number;
  /** Last known stop on IG / dynamic SL before close. */
  stopLevelAtClose?: number;
  closeReason?: TransactionCloseReason;
  /** Human label for the rules run (profile + start date). */
  rulesRunLabel?: string;
}

export interface DealOpenMeta {
  source?: DealSource;
  takeProfitLevel?: number;
  stopLossLevel?: number;
  rulesRunLabel?: string;
}

interface CloseIntent {
  at: number;
  reason: TransactionCloseReason;
}

const openMetaByDealId = new Map<string, DealOpenMeta>();
const closeIntentByDealId = new Map<string, CloseIntent>();
const CLOSE_INTENT_TTL_MS = 120_000;

/** Stash metadata before IG assigns deal id (key by dealReference) or after (deal id). */
const openMetaByKey = new Map<string, DealOpenMeta>();

export function stashDealOpenMeta(key: string, meta: DealOpenMeta): void {
  const k = (key || '').trim();
  if (!k) return;
  openMetaByKey.set(k, { ...openMetaByKey.get(k), ...meta });
}

export function moveDealOpenMeta(fromKey: string, toDealId: string): void {
  const from = (fromKey || '').trim();
  const to = (toDealId || '').trim();
  if (!from || !to) return;
  const meta = openMetaByKey.get(from);
  if (meta) {
    openMetaByDealId.set(to, { ...openMetaByDealId.get(to), ...meta });
    openMetaByKey.delete(from);
  }
}

export function peekDealOpenMeta(dealId: string): DealOpenMeta | undefined {
  const did = (dealId || '').trim();
  if (!did) return undefined;
  return openMetaByDealId.get(did) ?? openMetaByKey.get(did);
}

export function takeDealOpenMeta(dealId: string): DealOpenMeta | undefined {
  const did = (dealId || '').trim();
  if (!did) return undefined;
  const fromDeal = openMetaByDealId.get(did);
  if (fromDeal) {
    openMetaByDealId.delete(did);
    return fromDeal;
  }
  const fromKey = openMetaByKey.get(did);
  if (fromKey) {
    openMetaByKey.delete(did);
    return fromKey;
  }
  return undefined;
}

export function setPendingCloseReason(dealId: string, reason: TransactionCloseReason): void {
  const did = (dealId || '').trim();
  if (!did) return;
  closeIntentByDealId.set(did, { at: Date.now(), reason });
}

export function consumePendingCloseReason(dealId: string): TransactionCloseReason | undefined {
  const did = (dealId || '').trim();
  if (!did) return undefined;
  const row = closeIntentByDealId.get(did);
  if (!row) return undefined;
  if (Date.now() - row.at > CLOSE_INTENT_TTL_MS) {
    closeIntentByDealId.delete(did);
    return undefined;
  }
  closeIntentByDealId.delete(did);
  return row.reason;
}

function txKind(t: Pick<Transaction, 'type' | 'exit' | 'profitLoss'>): 'open' | 'closed' {
  if (t.type === 'open') return 'open';
  if (t.type === 'closed') return 'closed';
  return 'closed';
}

function hasClosedForDeal(state: TransactionLogState, dealId: string): boolean {
  return state.transactions.some(
    (t) => (t.dealId || '').trim() === dealId && txKind(t) === 'closed'
  );
}

export interface TransactionLogState {
  transactions: Transaction[];
}

function loadRaw(): TransactionLogState {
  try {
    const raw = fs.readFileSync(TRANSACTIONS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TransactionLogState>;
    const list = Array.isArray(parsed?.transactions) ? parsed.transactions : [];
    return { transactions: list };
  } catch {
    return { transactions: [] };
  }
}

function save(state: TransactionLogState): void {
  const dir = path.dirname(TRANSACTIONS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(TRANSACTIONS_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

function mergeOpenMeta(dealId: string, tx: Omit<Transaction, 'id'>): Omit<Transaction, 'id'> {
  const meta = peekDealOpenMeta(dealId);
  if (!meta) return tx;
  return {
    ...tx,
    source: tx.source ?? meta.source,
    takeProfitLevel: tx.takeProfitLevel ?? meta.takeProfitLevel,
    stopLossLevel: tx.stopLossLevel ?? meta.stopLossLevel,
    rulesRunLabel: tx.rulesRunLabel ?? meta.rulesRunLabel,
  };
}

/**
 * Append a transaction and persist. Rolls to keep only the most recent MAX_TRANSACTIONS.
 * For closed trades, pass exit and profitLoss. For open (deal placed), omit them and set type: 'open'.
 * Returns null if a row with the same dealId and type already exists (duplicate guard).
 */
export function appendTransaction(tx: Omit<Transaction, 'id'>): Transaction | null {
  const state = loadRaw();
  const did = (tx.dealId || '').trim();
  const kind = txKind(tx);
  if (did) {
    const dup = state.transactions.some((t) => txKind(t) === kind && (t.dealId || '').trim() === did);
    if (dup) return null;
    // Skip late "open" rows if close was already logged (e.g. missed open at deal time).
    if (kind === 'open' && hasClosedForDeal(state, did)) return null;
  }
  let row = tx;
  if (did) {
    if (kind === 'open') row = mergeOpenMeta(did, tx);
    takeDealOpenMeta(did);
  }
  const id = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const full: Transaction = { ...row, id };
  state.transactions.push(full);
  if (state.transactions.length > MAX_TRANSACTIONS) {
    state.transactions = state.transactions.slice(-MAX_TRANSACTIONS);
  }
  save(state);
  return full;
}

/**
 * Log when a deal is placed (position opened). Use appendTransaction for closed positions.
 */
export function appendTransactionOpen(tx: Omit<Transaction, 'id' | 'exit' | 'profitLoss'>): Transaction | null {
  return appendTransaction({ ...tx, type: 'open' });
}

/**
 * Get all transactions (newest last for display).
 */
export function getTransactions(): Transaction[] {
  return loadRaw().transactions;
}

export function getClosedTransactionsForEpic(
  epic: string,
  opts?: { fromTs?: number; toTs?: number }
): Transaction[] {
  const epicTrim = (epic || '').trim();
  const from = opts?.fromTs ?? 0;
  const to = opts?.toTs ?? Number.MAX_SAFE_INTEGER;
  return getTransactions().filter((t) => {
    if (txKind(t) !== 'closed') return false;
    if (epicTrim && (t.epic || '').trim() !== epicTrim) return false;
    const openMs = t.openedAt ? Date.parse(t.openedAt) : Date.parse(t.timestamp);
    const closeMs = Date.parse(t.timestamp);
    const anchor = !isNaN(openMs) ? openMs : closeMs;
    if (isNaN(anchor)) return true;
    return anchor >= from && anchor <= to;
  });
}

/** CSV export of closed deals (Excel-friendly). */
export function transactionsToCsv(transactions: Transaction[]): string {
  const header =
    'dealId,openedAt,closedAt,direction,size,entry,exit,profitLoss,currency,source,closeReason,stopAtOpen,stopAtClose,rulesRun,epic,instrument';
  const closed = transactions.filter((t) => txKind(t) === 'closed');
  const esc = (v: string | number | undefined | null): string => {
    const s = v == null ? '' : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = closed.map((t) =>
    [
      t.dealId,
      t.openedAt ?? '',
      t.timestamp,
      t.direction,
      t.size,
      t.entry,
      t.exit,
      t.profitLoss,
      t.currency,
      t.source ?? '',
      t.closeReason ?? '',
      t.stopLossLevel ?? '',
      t.stopLevelAtClose ?? '',
      t.rulesRunLabel ?? '',
      t.epic,
      t.instrumentName ?? '',
    ]
      .map(esc)
      .join(',')
  );
  return [header, ...lines].join('\n');
}

/**
 * Reset the log (clear all transactions).
 */
export function resetTransactions(): void {
  save({ transactions: [] });
}
