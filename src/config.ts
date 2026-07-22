import fs from 'fs';
import path from 'path';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');

export type IgProfileId = 'demo' | 'live';

export interface IgProfile {
  igApiKey?: string;
  igUsername?: string;
  igPassword?: string;
  /** IG API base URL. Demo default: https://demo-api.ig.com, Live default: https://api.ig.com */
  igBaseUrl?: string;
}

const DEFAULT_BASE_URL_DEMO = 'https://demo-api.ig.com';
const DEFAULT_BASE_URL_LIVE = 'https://api.ig.com';

export interface UserConfig {
  /** IG API key (legacy – migrated to igProfiles) */
  igApiKey?: string;
  /** IG username (legacy) */
  igUsername?: string;
  /** IG password (legacy) */
  igPassword?: string;
  /** Credentials per profile. demo → demo-api.ig.com, live → api.ig.com */
  igProfiles?: Record<IgProfileId, IgProfile>;
  /** Which profile to use for login */
  activeProfile?: IgProfileId;
  /** Last selected watchlist ID */
  watchlistId?: string;
  /** Last selected epic (e.g. CS.D.CFDGOLD.CFD.IP) */
  epic?: string;
  /** Default trade size */
  defaultSize?: string;
  /** Default expiry (e.g. DFB, D) */
  defaultExpiry?: string;
  /** Currency code for orders */
  currencyCode?: string;
  /** UI preferences */
  ui?: {
    theme?: 'dark' | 'light';
    maPeriod?: number;
    /** Log window height in pixels */
    logWindowHeight?: number;
    /** Probe periods in minutes: short, medium, long */
    probesShortPeriod?: number;
    probesMediumPeriod?: number;
    probesLongPeriod?: number;
    /** Max days to backfill for probes (cap; actual backfill = longest probe period, uses IG allowance) */
    probesBackfillDays?: number;
    /** Trading rules: true = engine running (manual trading disabled), false = engine stopped */
    tradingRulesRunning?: boolean;
    /** When false, engine places deals automatically without confirmation dialog */
    tradingRulesConfirmBeforePlace?: boolean;
    tradingRulesScheduleStartTime?: string;
    tradingRulesScheduleStopTime?: string;
    tradingRulesScheduleRepeatDaily?: boolean;
    tradingRulesScheduleActiveDate?: string;
    /** Rules to evaluate: left (live value) op right (reference). All enabled must pass. No deal if position/order exists. @deprecated Use ruleSets instead. */
    tradingRules?: Array<{ left: string; op: string; right: string; enabled?: boolean }>;
    /** Per-direction rule sets: BUY rules + deal params, SELL rules + deal params. Evaluation order: BUY first, then SELL. */
    ruleSets?: {
      buy?: {
        /** @deprecated Prefer ruleGroups; still derived in UI for evaluation */
        rules?: Array<{ left: string; op: string; right: string; enabled?: boolean }>;
        ruleGroups?: { short?: unknown[]; medium?: unknown[]; long?: unknown[]; other?: unknown[] };
        dealSize?: string;
        takeProfit?: string;
        stopLoss?: string;
        tpSlMode?: string;
      };
      sell?: {
        rules?: Array<{ left: string; op: string; right: string; enabled?: boolean }>;
        ruleGroups?: { short?: unknown[]; medium?: unknown[]; long?: unknown[]; other?: unknown[] };
        dealSize?: string;
        takeProfit?: string;
        stopLoss?: string;
        tpSlMode?: string;
      };
    };
    /** Auto-stop engine: when true, engine stops N minutes before market close (or midnight for 24/7). Default true. */
    tradingRulesAutoStopEnabled?: boolean;
    /** Minutes before close/midnight to auto-stop. Default 60 (1h). */
    tradingRulesAutoStopBeforeMinutes?: number;
    tradingRulesAutoStopEnabledBuy?: boolean;
    tradingRulesAutoStopEnabledSell?: boolean;
    tradingRulesAutoStopBeforeMinutesBuy?: number;
    tradingRulesAutoStopBeforeMinutesSell?: number;
    tradingRulesStopAfterLossBuy?: boolean;
    tradingRulesStopAfterLossSell?: boolean;
    /** Unified stop-after-loss (both directions). */
    tradingRulesStopAfterLoss?: boolean;
    /** Seconds to pause engine after a losing trade. 0 = disabled. */
    tradingRulesPauseOnLossSeconds?: number;
    tradingRulesPauseOnLossSecondsBuy?: number;
    tradingRulesPauseOnLossSecondsSell?: number;
    /** Deal form settings (persisted for rules trading) */
    dealDirection?: string;
    dealSize?: string;
    dealTpSlMode?: string;
    dealTakeProfit?: string;
    dealStopLoss?: string;
    dealCloseAt?: string;
    /** Dynamic stop loss: trail profit via IG stop; no take profit while enabled. */
    dealDynamicStopLossEnabled?: boolean;
    dealDynamicStopLossTrigger?: number | string;
    dealDynamicStopLossLock?: number | string;
    dealDynamicStopLossMinStep?: number | string;
    dealDynamicStopLossUpdateSec?: number | string;
    rulesDynamicStopLossEnabledBuy?: boolean;
    rulesDynamicStopLossTriggerBuy?: number | string;
    rulesDynamicStopLossLockBuy?: number | string;
    rulesDynamicStopLossEnabledSell?: boolean;
    rulesDynamicStopLossTriggerSell?: number | string;
    rulesDynamicStopLossLockSell?: number | string;
    /** Per-instrument settings (deal, order, rules). Key = epic. */
    instruments?: Record<string, InstrumentSettings>;
  };
}

