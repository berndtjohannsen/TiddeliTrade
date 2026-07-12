/**
 * IG REST API client.
 * Implements session login per APIcheatsheet.md (V2).
 */

import { getActiveCredentials, loadConfig } from '../config';

export interface IgSession {
  cst: string;
  xSecurityToken: string;
  accountId: string;
  accountType: string;
  accountName?: string;
  currencyIsoCode?: string;
  lightstreamerEndpoint: string;
  reroutingEnvironment?: string;
}

export interface IgAccountInfo {
  accountId: string;
  accountType: string;
  accountName?: string;
  currencyIsoCode?: string;
  reroutingEnvironment?: string;
}

/**
 * Create IG session via POST /gateway/deal/session (Version 2).
 * Returns session tokens and account info for UI display.
 */
export async function createSession(): Promise<IgSession> {
  const creds = getActiveCredentials();
  if (!creds) {
    throw new Error('Missing IG credentials. Configure API key, username and password in Settings.');
  }
  const { igApiKey, igUsername, igPassword, igBaseUrl } = creds;
  const baseUrl = igBaseUrl.replace(/\/$/, '');
  const url = `${baseUrl}/gateway/deal/session`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-IG-API-KEY': igApiKey,
      'Version': '2',
      'Content-Type': 'application/json',
      'Accept': 'application/json; charset=UTF-8',
      'User-Agent': 'TiddeliTrade/1.0',
    },
    body: JSON.stringify({
      identifier: igUsername,
      password: igPassword,
    }),
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { errorCode?: string; errorMessage?: string; error?: { errorCode?: string; message?: string } };
    const errCode = errBody.errorCode || errBody.error?.errorCode;
    const errMsg = errBody.errorMessage || errBody.error?.message || res.statusText;
    throw new Error(errCode ? `${errCode}: ${errMsg}` : `Login failed: ${errMsg}`);
  }

  const cst = res.headers.get('cst') || res.headers.get('CST') || '';
  const xst = res.headers.get('x-security-token') || res.headers.get('X-SECURITY-TOKEN') || '';

  if (!cst || !xst) {
    throw new Error('Login succeeded but session tokens (CST/XST) missing in response.');
  }

  const data = (await res.json()) as {
    currentAccountId?: string;
    accountId?: string;
    accountType?: string;
    accounts?: Array<{ preferred?: boolean; accountName?: string }>;
    accountName?: string;
    currencyIsoCode?: string;
    lightstreamerEndpoint?: string;
    reroutingEnvironment?: string;
  };

  const accountId = data.currentAccountId || data.accountId || '';
  const accountType = data.accountType || '';

  const preferredAccount = Array.isArray(data.accounts)
    ? data.accounts.find((a) => a.preferred)
    : null;
  const accountName = preferredAccount?.accountName || data.accountName;

  // API may omit reroutingEnvironment; infer from base URL when missing
  let reroutingEnvironment = data.reroutingEnvironment;
  if (!reroutingEnvironment) {
    reroutingEnvironment = /demo-api|demo\.ig\.com/i.test(baseUrl) ? 'DEMO' : 'LIVE';
  }

  return {
    cst,
    xSecurityToken: xst,
    accountId,
    accountType,
    accountName,
    currencyIsoCode: data.currencyIsoCode,
    lightstreamerEndpoint: data.lightstreamerEndpoint || '',
    reroutingEnvironment,
  };
}

function authHeaders(session: IgSession): Record<string, string> {
  const creds = getActiveCredentials();
  const apiKey = creds?.igApiKey || '';
  return {
    'X-IG-API-KEY': apiKey,
    'CST': session.cst,
    'X-SECURITY-TOKEN': session.xSecurityToken,
    'IG-ACCOUNT-ID': session.accountId,
    'Accept': 'application/json',
  };
}

function baseUrl(): string {
  const creds = getActiveCredentials();
  return (creds?.igBaseUrl || 'https://demo-api.ig.com').replace(/\/$/, '');
}

export interface WatchlistItem {
  id: string;
  name: string;
}

/**
 * List all watchlists. GET /gateway/deal/watchlists | Version: 1
 */
export async function listWatchlists(session: IgSession): Promise<WatchlistItem[]> {
  const url = `${baseUrl()}/gateway/deal/watchlists`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...authHeaders(session), 'Version': '1' },
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { errorCode?: string };
    throw new Error(errBody.errorCode || `Watchlists failed: ${res.status}`);
  }
  const data = (await res.json()) as { watchlists?: Array<{ id?: string; name?: string }> };
  const list = data.watchlists || [];
  return list.map((w) => ({ id: w.id || '', name: w.name || '' })).filter((w) => w.id);
}

export interface EpicItem {
  epic: string;
  instrumentName?: string;
}

/**
 * Get epics from a watchlist. GET /gateway/deal/watchlists/[id] | Version: 1
 */
