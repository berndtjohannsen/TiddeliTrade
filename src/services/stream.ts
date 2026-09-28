/**
 * Lightstreamer subscription logic for IG price streaming.
 * Uses session.lightstreamerEndpoint from login; PRICE item + Pricing adapter (MARKET deprecated May 2026).
 */

import type { IgSession } from './ig';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LightstreamerClient, Subscription } = require('lightstreamer-client-node');

export interface PriceUpdate {
  bid: string;
  offer: string;
  spread: string;
  updateTime: string;
  marketState: string;
  marketDelay: string;
}

type PriceUpdateCallback = (data: PriceUpdate) => void;
type LogCallback = (msg: string) => void;

/** IG PRICE subscription (replaces deprecated MARKET). */
const PRICE_ADAPTER = 'Pricing';
const PRICE_FIELDS = ['BIDPRICE1', 'ASKPRICE1', 'TIMESTAMP', 'DLG_FLAG', 'DELAY'] as const;

let lsClient: InstanceType<typeof LightstreamerClient> | null = null;
let lsSubscription: InstanceType<typeof Subscription> | null = null;
let onPriceUpdate: PriceUpdateCallback | null = null;
let logFn: LogCallback | null = null;
/** Session used for PRICE:{accountId}:{epic}; needed when switching epic without reconnecting. */
let priceStreamSession: IgSession | null = null;
/** Latest DLG_FLAG mapped to TRADEABLE / SUSPENDED etc.; empty until first tick. */
let lastStreamMarketState = '';

/** Live market state from the price stream (empty until the first update). */
export function getLastStreamMarketState(): string {
  return lastStreamMarketState;
}

function log(msg: string): void {
  if (logFn) logFn(msg);
}

function priceItemName(accountId: string, epic: string): string {
  return `PRICE:${accountId.trim()}:${epic.trim()}`;
}

