/**
 * Transaction log – persisted to transactions.json, rolls at 200 entries.
 */
import fs from 'fs';
import path from 'path';

const TRANSACTIONS_PATH = path.join(process.cwd(), 'transactions.json');
const MAX_TRANSACTIONS = 200;

export interface Transaction {
  id: string;
  timestamp: string;
  /** 'open' = deal placed, 'closed' = position closed. Omit for backward compat (treated as closed). */
  type?: 'open' | 'closed';
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

/**
 * Append a transaction and persist. Rolls to keep only the most recent MAX_TRANSACTIONS.
 * For closed trades, pass exit and profitLoss. For open (deal placed), omit them and set type: 'open'.
 */
export function appendTransaction(tx: Omit<Transaction, 'id'>): Transaction {
  const state = loadRaw();
  const id = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const full: Transaction = { ...tx, id };
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
export function appendTransactionOpen(tx: Omit<Transaction, 'id' | 'exit' | 'profitLoss'>): Transaction {
  return appendTransaction({ ...tx, type: 'open' });
}

/**
 * Get all transactions (newest last for display).
 */
export function getTransactions(): Transaction[] {
  return loadRaw().transactions;
}

/**
 * Reset the log (clear all transactions).
 */
export function resetTransactions(): void {
  save({ transactions: [] });
}
