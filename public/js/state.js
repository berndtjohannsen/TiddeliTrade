/**
 * Shared mutable state used across modules.
 */
export const state = {
  accountCurrency: '',
  currentBid: null,
  currentOffer: null,
  currentSpread: null,
  currentUpdateTime: null,
  /** Trend for Now: up/down/flat based on current vs previous mid price */
  currentTrend: null,
  _prevBid: null,
  _prevOffer: null,
  currentMinDealSize: null,
  currentDealCurrency: '',
  currentContractSize: 1,
  currentLotSize: null,
  currentMarginFactor: null,
  currentValueOfOnePip: null,
  currentScalingFactor: null,
  currentExchangeRateToAccount: null,
  currentPositions: [],
  currentWorkingOrders: [],
  recentlyClosedDealIds: {},
  recentlyDeletedDealIds: {},
  savedWatchlistId: '',
  savedEpic: '',
  /** From marketDetails: true if market trades 24/7 (crypto). Used by probes for weekend exclusion. */
  is24_7Market: false,
  /** From marketDetails: today/next market close time (ISO string). Used for engine auto-stop. */
  defaultCloseAt: null,
  /** From marketDetails: IG client sentiment { longPct, shortPct } or null. */
  clientSentiment: null,
  /** Buy (offer) price at market/day start. From IG API daily open. */
  dayStartBuy: null,
  /** Active IG profile: 'demo' or 'live'. From account response or config. */
  activeProfile: 'demo',
  /** App/engine status: 'ready' | 'connecting' | 'running'. Used for Start/Stop button. */
  engineStatus: 'ready',
  /** Trading rules engine: true when rules can place deals. Used to block epic/watchlist change. */
  rulesEngineRunning: false,
  /** Deal placement in progress (waiting for confirmation). Blocks rules engine from re-triggering. */
  dealInProgress: false,
  /** Set just before emit: 'rules' | 'manual' — cleared when deal_placed/deal_error runs. */
  pendingDealPlacementSource: null,
  /** Last accepted deal metadata for rules UI (e.g. track rules-originated deal ids). Cleared by tradingRules on deal_placed. */
  dealJustPlaced: null,
  /** Server dynamic SL status per open deal (dealId, highestLockApplied, lastMessage, …). */
  dynamicStopLossStatus: [],
  /**
   * Rules engine: IG accepted a deal but `currentPositions` may not include it yet — treat as "has position"
   * for this epic until the positions list catches up (avoids double-submit). Cleared when epic appears or timeout.
   */
  pendingRulesPositionEpic: null,
  pendingRulesPositionSinceMs: null
};