export async function getWatchlistEpics(session: IgSession, watchlistId: string): Promise<EpicItem[]> {
  const url = `${baseUrl()}/gateway/deal/watchlists/${encodeURIComponent(watchlistId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...authHeaders(session), 'Version': '1' },
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { errorCode?: string };
    throw new Error(errBody.errorCode || `Watchlist epics failed: ${res.status}`);
  }
  const data = (await res.json()) as { markets?: Array<{ epic?: string; instrumentName?: string }> };
  const markets = data.markets || [];
  return markets.map((m) => ({ epic: m.epic || '', instrumentName: m.instrumentName })).filter((m) => m.epic);
}

export interface MarketDetails {
  expiry: string;
  currencyCode: string;
  minDealSize?: number;
  contractSize?: number;
  marginFactor?: number;
  lotSize?: number;
  /** Value of one pip/point per contract (for spread cost: spread × size × valueOfOnePip) */
  valueOfOnePip?: number;
  /** Multiplying factor for price levels; spread in price units ÷ scalingFactor = spread in points */
  scalingFactor?: number;
  /** Rate to convert from instrument currency to account currency (value * rate = value in account) */
  exchangeRateToAccount?: number;
}

/** Normalize IG currency codes for comparison (e.g. SK → SEK). */
function normCurrencyCode(raw: string | undefined): string {
  const u = (raw || '').trim().toUpperCase();
  if (u === 'SK') return 'SEK';
  return u;
}

function rateFromCurrencyRow(c: { exchangeRate?: number; baseExchangeRate?: number }): number | undefined {
  const rate = c.exchangeRate ?? c.baseExchangeRate;
  if (rate == null || isNaN(Number(rate)) || Number(rate) <= 0) return undefined;
  return Number(rate);
}

/** Try batch markets endpoint for exchange rate when single-epic endpoint omits it. */
async function getExchangeRateFromBatch(session: IgSession, epic: string, currencyCode: string): Promise<number | undefined> {
  const accountCurrency = (session.currencyIsoCode || '').trim().toUpperCase();
  if (!accountCurrency || normCurrencyCode(currencyCode) === normCurrencyCode(accountCurrency)) return undefined;
  try {
    const url = `${baseUrl()}/gateway/deal/markets?epics=${encodeURIComponent(epic)}&filter=ALL`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...authHeaders(session), 'Version': '2' },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      marketDetails?: Array<{
        instrument?: {
          currencies?: Array<{ code?: string; exchangeRate?: number; baseExchangeRate?: number }>;
        };
      }>;
    };
    const md = data.marketDetails?.[0];
    const currencies = md?.instrument?.currencies;
    if (!Array.isArray(currencies)) return undefined;
    const accUpper = accountCurrency;
    const accountCur = currencies.find((c) => {
      const code = (c.code || '').trim().toUpperCase();
      return code === accUpper || (code === 'SK' && accUpper === 'SEK') || (code === 'SEK' && accUpper === 'SK');
    });
    const rate = accountCur?.exchangeRate ?? accountCur?.baseExchangeRate;
    if (rate != null && !isNaN(Number(rate)) && Number(rate) > 0) return Number(rate);
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Get market details including expiry and currency. GET /gateway/deal/markets/{epic} | Version: 3
 * Use this to get the correct expiry when placing orders (CFE, CFD, etc. vary).
 */
export async function getMarketDetails(session: IgSession, epic: string): Promise<MarketDetails | null> {
  const url = `${baseUrl()}/gateway/deal/markets/${encodeURIComponent(epic)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...authHeaders(session), 'Version': '4' },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    dealingRules?: { minDealSize?: { value?: number } };
    instrument?: {
      expiry?: string;
      currencies?: Array<{ code?: string; isDefault?: boolean; exchangeRate?: number; baseExchangeRate?: number }>;
      contractSize?: string;
      marginFactor?: number;
      lotSize?: number;
      unit?: string;
      valueOfOnePip?: string;
    };
    snapshot?: { scalingFactor?: number };
  };
  const expiry = data.instrument?.expiry ?? '';
  const currencies = data.instrument?.currencies || [];
  const defaultCurrency = currencies.find((c) => c.isDefault);
  let currencyCode = (defaultCurrency?.code || currencies[0]?.code || '').trim();
  const minDealSize = data.dealingRules?.minDealSize?.value;
  const contractSizeRaw = data.instrument?.contractSize;
  const contractSize = contractSizeRaw ? parseFloat(contractSizeRaw) : 1;
  const marginFactor = data.instrument?.marginFactor;
  const lotSize = data.instrument?.lotSize;
  const valueOfOnePipRaw = data.instrument?.valueOfOnePip;
  const valueOfOnePip = valueOfOnePipRaw != null ? parseFloat(String(valueOfOnePipRaw)) : undefined;
  const scalingFactor = data.snapshot?.scalingFactor;
  const accountCurrency = session.currencyIsoCode || '';
  const accN = normCurrencyCode(accountCurrency);
  const dealN = normCurrencyCode(currencyCode);
  let exchangeRateToAccount: number | undefined;
  if (accN && dealN && dealN !== accN) {
    const accountCur = currencies.find((c) => {
      const code = normCurrencyCode(c.code);
      return code === accN;
    });
    const rate = accountCur ? rateFromCurrencyRow(accountCur) : undefined;
    if (rate != null) {
      exchangeRateToAccount = rate;
    }
    if (exchangeRateToAccount == null) {
      exchangeRateToAccount = await getExchangeRateFromBatch(session, epic, currencyCode);
    }
  }
  // IG may mark default instrument currency as the account CCY even when the quote ladder is in another CCY
  // (e.g. Spot Gold in USD on a SEK account). Then dealN === accN and no rate was loaded — pick another row.
  if ((!exchangeRateToAccount || exchangeRateToAccount <= 0) && accN && currencies.length > 1) {
    const foreign = currencies.find((c) => {
      const cn = normCurrencyCode(c.code);
      if (!cn || cn === accN) return false;
      return rateFromCurrencyRow(c) != null;
    });
    if (foreign?.code) {
      const r = rateFromCurrencyRow(foreign);
      if (r != null) {
        exchangeRateToAccount = r;
        if (dealN === accN) {
          currencyCode = foreign.code.trim();
        }
      }
    }
  }
  if (accN && normCurrencyCode(currencyCode) !== accN && (exchangeRateToAccount == null || exchangeRateToAccount <= 0)) {
    exchangeRateToAccount = await getExchangeRateFromBatch(session, epic, currencyCode);
  }
  if (!expiry) return null;
  return {
    expiry,
    currencyCode,
    minDealSize,
    contractSize: isNaN(contractSize) ? 1 : contractSize,
    marginFactor,
    lotSize,
    valueOfOnePip: valueOfOnePip != null && !isNaN(valueOfOnePip) ? valueOfOnePip : undefined,
    scalingFactor: scalingFactor != null && !isNaN(scalingFactor) && scalingFactor > 0 ? scalingFactor : undefined,
    exchangeRateToAccount,
  };
}