/** TIMESTAMP is UTC epoch ms; format for UI / rules (London wall time, HH:mm:ss). */
function formatPriceTimestamp(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return '';
  const ms = Number(s);
  if (!Number.isFinite(ms)) return s;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/** Routine Lightstreamer states — omit from log to avoid noise. */
const QUIET_LS_STATUSES = new Set([
  'CONNECTING',
  'CONNECTED',
  'CONNECTED:WS-STREAMING',
  'STABLE',
]);

/** Map PRICE DLG_FLAG to legacy MARKET_STATE-style labels for the Now panel. */
function dlgFlagToMarketStateLabel(raw: string): string {
  const v = (raw || '').trim();
  const map: Record<string, string> = {
    DEAL: 'TRADEABLE',
    SUSPEND: 'SUSPENDED',
    AUCTIONNOEDIT: 'AUCTION_NO_EDIT',
  };
  return map[v] || v;
}

function applyPriceFields(
  update: { getValue: (name: string) => string },
  acc: {
    lastBid: string;
    lastOffer: string;
    lastUpdateTime: string;
    lastMarketState: string;
    lastMarketDelay: string;
  }
): void {
  const bidVal = update.getValue('BIDPRICE1');
  const offerVal = update.getValue('ASKPRICE1');
  const timeVal = update.getValue('TIMESTAMP');
  const stateVal = update.getValue('DLG_FLAG');
  const delayVal = update.getValue('DELAY');
  if (bidVal != null && bidVal !== '') acc.lastBid = bidVal;
  if (offerVal != null && offerVal !== '') acc.lastOffer = offerVal;
  if (timeVal != null && timeVal !== '') acc.lastUpdateTime = formatPriceTimestamp(timeVal);
  if (stateVal != null && stateVal !== '') {
    acc.lastMarketState = dlgFlagToMarketStateLabel(stateVal);
    lastStreamMarketState = acc.lastMarketState;
  }
  if (delayVal != null && delayVal !== '') acc.lastMarketDelay = delayVal.trim();
}

function createPriceSubscription(
  item: string,
  fields: readonly string[],
  onItemUpdate: (update: { getValue: (name: string) => string }) => void
): InstanceType<typeof Subscription> {
  const sub = new Subscription('MERGE', [item], [...fields]);
  sub.setDataAdapter(PRICE_ADAPTER);
  sub.addListener({
    onSubscription: () => {
      log('Subscription active: ' + item + ' (adapter ' + PRICE_ADAPTER + ')');
    },
    onSubscriptionError: (code: number, message: string) => {
      log('Subscription error ' + code + ': ' + message);
    },
    onItemUpdate: (update: { getValue: (name: string) => string }) => {
      onItemUpdate(update);
    },
  });
  return sub;
}

/**
 * Start Lightstreamer stream for the given epic.
 * Uses session.lightstreamerEndpoint, accountId, CST, X-SECURITY-TOKEN.
 */
export function startStream(session: IgSession, epic: string, callback: PriceUpdateCallback, onLog?: LogCallback): void {
  if (!session.lightstreamerEndpoint) {
    throw new Error('No lightstreamer endpoint in session');
  }
  const accountId = (session.accountId || '').trim();
  if (!accountId) {
    throw new Error('Session missing accountId; required for IG PRICE streaming');
  }
  stopStream();
  lastStreamMarketState = '';
  onPriceUpdate = callback;
  logFn = onLog || null;
  priceStreamSession = session;

  log('Lightstreamer connecting to ' + session.lightstreamerEndpoint);
  lsClient = new LightstreamerClient(session.lightstreamerEndpoint);
  lsClient.connectionDetails.setUser(session.accountId);
  lsClient.connectionDetails.setPassword(`CST-${session.cst}|XST-${session.xSecurityToken}`);

  lsClient.addListener({
    onStatusChange: (status: string) => {
      if (!QUIET_LS_STATUSES.has(status)) {
        log('Lightstreamer status: ' + status);
      }
    },
    onServerError: (errorCode: number, errorMessage: string) => {
      log('Lightstreamer error ' + errorCode + ': ' + errorMessage);
    },
  });

  lsClient.connect();

  const item = priceItemName(accountId, epic);
  log('Subscribing to ' + item);
  const acc = {
    lastBid: '',
    lastOffer: '',
    lastUpdateTime: '',
    lastMarketState: '',
    lastMarketDelay: '',
  };
  lsSubscription = createPriceSubscription(item, PRICE_FIELDS, (update) => {
    applyPriceFields(update, acc);
    const bidNum = parseFloat(acc.lastBid);
    const offerNum = parseFloat(acc.lastOffer);
    const spread = isNaN(bidNum) || isNaN(offerNum) ? '' : (offerNum - bidNum).toFixed(5);

    if (onPriceUpdate && acc.lastBid && acc.lastOffer) {
      onPriceUpdate({
        bid: acc.lastBid,
        offer: acc.lastOffer,
        spread,
        updateTime: acc.lastUpdateTime,
        marketState: acc.lastMarketState,
        marketDelay: acc.lastMarketDelay,
      });
    }
  });

  lsClient.subscribe(lsSubscription);
}

/**
 * Switch to a different epic. Must be called while stream is running.
 */
export function switchEpic(epic: string): void {
  if (!lsClient || !priceStreamSession) return;
  const accountId = (priceStreamSession.accountId || '').trim();
  if (!accountId) {
    log('Stream switch skipped: missing accountId on session');
    return;
  }
  if (lsSubscription) {
    lsClient.unsubscribe(lsSubscription);
    lsSubscription = null;
  }

  const item = priceItemName(accountId, epic);
  log('Switching to ' + item);
  lastStreamMarketState = '';
  const acc = {
    lastBid: '',
    lastOffer: '',
    lastUpdateTime: '',
    lastMarketState: '',
    lastMarketDelay: '',
  };
  lsSubscription = createPriceSubscription(item, PRICE_FIELDS, (update) => {
    applyPriceFields(update, acc);
    const bidNum = parseFloat(acc.lastBid);
    const offerNum = parseFloat(acc.lastOffer);
    const spread = isNaN(bidNum) || isNaN(offerNum) ? '' : (offerNum - bidNum).toFixed(5);

    if (onPriceUpdate && acc.lastBid && acc.lastOffer) {
      onPriceUpdate({
        bid: acc.lastBid,
        offer: acc.lastOffer,
        spread,
        updateTime: acc.lastUpdateTime,
        marketState: acc.lastMarketState,
        marketDelay: acc.lastMarketDelay,
      });
    }
  });

  lsClient.subscribe(lsSubscription);
}

/**
 * Stop the stream and disconnect.
 */
export function stopStream(): void {
  onPriceUpdate = null;
  logFn = null;
  priceStreamSession = null;
  lastStreamMarketState = '';
  if (lsClient) {
    if (lsSubscription) {
      lsClient.unsubscribe(lsSubscription);
      lsSubscription = null;
    }
    lsClient.disconnect();
    lsClient = null;
  }
}

export function isStreaming(): boolean {
  return lsClient !== null;
}
