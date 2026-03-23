/**
 * Lightstreamer subscription logic for IG price streaming.
 * Uses lightstreamerEndpoint from session (login response).
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

let lsClient: InstanceType<typeof LightstreamerClient> | null = null;
let lsSubscription: InstanceType<typeof Subscription> | null = null;
let onPriceUpdate: PriceUpdateCallback | null = null;
let logFn: LogCallback | null = null;

function log(msg: string): void {
  if (logFn) logFn(msg);
}

/**
 * Start Lightstreamer stream for the given epic.
 * Uses session.lightstreamerEndpoint, accountId, CST, X-SECURITY-TOKEN.
 */
export function startStream(session: IgSession, epic: string, callback: PriceUpdateCallback, onLog?: LogCallback): void {
  if (!session.lightstreamerEndpoint) {
    throw new Error('No lightstreamer endpoint in session');
  }
  stopStream();
  onPriceUpdate = callback;
  logFn = onLog || null;

  log('Lightstreamer connecting to ' + session.lightstreamerEndpoint);
  lsClient = new LightstreamerClient(session.lightstreamerEndpoint);
  lsClient.connectionDetails.setUser(session.accountId);
  lsClient.connectionDetails.setPassword(`CST-${session.cst}|XST-${session.xSecurityToken}`);

  lsClient.addListener({
    onStatusChange: (status: string) => {
      log('Lightstreamer status: ' + status);
    },
    onServerError: (errorCode: number, errorMessage: string) => {
      log('Lightstreamer error ' + errorCode + ': ' + errorMessage);
    },
  });

  lsClient.connect();

  const item = 'MARKET:' + epic;
  log('Subscribing to ' + item);
  let updateCount = 0;
  let lastBid = '';
  let lastOffer = '';
  let lastUpdateTime = '';
  let lastMarketState = '';
  let lastMarketDelay = '';
  lsSubscription = new Subscription('MERGE', [item], ['BID', 'OFFER', 'UPDATE_TIME', 'MARKET_STATE', 'MARKET_DELAY']);
  lsSubscription.addListener({
    onSubscription: () => {
      log('Subscription active: ' + item);
    },
    onSubscriptionError: (code: number, message: string) => {
      log('Subscription error ' + code + ': ' + message);
    },
    onItemUpdate: (update: { getValue: (name: string) => string }) => {
      updateCount++;
      const bidVal = update.getValue('BID');
      const offerVal = update.getValue('OFFER');
      const timeVal = update.getValue('UPDATE_TIME');
      const stateVal = update.getValue('MARKET_STATE');
      const delayVal = update.getValue('MARKET_DELAY');
      if (bidVal != null && bidVal !== '') lastBid = bidVal;
      if (offerVal != null && offerVal !== '') lastOffer = offerVal;
      if (timeVal != null && timeVal !== '') lastUpdateTime = timeVal;
      if (stateVal != null && stateVal !== '') lastMarketState = stateVal;
      if (delayVal != null && delayVal !== '') lastMarketDelay = delayVal;
      if (updateCount === 1) {
        log('First price from server: bid=' + lastBid + ' offer=' + lastOffer);
      }
      const bidNum = parseFloat(lastBid);
      const offerNum = parseFloat(lastOffer);
      const spread = isNaN(bidNum) || isNaN(offerNum) ? '' : (offerNum - bidNum).toFixed(5);

      if (onPriceUpdate && lastBid && lastOffer) {
        onPriceUpdate({
          bid: lastBid,
          offer: lastOffer,
          spread,
          updateTime: lastUpdateTime,
          marketState: lastMarketState,
          marketDelay: lastMarketDelay,
        });
      }
    },
  });

  lsClient.subscribe(lsSubscription);
  log('Subscription requested for ' + item);
}

/**
 * Switch to a different epic. Must be called while stream is running.
 */
export function switchEpic(epic: string): void {
  if (!lsClient || !lsSubscription) return;
  lsClient.unsubscribe(lsSubscription);
  lsSubscription = null;

  const item = 'MARKET:' + epic;
  log('Switching to ' + item);
  let updateCount = 0;
  let lastBid = '';
  let lastOffer = '';
  let lastUpdateTime = '';
  let lastMarketState = '';
  let lastMarketDelay = '';
  lsSubscription = new Subscription('MERGE', [item], ['BID', 'OFFER', 'UPDATE_TIME', 'MARKET_STATE', 'MARKET_DELAY']);
  lsSubscription.addListener({
    onSubscription: () => {
      log('Subscription active: ' + item);
    },
    onSubscriptionError: (code: number, message: string) => {
      log('Subscription error ' + code + ': ' + message);
    },
    onItemUpdate: (update: { getValue: (name: string) => string }) => {
      updateCount++;
      const bidVal = update.getValue('BID');
      const offerVal = update.getValue('OFFER');
      const timeVal = update.getValue('UPDATE_TIME');
      const stateVal = update.getValue('MARKET_STATE');
      const delayVal = update.getValue('MARKET_DELAY');
      if (bidVal != null && bidVal !== '') lastBid = bidVal;
      if (offerVal != null && offerVal !== '') lastOffer = offerVal;
      if (timeVal != null && timeVal !== '') lastUpdateTime = timeVal;
      if (stateVal != null && stateVal !== '') lastMarketState = stateVal;
      if (delayVal != null && delayVal !== '') lastMarketDelay = delayVal;
      if (updateCount === 1) {
        log('First price from server: bid=' + lastBid + ' offer=' + lastOffer);
      }
      const bidNum = parseFloat(lastBid);
      const offerNum = parseFloat(lastOffer);
      const spread = isNaN(bidNum) || isNaN(offerNum) ? '' : (offerNum - bidNum).toFixed(5);

      if (onPriceUpdate && lastBid && lastOffer) {
        onPriceUpdate({
          bid: lastBid,
          offer: lastOffer,
          spread,
          updateTime: lastUpdateTime,
          marketState: lastMarketState,
          marketDelay: lastMarketDelay,
        });
      }
    },
  });

  lsClient.subscribe(lsSubscription);
  log('Subscription requested for ' + item);
}

/**
 * Stop the stream and disconnect.
 */
export function stopStream(): void {
  onPriceUpdate = null;
  logFn = null;
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