/** Per-instrument deal, order, and rules settings */
export interface InstrumentSettings {
  dealDirection?: string;
  dealSize?: string;
  dealTpSlMode?: string;
  dealTakeProfit?: string;
  dealStopLoss?: string;
  dealCloseAt?: string;
  dealDynamicStopLossEnabled?: boolean;
  dealDynamicStopLossTrigger?: number | string;
  dealDynamicStopLossLock?: number | string;
  dealDynamicStopLossMinStep?: number | string;
  dealDynamicStopLossUpdateSec?: number | string;
  rulesDynamicStopLossEnabledBuy?: boolean;
  rulesDynamicStopLossTriggerBuy?: number | string;
  rulesDynamicStopLossLockBuy?: number | string;
  rulesDynamicStopLossEnabledSell?: boolean;
  rulesDynamicStopLossTriggerSell?: number | string;
  rulesDynamicStopLossLockSell?: number | string;
  orderDirection?: string;
  orderSize?: string;
  orderTpSlMode?: string;
  orderTakeProfit?: string;
  orderStopLoss?: string;
  orderCloseAt?: string;
  orderStopAt?: string;
  tradingRules?: Array<{ left: string; op: string; right: string; enabled?: boolean }>;
  ruleSets?: {
    buy?: {
      rules?: Array<{ left: string; op: string; right: string; enabled?: boolean }>;
      ruleGroups?: { short?: unknown[]; medium?: unknown[]; long?: unknown[]; other?: unknown[] };
      dealSize?: string;
      takeProfit?: string;
      stopLoss?: string;
      tpSlMode?: string;
    };
    sell?: {
      rules?: Array<{ left: string; op: string; right: string; enabled?: boolean }>;
      ruleGroups?: { short?: unknown[]; medium?: unknown[]; long?: unknown[]; other?: unknown[] };
      dealSize?: string;
      takeProfit?: string;
      stopLoss?: string;
      tpSlMode?: string;
    };
  };
  tradingRulesRunning?: boolean;
  tradingRulesConfirmBeforePlace?: boolean;
  tradingRulesAutoStopEnabled?: boolean;
  tradingRulesAutoStopBeforeMinutes?: number;
  tradingRulesAutoStopEnabledBuy?: boolean;
  tradingRulesAutoStopEnabledSell?: boolean;
  tradingRulesAutoStopBeforeMinutesBuy?: number;
  tradingRulesAutoStopBeforeMinutesSell?: number;
  tradingRulesPauseOnLossSeconds?: number;
  tradingRulesPauseOnLossSecondsBuy?: number;
  tradingRulesPauseOnLossSecondsSell?: number;
  /** When true, a rules deal that closes at a loss stops that direction’s engine until restarted. */
  tradingRulesStopAfterLoss?: boolean;
  tradingRulesStopAfterLossBuy?: boolean;
  tradingRulesStopAfterLossSell?: boolean;
  tradingRulesScheduleStartTime?: string;
  tradingRulesScheduleStopTime?: string;
  tradingRulesScheduleRepeatDaily?: boolean;
  tradingRulesScheduleActiveDate?: string;
  rulesRunningBuy?: boolean;
  rulesRunningSell?: boolean;
  /** When false, BUY rules are skipped while the engine is running. Default true. */
  rulesBuyEnabled?: boolean;
  /** When false, SELL rules are skipped while the engine is running. Default true. */
  rulesSellEnabled?: boolean;
  /** Saved Research backtest profiles for this instrument. */
  backtestProfiles?: BacktestProfile[];
}