export interface CreatePositionResult {
  dealReference: string;
}

export interface CreateWorkingOrderResult {
  dealReference: string;
}

/**
 * Create OTC working order (limit/stop). POST /gateway/deal/working-orders/otc | Version: 2
 * For LIMIT: level = trigger price (buy when price falls to level, sell when price rises to level).
 */
export async function createWorkingOrder(
  session: IgSession,
  params: {
    epic: string;
    direction: 'BUY' | 'SELL';
    size: string;
    level: number;
    expiry: string;
    currencyCode: string;
    type: 'LIMIT' | 'STOP';
    timeInForce?: 'GOOD_TILL_CANCELLED' | 'GOOD_TILL_DATE';
    goodTillDate?: string;
    takeProfit?: number;
    stopLoss?: number;
    dealReference?: string;
  }
): Promise<CreateWorkingOrderResult> {
  const url = `${baseUrl()}/gateway/deal/workingorders/otc`;
  const body: Record<string, unknown> = {
    epic: params.epic,
    direction: params.direction,
    size: params.size,
    level: params.level,
    expiry: params.expiry,
    currencyCode: params.currencyCode,
    type: params.type,
    guaranteedStop: false,
    timeInForce: params.timeInForce || 'GOOD_TILL_CANCELLED',
  };
  if (params.dealReference) body.dealReference = params.dealReference;
  if (params.timeInForce === 'GOOD_TILL_DATE' && params.goodTillDate) {
    body.goodTillDate = params.goodTillDate;
  }
  if (params.takeProfit != null && !isNaN(params.takeProfit)) {
    body.limitLevel = params.takeProfit;
  }
  if (params.stopLoss != null && !isNaN(params.stopLoss)) {
    body.stopLevel = params.stopLoss;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(session), 'Version': '2', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { errorCode?: string; errorMessage?: string };
    const errCode = errBody.errorCode || '';
    const errMsg = errBody.errorMessage || '';
    const fullMsg = errCode ? `${errCode}${errMsg ? ': ' + errMsg : ''}` : `Place working order failed: ${res.status}`;
    if (res.status === 404) {
      throw new Error(`${fullMsg} (endpoint: /gateway/deal/workingorders/otc). If this persists, your IG region or API key may not support working orders.`);
    }
    throw new Error(fullMsg);
  }

  const data = (await res.json()) as { dealReference?: string };
  return { dealReference: data.dealReference || '' };
}

/**
 * Create OTC position (market deal). POST /gateway/deal/positions/otc | Version: 2
 */
export async function createPosition(
  session: IgSession,
  params: {
    epic: string;
    direction: 'BUY' | 'SELL';
    size: string;
    expiry: string;
    currencyCode: string;
    dealReference?: string;
    takeProfit?: number;
    stopLoss?: number;
    /** Entry price (offer for BUY, bid for SELL) – used to compute stopDistance/limitDistance to avoid ATTACHED_ORDER_LEVEL_ERROR */
    entryPrice?: number;
  }
): Promise<CreatePositionResult> {
  const url = `${baseUrl()}/gateway/deal/positions/otc`;
  const body: Record<string, unknown> = {
    epic: params.epic,
    direction: params.direction,
    size: params.size,
    expiry: params.expiry,
    currencyCode: params.currencyCode,
    orderType: 'MARKET',
    forceOpen: !!(params.takeProfit != null || params.stopLoss != null),
    guaranteedStop: false,
    timeInForce: 'EXECUTE_AND_ELIMINATE',
  };
  if (params.dealReference) body.dealReference = params.dealReference;

  const entry = params.entryPrice != null && !isNaN(params.entryPrice) ? params.entryPrice : undefined;

  if (params.takeProfit != null && !isNaN(params.takeProfit)) {
    if (entry != null) {
      const limitDist = params.direction === 'BUY' ? params.takeProfit - entry : entry - params.takeProfit;
      if (limitDist > 0) body.limitDistance = limitDist;
      else throw new Error(params.direction === 'BUY'
        ? 'Take profit must be above entry price for BUY'
        : 'Take profit must be below entry price for SELL');
    } else {
      body.limitLevel = params.takeProfit;
    }
  }
  if (params.stopLoss != null && !isNaN(params.stopLoss)) {
    if (entry != null) {
      const stopDist = params.direction === 'BUY' ? entry - params.stopLoss : params.stopLoss - entry;
      if (stopDist > 0) {
        body.stopDistance = stopDist;
      } else {
        throw new Error(params.direction === 'BUY'
          ? 'Stop loss must be below entry price for BUY'
          : 'Stop loss must be above entry price for SELL');
      }
    } else {
      body.stopLevel = params.stopLoss;
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(session), 'Version': '2', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { errorCode?: string; errorMessage?: string };
    throw new Error(errBody.errorCode ? `${errBody.errorCode}: ${errBody.errorMessage || ''}` : `Place deal failed: ${res.status}`);
  }

  const data = (await res.json()) as { dealReference?: string };
  return { dealReference: data.dealReference || '' };
}

export interface DealConfirmation {
  dealStatus: 'ACCEPTED' | 'REJECTED';
  reason?: string;
  dealId?: string;
  /** Close/fill level from affectedDeals (for close deals). */
  level?: number;
  /** Profit from affectedDeals (for close deals). */
  profit?: number;
  /** Profit currency from affectedDeals. */
  profitCurrency?: string;
}

/**
 * Get deal confirmation. GET /gateway/deal/confirms/{dealReference} | Version: 1
 * Returns null if confirmation not yet available (404).
 */
export async function getDealConfirmation(
  session: IgSession,
  dealReference: string
): Promise<DealConfirmation | null> {
  const url = `${baseUrl()}/gateway/deal/confirms/${encodeURIComponent(dealReference)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...authHeaders(session), 'Version': '1' },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { errorCode?: string };
    throw new Error(errBody.errorCode || `Confirmation failed: ${res.status}`);
  }
  const data = (await res.json()) as Record<string, unknown> & {
    dealStatus?: string;
    reason?: string;
    dealId?: string;
    level?: number;
    profit?: number;
    profitCurrency?: string;
    affectedDeals?: Array<{ dealStatus?: string; reason?: string; dealId?: string; level?: number; closeLevel?: number | string; profit?: number; profitCurrency?: string; status?: string }>;
  };
  const aff = data.affectedDeals?.[0];
  const status = (data.dealStatus || aff?.dealStatus || '') as 'ACCEPTED' | 'REJECTED';
  const reason = (data.reason || aff?.reason || '') as string;
  const dealId = (data.dealId || aff?.dealId || '') as string | undefined;
  // For close deals: root level = close price; affectedDeals[0].closeLevel = exit, .level may be entry
  const parseNum = (v: unknown): number | undefined => {
    const n = (typeof v === 'number' && !isNaN(v)) ? v : (typeof v === 'string' ? parseFloat(v) : NaN);
    return typeof n === 'number' && !isNaN(n) ? n : undefined;
  };
  const closeLevel = aff?.closeLevel != null ? parseNum(aff.closeLevel) : undefined;
  const level = (typeof data.level === 'number' && !isNaN(data.level))
    ? data.level
    : (closeLevel != null && !isNaN(closeLevel)
        ? closeLevel
        : (typeof aff?.level === 'number' && !isNaN(aff.level) ? aff.level : undefined));
  const profit = (typeof data.profit === 'number' && !isNaN(data.profit))
    ? data.profit
    : (typeof aff?.profit === 'number' && !isNaN(aff.profit) ? aff.profit : undefined);
  const profitCurrency = (typeof data.profitCurrency === 'string' ? data.profitCurrency : undefined)
    ?? (typeof aff?.profitCurrency === 'string' ? aff.profitCurrency : undefined);
  if (status !== 'ACCEPTED' && status !== 'REJECTED') return null;
  return { dealStatus: status, reason: reason || undefined, dealId: dealId || undefined, level, profit, profitCurrency };
}

/**
 * Get recent transaction history. GET /gateway/deal/history/transactions | Version: 2
 * Used as fallback when deal confirmation lacks level/profit.
 */
export async function getHistoryTransactions(
  session: IgSession,
  options: { type?: 'ALL' | 'ALL_DEAL' | 'DEPOSIT' | 'WITHDRAWAL'; maxSpanSeconds?: number; pageSize?: number } = {}
): Promise<Array<{ closeLevel?: number; openLevel?: number; profitAndLoss?: number; currency?: string; instrumentName?: string; dateUtc?: string }>> {
  const { type = 'ALL_DEAL', maxSpanSeconds = 120, pageSize = 50 } = options;
  const url = `${baseUrl()}/gateway/deal/history/transactions?type=${type}&maxSpanSeconds=${maxSpanSeconds}&pageSize=${pageSize}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...authHeaders(session), 'Version': '2' },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    metadata?: { pageData?: { totalSize?: number } };
    transactions?: Array<{
      closeLevel?: string | number;
      openLevel?: string | number;
      profitAndLoss?: string | number;
      currency?: string;
      instrumentName?: string;
      dateUtc?: string;
    }>;
  };
  const txs = data.transactions || [];
  return txs.map((t) => {
    const parse = (v: string | number | undefined): number | undefined => {
      if (v == null) return undefined;
      const n = typeof v === 'number' ? v : parseFloat(String(v));
      return !isNaN(n) ? n : undefined;
    };
    return {
      closeLevel: parse(t.closeLevel),
      openLevel: parse(t.openLevel),
      profitAndLoss: parse(t.profitAndLoss),
      currency: t.currency,
      instrumentName: t.instrumentName,
      dateUtc: t.dateUtc,
    };
  });
}

/**
 * Poll deal confirmation until ACCEPTED or REJECTED, or timeout.
 */