/** Named snapshot of strategy + analyse options + last simulated result. */
export interface BacktestProfile {
  id: string;
  name: string;
  savedAt: number;
  strategy: BacktestProfileStrategy;
  analyseOptions: BacktestProfileAnalyseOptions;
  lastResult?: BacktestProfileLastResult;
}

export interface BacktestProfileStrategy {
  ruleSets: {
    buy: BacktestProfileRuleSide;
    sell: BacktestProfileRuleSide;
  };
  dynamicSl: {
    buy: BacktestProfileDynamicSl;
    sell: BacktestProfileDynamicSl;
  };
  probeShortMinutes: number;
  probeMediumMinutes: number;
  probeLongMinutes: number;
}

export interface BacktestProfileRuleSide {
  ruleGroups?: {
    short?: Array<{ left: string; op: string; right: string; enabled?: boolean }>;
    medium?: Array<{ left: string; op: string; right: string; enabled?: boolean }>;
    long?: Array<{ left: string; op: string; right: string; enabled?: boolean }>;
    other?: Array<{ left: string; op: string; right: string; enabled?: boolean }>;
  };
  dealSize?: string;
  takeProfit?: string | null;
  stopLoss?: string | null;
  tpSlMode?: string;
}

export interface BacktestProfileDynamicSl {
  enabled: boolean;
  trigger?: string | null;
  lock?: string | null;
}

export interface BacktestProfileAnalyseOptions {
  selectedDays?: string[] | null;
  fromDate?: string | null;
  toDate?: string | null;
  intradayOnly: boolean;
  backtestRuleSets: ('BUY' | 'SELL')[];
}

export interface BacktestProfileLastResult {
  totalGainLoss: number;
  totalGainLossPounds?: number;
  daysAnalysed?: number;
  tradeCount: number;
  winRate?: number;
  runAt: number;
}

const DEFAULT_CONFIG: UserConfig = {
  defaultSize: '1',
  defaultExpiry: 'DFB',
  currencyCode: 'GBP',
  ui: {
    theme: 'dark',
    maPeriod: 20,
    probesShortPeriod: 5,
    probesMediumPeriod: 60,
    probesLongPeriod: 1440,
    probesBackfillDays: 3,
  },
};

/**
 * Load user config from config.json. Returns defaults if file missing or invalid.
 * Migrates legacy flat credentials to igProfiles.demo when present.
 */
export function loadConfig(): UserConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<UserConfig>;
    let cfg: UserConfig = { ...DEFAULT_CONFIG, ...parsed };

    if (!cfg.igProfiles && (cfg.igApiKey || cfg.igUsername || cfg.igPassword)) {
      const baseUrl = (parsed as Record<string, unknown>).igBaseUrl as string | undefined || DEFAULT_BASE_URL_DEMO;
      const profileId: IgProfileId = /demo-api|demo\.ig\.com/i.test(baseUrl) ? 'demo' : 'live';
      cfg = {
        ...cfg,
        igProfiles: {
          demo: { igApiKey: '', igUsername: '', igPassword: '', igBaseUrl: DEFAULT_BASE_URL_DEMO },
          live: { igApiKey: '', igUsername: '', igPassword: '', igBaseUrl: DEFAULT_BASE_URL_LIVE },
          [profileId]: {
            igApiKey: cfg.igApiKey,
            igUsername: cfg.igUsername,
            igPassword: cfg.igPassword,
            igBaseUrl: baseUrl,
          },
        },
        activeProfile: profileId,
      };
      saveConfig(cfg);
    }
    if (!cfg.igProfiles) {
      cfg = {
        ...cfg,
        igProfiles: {
          demo: { igBaseUrl: DEFAULT_BASE_URL_DEMO },
          live: { igBaseUrl: DEFAULT_BASE_URL_LIVE },
        },
        activeProfile: 'demo',
      };
    }
    if (!cfg.activeProfile) cfg.activeProfile = 'demo';
    return cfg;
  } catch {
    return {
      ...DEFAULT_CONFIG,
      igProfiles: {
        demo: { igBaseUrl: DEFAULT_BASE_URL_DEMO },
        live: { igBaseUrl: DEFAULT_BASE_URL_LIVE },
      },
      activeProfile: 'demo',
    };
  }
}

const LEGACY_KEYS = ['igApiKey', 'igUsername', 'igPassword', 'igBaseUrl'];

/**
 * Save user config to config.json.
 * Strips legacy credential fields at root (now per-profile in igProfiles).
 */
export function saveConfig(config: UserConfig): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const cleaned = { ...config } as Record<string, unknown>;
  for (const k of LEGACY_KEYS) delete cleaned[k];
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cleaned, null, 2), 'utf-8');
}