export async function pollDealConfirmation(
  session: IgSession,
  dealReference: string,
  options: { maxAttempts?: number; intervalMs?: number } = {}
): Promise<DealConfirmation> {
  const { maxAttempts = 30, intervalMs = 500 } = options;
  for (let i = 0; i < maxAttempts; i++) {
    const conf = await getDealConfirmation(session, dealReference);
    if (conf) return conf;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Deal confirmation timeout');
}

export interface IndicativeCostsResult {
  openingSpread: number;
  closingSpread: number;
  currencyCodeISO: string;
  notionalValue?: number;
  notionalValueInUserCurrency?: number;
}

/**
 * Get indicative costs and charges for opening. POST /gateway/deal/indicativecostsandcharges/open
 * Returns exact spread costs as shown in IG deal ticket.
 */
export async function getIndicativeCostsOpen(
  session: IgSession,
  params: {
    epic: string;
    direction: 'BUY' | 'SELL';
    size: number;
    bid: number;
    ask: number;
    dealCurrencyCode: string;
  }
): Promise<IndicativeCostsResult | null> {
  const dealReference = crypto.randomUUID?.() || `indicative-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const url = `${baseUrl()}/gateway/deal/indicativecostsandcharges/open`;
  const body = {
    epic: params.epic,
    direction: params.direction,
    size: params.size,
    bid: params.bid,
    ask: params.ask,
    dealCurrencyCode: params.dealCurrencyCode,
    dealReference,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(session), 'Version': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    openingSpread?: number;
    closingSpread?: number;
    currencyCodeISO?: string;
    notionalValue?: number;
    notionalValueInUserCurrency?: number;
  };
  const openingSpread = typeof data.openingSpread === 'number' ? data.openingSpread : 0;
  const closingSpread = typeof data.closingSpread === 'number' ? data.closingSpread : 0;
  const currencyCodeISO = data.currencyCodeISO || params.dealCurrencyCode;
  return {
    openingSpread,
    closingSpread,
    currencyCodeISO,
    notionalValue: data.notionalValue,
    notionalValueInUserCurrency: data.notionalValueInUserCurrency,
  };
}

export interface MarketTradingInfo {
  defaultCloseAt: string | null;
  /** True if market trades 24/7 (e.g. crypto) – no weekend exclusion for probes. */
  is24_7: boolean;
  /** IG opening hours per day (see dealing schedule builder). Omitted when API fails. */
  marketTimes?: Array<{ openTime?: string; closeTime?: string }>;
}

export interface ClientSentiment {
  longPct: number;
  shortPct: number;
}

/**
 * Get IG client sentiment for a market. Bull = long > short, Bear = short > long, Neutral = within 5%.
 * Not all instruments support sentiment; returns null when unavailable.
 * @param debugLog - optional callback to log raw API response when returning null (for debugging)
 */
export async function getClientSentiment(
  session: IgSession,
  epic: string,
  options?: { debugLog?: (msg: string) => void }
): Promise<ClientSentiment | null> {
  const url = `${baseUrl()}/gateway/deal/clientsentiment?marketIds=${encodeURIComponent(epic)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...authHeaders(session), 'Version': '3' },
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { errorCode?: string; errorMessage?: string };
    const detail = errBody.errorCode || errBody.errorMessage ? `${errBody.errorCode || ''} ${errBody.errorMessage || ''}`.trim() : res.statusText;
    throw new Error(`Client sentiment ${res.status} for ${epic}: ${detail || res.statusText}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const sentiments = (Array.isArray(data.clientSentiments) ? data.clientSentiments : []) as Array<{
    marketId?: string;
    longPositionPercentage?: number;
    shortPositionPercentage?: number;
  }>;
  const match = sentiments.find((s) => (s.marketId || '').toUpperCase() === epic.toUpperCase()) ?? sentiments[0];
  if (!match) {
    options?.debugLog?.('Sentiment: API returned no match. Raw: ' + JSON.stringify(data));
    return null;
  }
  const longPct = typeof match.longPositionPercentage === 'number' ? match.longPositionPercentage : 0;
  const shortPct = typeof match.shortPositionPercentage === 'number' ? match.shortPositionPercentage : 0;
  if (longPct === 0 && shortPct === 0) {
    options?.debugLog?.('Sentiment: API returned 0/0. Raw: ' + JSON.stringify(data));
    return null;
  }
  return { longPct, shortPct };
}

/** Pull marketTimes from instrument; openingHours is canonical per IG docs. */
function extractMarketTimesFromInstrument(
  instrument: unknown
): Array<{ openTime?: string; closeTime?: string }> | undefined {
  if (!instrument || typeof instrument !== 'object') return undefined;
  const inst = instrument as Record<string, unknown>;
  const fromNested = (obj: unknown): Array<{ openTime?: string; closeTime?: string }> | undefined => {
    if (!obj || typeof obj !== 'object') return undefined;
    const mt = (obj as { marketTimes?: unknown }).marketTimes;
    if (Array.isArray(mt) && mt.length > 0) return mt as Array<{ openTime?: string; closeTime?: string }>;
    return undefined;
  };
  return fromNested(inst.openingHours) ?? fromNested(inst.expiryDetails);
}

/**
 * Fetch market times and derive defaultCloseAt + is24_7. Single API call.
 * is24_7: true only when every row has no close time (IG omits close for always-on markets). A 7-day Mon–Sun schedule is not 24/7.
 */
export async function getMarketTradingInfo(session: IgSession, epic: string): Promise<MarketTradingInfo> {
  const url = `${baseUrl()}/gateway/deal/markets/${encodeURIComponent(epic)}`;
  const fetchJson = async (version: string) => {
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...authHeaders(session), Version: version },
    });
    if (!res.ok) return null;
    return (await res.json()) as { instrument?: unknown };
  };
  let data = await fetchJson('4');
  let marketTimes = data ? extractMarketTimesFromInstrument(data.instrument) : undefined;
  if (!data || !marketTimes?.length) {
    const alt = await fetchJson('3');
    if (alt) {
      const mt = extractMarketTimesFromInstrument(alt.instrument);
      if (mt && mt.length > 0) {
        data = alt;
        marketTimes = mt;
      } else if (!data) {
        data = alt;
        marketTimes = mt;
      }
    }
  }
  if (!data) return { defaultCloseAt: null, is24_7: false };
  const is24_7 =
    Array.isArray(marketTimes) &&
    marketTimes.length > 0 &&
    marketTimes.every((m) => !(m.closeTime?.trim() ?? ''));
  const defaultCloseAt = computeDefaultCloseAt(marketTimes);
  return {
    defaultCloseAt,
    is24_7,
    marketTimes: Array.isArray(marketTimes) ? marketTimes.map((m) => ({ openTime: m.openTime, closeTime: m.closeTime })) : undefined,
  };
}

function computeDefaultCloseAt(marketTimes: Array<{ openTime?: string; closeTime?: string }> | undefined): string | null {
  const nowForTz = new Date();
  const ukTzName = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'short' }).formatToParts(nowForTz).find((p) => p.type === 'timeZoneName')?.value ?? '';
  const ukBst = ukTzName === 'BST';
  let closeHourUtc = ukBst ? 20 : 21;
  let closeMinUtc = 59;
  if (Array.isArray(marketTimes) && marketTimes.length > 0) {
    const closes = marketTimes
      .map((m) => m.closeTime?.trim())
      .filter((t): t is string => !!t && t !== '');
    if (closes.length > 0) {
      const latest = closes.reduce((a, b) => (a > b ? a : b));
      const [h, m] = latest.split(/[:\s]/).map((s) => parseInt(s, 10));
      if (!isNaN(h) && h >= 0 && h <= 23) {
        closeHourUtc = h;
        closeMinUtc = isNaN(m) || m < 0 || m > 59 ? 0 : m;
      }
    }
  }
  closeMinUtc -= 1;
  if (closeMinUtc < 0) {
    closeMinUtc += 60;
    closeHourUtc -= 1;
    if (closeHourUtc < 0) closeHourUtc += 24;
  }
  const now = new Date();
  const ukParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => ukParts.find((p) => p.type === type)?.value ?? '0';
  const ukYear = parseInt(get('year'), 10);
  const ukMonth = parseInt(get('month'), 10) - 1;
  const ukDay = parseInt(get('day'), 10);
  let closeDate = new Date(Date.UTC(ukYear, ukMonth, ukDay, closeHourUtc, closeMinUtc, 0, 0));
  if (closeDate <= now) {
    closeDate = new Date(Date.UTC(ukYear, ukMonth, ukDay + 1, closeHourUtc, closeMinUtc, 0, 0));
  }
  return closeDate.toISOString();
}

/**
 * Get default close time for intraday. Wraps getMarketTradingInfo for backward compatibility.
 */
export async function getDefaultCloseAt(session: IgSession, epic: string): Promise<string | null> {
  const info = await getMarketTradingInfo(session, epic);
  return info.defaultCloseAt;
}

/** Infer expiry from epic when API unavailable: CFD/CFE/CASH use "-", spreadbet uses DFB. */
export function inferExpiry(epic: string, configDefault?: string): string {
  if (configDefault && configDefault !== 'DFB') return configDefault;
  return /\.(CFD|CFE|CASH)\.|\.(CFD|CFE)$|CASH\.|\.SPRINT\./i.test(epic) ? '-' : (configDefault || 'DFB');
}

export interface Position {
  dealId: string;
  dealReference?: string;
  epic: string;
  expiry?: string;
  instrumentName?: string;
  direction: 'BUY' | 'SELL';
  size: number;
  level: number;
  limitLevel?: number;
  stopLevel?: number;
  createdAt: string;
  contractSize?: number;
  currency?: string;
  bid?: number;
  offer?: number;
}

export interface WorkingOrder {
  dealId: string;
  epic: string;
  expiry?: string;
  instrumentName?: string;
  direction: 'BUY' | 'SELL';
  orderType: 'LIMIT' | 'STOP';
  orderLevel: number;
  orderSize: number;
  limitLevel?: number;
  stopLevel?: number;
  timeInForce?: string;
  goodTillDate?: string;
  createdAt: string;
  currencyCode?: string;
  bid?: number;
  offer?: number;
}

/**
 * Get open working orders. GET /gateway/deal/workingorders | Version: 2
 * (Uses workingorders for consistency with POST; IG docs show working-orders)
 */
export async function getWorkingOrders(session: IgSession): Promise<WorkingOrder[]> {
  const url = `${baseUrl()}/gateway/deal/workingorders`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...authHeaders(session), 'Version': '2' },
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { errorCode?: string };
    throw new Error(errBody.errorCode || `Working orders failed: ${res.status}`);
  }

  const data = (await res.json()) as Record<string, unknown> & {
    workingOrders?: Array<{
      workingOrderData?: {
        dealId?: string;
        epic?: string;
        direction?: string;
        orderType?: string;
        orderLevel?: number;
        orderSize?: number;
        limitLevel?: number;
        limitDistance?: number;
        stopLevel?: number;
        stopDistance?: number;
        timeInForce?: string;
        goodTillDate?: string;
        goodTillDateISO?: string;
        createdDate?: string;
        createdDateUTC?: string;
        currencyCode?: string;
      };
      marketData?: {
        epic?: string;
        expiry?: string;
        instrumentName?: string;
        bid?: number;
        offer?: number;
      };
    }>;
  };

  const raw = (data.workingOrders || data['working-orders'] || []) as typeof data.workingOrders;
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((w) => w.workingOrderData?.dealId)
    .map((w) => {
      const od = w.workingOrderData!;
      const md = w.marketData || {};
      const direction = (od.direction || 'BUY') as 'BUY' | 'SELL';
      const orderLevel = od.orderLevel ?? 0;
      let limitLevel = od.limitLevel;
      let stopLevel = od.stopLevel;
      if (limitLevel == null && od.limitDistance != null && !isNaN(od.limitDistance)) {
        limitLevel = direction === 'BUY' ? orderLevel + od.limitDistance : orderLevel - od.limitDistance;
      }
      if (stopLevel == null && od.stopDistance != null && !isNaN(od.stopDistance)) {
        stopLevel = direction === 'BUY' ? orderLevel - od.stopDistance : orderLevel + od.stopDistance;
      }
      return {
        dealId: od.dealId!,
        epic: od.epic || md.epic || '',
        expiry: md.expiry,
        instrumentName: md.instrumentName,
        direction,
        orderType: (od.orderType || 'LIMIT') as 'LIMIT' | 'STOP',
        orderLevel,
        orderSize: od.orderSize ?? 0,
        limitLevel,
        stopLevel,
        timeInForce: od.timeInForce,
        goodTillDate: od.goodTillDateISO || od.goodTillDate,
        createdAt: od.createdDateUTC || od.createdDate || '',
        currencyCode: od.currencyCode,
        bid: md.bid,
        offer: md.offer,
      };
    });
}

/**
 * Delete working order. POST with _method: DELETE to /gateway/deal/workingorders/otc/{dealId}
 */
export async function deleteWorkingOrder(session: IgSession, dealId: string): Promise<{ dealReference: string }> {
  const url = `${baseUrl()}/gateway/deal/workingorders/otc/${encodeURIComponent(dealId)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(session),
      'Version': '2',
      'Content-Type': 'application/json',
      '_method': 'DELETE',
    },
    body: JSON.stringify({}),
  });

  const resBody = (await res.json().catch(() => ({}))) as { errorCode?: string; errorMessage?: string; dealReference?: string };
  if (!res.ok) {
    const errMsg = resBody.errorCode ? `${resBody.errorCode}: ${resBody.errorMessage || ''}` : `Delete order failed: ${res.status}`;
    throw new Error(errMsg);
  }
  return { dealReference: resBody.dealReference || '' };
}

/**
 * Get open positions. GET /gateway/deal/positions | Version: 2
 */
export async function getPositions(session: IgSession): Promise<Position[]> {
  const url = `${baseUrl()}/gateway/deal/positions`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...authHeaders(session), 'Version': '2' },
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { errorCode?: string };
    throw new Error(errBody.errorCode || `Positions failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    positions?: Array<{
      position?: { dealId?: string; dealReference?: string; direction?: string; size?: number; level?: number; limitLevel?: number; stopLevel?: number; createdDate?: string; contractSize?: number; currency?: string };
      market?: { epic?: string; expiry?: string; instrumentName?: string; bid?: number; offer?: number };
    }>;
  };

  const positions = data.positions || [];
  return positions
    .filter((p) => p.position?.dealId && p.market?.epic)
    .map((p) => {
      const epic = p.market!.epic!;
      const expiry = p.market?.expiry || inferExpiry(epic);
      const contractSize = p.position?.contractSize ?? 1;
      return {
        dealId: p.position!.dealId!,
        dealReference: p.position!.dealReference,
        epic,
        expiry,
        instrumentName: p.market?.instrumentName,
        direction: (p.position!.direction || 'BUY') as 'BUY' | 'SELL',
        size: p.position!.size ?? 0,
        level: p.position!.level ?? 0,
        limitLevel: p.position!.limitLevel,
        stopLevel: p.position!.stopLevel,
        createdAt: p.position!.createdDate || '',
        contractSize,
        currency: p.position?.currency,
        bid: p.market?.bid,
        offer: p.market?.offer,
      };
    });
}

/**
 * Close OTC position. POST with _method: DELETE (IG Python lib pattern; some clients reject DELETE+body).
 * Sends dealId + epic + expiry like trading-ig; omit null/undefined fields.
 */
export async function closePosition(
  session: IgSession,
  params: { dealId?: string; epic?: string; expiry?: string; direction: 'BUY' | 'SELL'; size: number }
): Promise<{ dealReference: string }> {
  const url = `${baseUrl()}/gateway/deal/positions/otc`;
  const size = Number(params.size);
  if (!(size > 0 && !isNaN(size))) {
    throw new Error('Close position: size must be a positive number');
  }
  const body: Record<string, unknown> = {
    direction: params.direction,
    orderType: 'MARKET',
    size,
    timeInForce: 'EXECUTE_AND_ELIMINATE',
  };
  if (params.dealId?.trim()) {
    body.dealId = params.dealId.trim();
  } else if (params.epic && params.expiry) {
    body.epic = params.epic;
    body.expiry = params.expiry;
  } else {
    throw new Error('Close position: provide dealId or epic+expiry');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(session),
      'Version': '1',
      'Content-Type': 'application/json',
      '_method': 'DELETE',
    },
    body: JSON.stringify(body),
  });

  const resBody = await res.json().catch(() => ({})) as { errorCode?: string; errorMessage?: string; dealReference?: string };
  if (!res.ok) {
    const errMsg = resBody.errorCode ? `${resBody.errorCode}: ${resBody.errorMessage || ''}` : `Close failed: ${res.status}`;
    throw new Error(errMsg);
  }

  return { dealReference: resBody.dealReference || '' };
}

/**
 * Update stop (and optionally limit) on an open OTC position.
 * PUT /gateway/deal/positions/otc/{dealId} | Version: 2
 */
export async function updatePositionStop(
  session: IgSession,
  dealId: string,
  params: { stopLevel: number; limitLevel?: number | null }
): Promise<{ dealReference: string }> {
  const id = dealId?.trim();
  if (!id) throw new Error('updatePositionStop: dealId required');
  const stopLevel = params.stopLevel;
  if (stopLevel == null || isNaN(stopLevel)) throw new Error('updatePositionStop: stopLevel required');

  const url = `${baseUrl()}/gateway/deal/positions/otc/${encodeURIComponent(id)}`;
  const body: Record<string, unknown> = { stopLevel };
  if (params.limitLevel != null && !isNaN(params.limitLevel)) {
    body.limitLevel = params.limitLevel;
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...authHeaders(session), 'Version': '2', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const resBody = (await res.json().catch(() => ({}))) as {
    errorCode?: string;
    errorMessage?: string;
    dealReference?: string;
  };
  if (!res.ok) {
    const errMsg = resBody.errorCode
      ? `${resBody.errorCode}: ${resBody.errorMessage || ''}`
      : `Update position failed: ${res.status}`;
    throw new Error(errMsg.trim());
  }
  return { dealReference: resBody.dealReference || '' };
}

export interface HistoricalPriceSample {
  ts: number;
  mid: number;
  spread: number;
}

export interface HistoricalPricesAllowance {
  total: number;
  remaining: number;
  expirySeconds: number;
}

/**
 * Get historical OHLC prices. GET /gateway/deal/prices/{epic} | Version: 3
 * Uses HOUR resolution to minimise allowance (e.g. 72 points for 3 days).
 * Returns samples as { ts, mid, spread } for probes backfill.
 */
export async function getHistoricalPrices(
  session: IgSession,
  epic: string,
  options: { resolution?: 'MINUTE' | 'HOUR'; days?: number }
): Promise<{ samples: HistoricalPriceSample[]; allowance: HistoricalPricesAllowance }> {
  const resolution = options.resolution || 'HOUR';
  const days = Math.min(Math.max(options.days ?? 3, 1), 30);
  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - days * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) =>
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0') +
    'T' +
    String(d.getHours()).padStart(2, '0') +
    ':' +
    String(d.getMinutes()).padStart(2, '0') +
    ':' +
    String(d.getSeconds()).padStart(2, '0');
  const from = fmt(fromDate);
  const to = fmt(toDate);
  const url = `${baseUrl()}/gateway/deal/prices/${encodeURIComponent(epic)}?resolution=${resolution}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&pageSize=0`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...authHeaders(session), 'Version': '3' },
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { errorCode?: string; errorMessage?: string };
    throw new Error(errBody.errorCode ? `${errBody.errorCode}: ${errBody.errorMessage || ''}` : `Historical prices failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    prices?: Array<{
      snapshotTimeUTC?: string;
      closePrice?: { bid?: number; ask?: number };
      highPrice?: { bid?: number; ask?: number };
      lowPrice?: { bid?: number; ask?: number };
    }>;
    metadata?: {
      allowance?: { totalAllowance?: number; remainingAllowance?: number; allowanceExpiry?: number };
      pageData?: { allowance?: { totalAllowance?: number; remainingAllowance?: number; allowanceExpiry?: number } };
    };
  };
  const allowance = data.metadata?.allowance ?? data.metadata?.pageData?.allowance ?? {};
  const total = allowance.totalAllowance ?? 0;
  const remaining = allowance.remainingAllowance ?? 0;
  const expirySeconds = allowance.allowanceExpiry ?? 0;
  const prices = data.prices ?? [];
  const samples: HistoricalPriceSample[] = [];
  for (const p of prices) {
    const ts = p.snapshotTimeUTC ? new Date(p.snapshotTimeUTC).getTime() : 0;
    if (isNaN(ts) || !ts) continue;
    const close = p.closePrice;
    const high = p.highPrice;
    const low = p.lowPrice;
    const parseMid = (obj: { bid?: number; ask?: number } | undefined): number | null => {
      if (!obj) return null;
      const b = typeof obj.bid === 'number' ? obj.bid : parseFloat(String(obj?.bid ?? 0));
      const a = typeof obj.ask === 'number' ? obj.ask : parseFloat(String(obj?.ask ?? 0));
      if (isNaN(b) || isNaN(a)) return null;
      return (b + a) / 2;
    };
    const closeMid = parseMid(close);
    if (closeMid == null) continue;
    const spread = close && typeof close.ask === 'number' && typeof close.bid === 'number' ? close.ask - close.bid : 0;
    samples.push({ ts, mid: closeMid, spread });
    const lowMid = parseMid(low);
    const highMid = parseMid(high);
    if (lowMid != null) samples.push({ ts: ts + 1, mid: lowMid, spread });
    if (highMid != null) samples.push({ ts: ts + 2, mid: highMid, spread });
  }
  return {
    samples,
    allowance: { total, remaining, expirySeconds },
  };
}