/**
 * Update config with partial values and persist.
 * Handles activeProfile switch and credential updates for the active profile.
 */
export function updateConfig(updates: Partial<UserConfig> & { igApiKey?: string; igUsername?: string; igPassword?: string; igBaseUrl?: string }): UserConfig {
  const current = loadConfig();
  const uiUpdates = updates?.ui;
  const instrumentsUpdate = uiUpdates?.instruments;
  const uiRest = uiUpdates ? (() => { const { instruments: _i, ...rest } = uiUpdates; return rest; })() : undefined;
  const merged: UserConfig = {
    ...current,
    ...updates,
    ui: { ...current.ui, ...uiRest },
  };
  if (instrumentsUpdate && typeof instrumentsUpdate === 'object') {
    merged.ui = merged.ui || {};
    merged.ui.instruments = { ...(merged.ui.instruments || {}) };
    for (const epic of Object.keys(instrumentsUpdate)) {
      const incoming = instrumentsUpdate[epic];
      if (incoming && typeof incoming === 'object') {
        merged.ui.instruments[epic] = { ...(merged.ui.instruments[epic] || {}), ...incoming };
      }
    }
  }
  if (updates.activeProfile !== undefined) {
    merged.activeProfile = updates.activeProfile;
  }
  const profileId = merged.activeProfile || 'demo';
  if (
    updates.igApiKey !== undefined ||
    updates.igUsername !== undefined ||
    updates.igPassword !== undefined ||
    updates.igBaseUrl !== undefined
  ) {
    merged.igProfiles = merged.igProfiles || { demo: {}, live: {} };
    const p = merged.igProfiles[profileId] || {};
    merged.igProfiles[profileId] = {
      ...p,
      ...(updates.igApiKey !== undefined && { igApiKey: updates.igApiKey }),
      ...(updates.igUsername !== undefined && { igUsername: updates.igUsername }),
      ...(updates.igPassword !== undefined && { igPassword: updates.igPassword }),
      ...(updates.igBaseUrl !== undefined && { igBaseUrl: updates.igBaseUrl }),
    };
  }
  saveConfig(merged);
  return merged;
}

/** Active profile credentials and base URL for IG API */
export function getActiveCredentials(): {
  igApiKey: string;
  igUsername: string;
  igPassword: string;
  igBaseUrl: string;
} | null {
  const cfg = loadConfig();
  const profileId = cfg.activeProfile || 'demo';
  const profile = cfg.igProfiles?.[profileId];
  const defaultBaseUrl = profileId === 'live' ? DEFAULT_BASE_URL_LIVE : DEFAULT_BASE_URL_DEMO;
  const igBaseUrl = (profile?.igBaseUrl || defaultBaseUrl).replace(/\/$/, '');
  if (!profile?.igApiKey || !profile?.igUsername || !profile?.igPassword) return null;
  return {
    igApiKey: profile.igApiKey.trim(),
    igUsername: profile.igUsername.trim(),
    igPassword: profile.igPassword.trim(),
    igBaseUrl,
  };
}

/** Config safe to send to client (excludes API key and password) */
export function getClientConfig(): Omit<UserConfig, 'igApiKey' | 'igPassword' | 'igProfiles'> & {
  credentialsConfigured: boolean;
  activeProfile: IgProfileId;
  igProfilesSafe: Record<IgProfileId, { igUsername?: string; igBaseUrl?: string; credentialsConfigured: boolean }>;
} {
  const cfg = loadConfig();
  const { igApiKey: _ak, igPassword: _pw, igProfiles, ...rest } = cfg;
  delete (rest as Record<string, unknown>).igBaseUrl;
  const activeProfile = cfg.activeProfile || 'demo';
  const profiles = igProfiles || { demo: {}, live: {} };
  const igProfilesSafe: Record<IgProfileId, { igUsername?: string; igBaseUrl?: string; credentialsConfigured: boolean }> = {
    demo: {
      igUsername: profiles.demo?.igUsername,
      igBaseUrl: profiles.demo?.igBaseUrl || DEFAULT_BASE_URL_DEMO,
      credentialsConfigured: !!(profiles.demo?.igApiKey && profiles.demo?.igUsername && profiles.demo?.igPassword),
    },
    live: {
      igUsername: profiles.live?.igUsername,
      igBaseUrl: profiles.live?.igBaseUrl || DEFAULT_BASE_URL_LIVE,
      credentialsConfigured: !!(profiles.live?.igApiKey && profiles.live?.igUsername && profiles.live?.igPassword),
    },
  };
  const creds = getActiveCredentials();
  return {
    ...rest,
    activeProfile,
    credentialsConfigured: !!creds,
    igProfilesSafe,
  };
}