/** Format date for IG /prices from= to= query (must align with snapshotTimeUTC, i.e. UTC — not server local time). */
function fmtUtcForPricesQuery(d: Date): string {
  return (
    d.getUTCFullYear() +
    '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getUTCDate()).padStart(2, '0') +
    'T' +
    String(d.getUTCHours()).padStart(2, '0') +
    ':' +
    String(d.getUTCMinutes()).padStart(2, '0') +
    ':' +
    String(d.getUTCSeconds()).padStart(2, '0')
  );
}

function londonCalendarDateKey(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

function openPriceMid(open?: { bid?: number; ask?: number }): number | null {
  if (!open) return null;
  const b = typeof open.bid === 'number' ? open.bid : parseFloat(String(open.bid ?? ''));
  const a = typeof open.ask === 'number' ? open.ask : parseFloat(String(open.ask ?? ''));
  if (!isNaN(b) && !isNaN(a)) return (b + a) / 2;
  if (!isNaN(a)) return a;
  if (!isNaN(b)) return b;
  return null;
}

/**
 * Day-open level for probes/rules: open of the IG daily candle, aligned with platform charts.
 * Uses DAY resolution; from/to are UTC (was incorrectly using server local time before).
 * Picks the candle for today's Europe/London calendar date when present, else the latest candle.
 * Returns mid (bid+ask)/2 when both exist — matches chart open better than ask alone.
 */
export async function getDayStartPrice(session: IgSession, epic: string): Promise<number | null> {
  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  const from = fmtUtcForPricesQuery(fromDate);
  const to = fmtUtcForPricesQuery(toDate);
  const url = `${baseUrl()}/gateway/deal/prices/${encodeURIComponent(epic)}?resolution=DAY&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&pageSize=0`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...authHeaders(session), 'Version': '3' },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    prices?: Array<{
      snapshotTimeUTC?: string;
      openPrice?: { bid?: number; ask?: number };
    }>;
  };
  const prices = data.prices ?? [];
  if (prices.length === 0) return null;
  const withTs = prices
    .map((p) => ({ p, ts: p.snapshotTimeUTC ? new Date(p.snapshotTimeUTC).getTime() : 0 }))
    .filter((x) => x.ts > 0);
  if (withTs.length === 0) return null;
  const todayLondon = londonCalendarDateKey(Date.now());
  const todayCandles = withTs.filter((x) => londonCalendarDateKey(x.ts) === todayLondon);
  const chosen = (
    todayCandles.length > 0
      ? todayCandles.reduce((a, b) => (a.ts >= b.ts ? a : b))
      : withTs.reduce((a, b) => (a.ts >= b.ts ? a : b))
  ).p;
  const mid = openPriceMid(chosen.openPrice);
  return mid;
}
