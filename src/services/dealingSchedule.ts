/**
 * IG dealing schedule (Europe/London wall times) for opens and probe eligibility.
 */

/** Minutes since London local midnight (IG openTime/closeTime). */
export interface DealingDaySlotLondon {
  openMin: number;
  closeMin: number;
}

/** Sunday=0 … Saturday=6 in Europe/London. */
export type DealingWeekLondon = (DealingDaySlotLondon | null)[];

/**
 * When IG does not return parsable marketTimes but the instrument is not 24/7, use typical UK cash-index
 * hours (Mon–Fri 08:00–21:59 London, Sat/Sun closed). Safer than allowing all times.
 */
export function defaultDealingWeekLondonMonFri(): DealingWeekLondon {
  const slot: DealingDaySlotLondon = { openMin: 8 * 60, closeMin: 21 * 60 + 59 };
  return [null, slot, slot, slot, slot, slot, null];
}

const LONDON_WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const londonWeekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/London', weekday: 'short' });
const londonHmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });

function londonWeekdayIndexSun0(ts: number): number {
  const part = londonWeekdayFmt.formatToParts(new Date(ts)).find((p) => p.type === 'weekday')?.value;
  return LONDON_WD[part ?? ''] ?? 0;
}

function londonMinutesSinceMidnight(ts: number): number {
  const parts = londonHmFmt.formatToParts(new Date(ts));
  const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const m = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  return (Number.isNaN(h) ? 0 : h) * 60 + (Number.isNaN(m) ? 0 : m);
}

export { londonWeekdayIndexSun0, londonMinutesSinceMidnight };

/** Parse IG openTime/closeTime (e.g. "22:02", "1970-01-01T21:59:00") to minutes since midnight. */
export function parseIgTimeToMinutes(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const iso = s.match(/T(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (iso) {
    const h = parseInt(iso[1], 10);
    const min = parseInt(iso[2], 10);
    if (!isNaN(h) && h >= 0 && h <= 23 && !isNaN(min) && min >= 0 && min <= 59) return h * 60 + min;
  }
  const parts = s.split(/[:\s]+/).filter(Boolean);
  const h = parseInt(parts[0] ?? '', 10);
  const min = parseInt(parts[1] ?? '0', 10);
  if (isNaN(h) || h < 0 || h > 23) return null;
  const mm = isNaN(min) || min < 0 || min > 59 ? 0 : min;
  return h * 60 + mm;
}

function normalizeMarketTimesToSevenSlots(
  marketTimes: Array<{ openTime?: string; closeTime?: string }>
): (typeof marketTimes[0] | null)[] {
  const out: (typeof marketTimes[0] | null)[] = [null, null, null, null, null, null, null];
  if (marketTimes.length === 7) {
    for (let i = 0; i < 7; i++) out[(i + 1) % 7] = marketTimes[i] ?? null;
    return out;
  }
  if (marketTimes.length === 5) {
    for (let i = 0; i < 5; i++) out[i + 1] = marketTimes[i] ?? null;
    return out;
  }
  for (let i = 0; i < Math.min(marketTimes.length, 7); i++) out[i] = marketTimes[i] ?? null;
  return out;
}

function slotFromMarketTimeRow(row: { openTime?: string; closeTime?: string } | null): DealingDaySlotLondon | null {
  if (!row) return null;
  const openMin = parseIgTimeToMinutes(row.openTime);
  const closeMin = parseIgTimeToMinutes(row.closeTime);
  if (openMin == null || closeMin == null) return null;
  return { openMin, closeMin };
}

/**
 * Build weekly dealing slots from IG marketTimes (Europe/London wall times).
 * Returns null when 24/7 or no usable schedule.
 */
export function dealingWeekFromMarketTimes(
  marketTimes: Array<{ openTime?: string; closeTime?: string }> | undefined | null,
  is24_7: boolean
): DealingWeekLondon | null {
  if (is24_7) return null;
  if (!marketTimes || marketTimes.length === 0) return null;
  const normalized = normalizeMarketTimesToSevenSlots(marketTimes);
  const week: DealingWeekLondon = [];
  for (let i = 0; i < 7; i++) {
    week.push(slotFromMarketTimeRow(normalized[i] ?? null));
  }
  const anyOpen = week.some((s) => s != null);
  return anyOpen ? week : null;
}

function isDealingOpenLondonAt(ts: number, week: DealingWeekLondon): boolean {
  const wd = londonWeekdayIndexSun0(ts);
  const min = londonMinutesSinceMidnight(ts);
  const prevWd = (wd + 6) % 7;
  const prev = week[prevWd];
  if (prev && prev.openMin > prev.closeMin && wd === (prevWd + 1) % 7 && min <= prev.closeMin) return true;
  const today = week[wd];
  if (!today) return false;
  const { openMin, closeMin } = today;
  if (openMin < closeMin) return min >= openMin && min <= closeMin;
  return min >= openMin || min <= closeMin;
}

/** True if IG-style dealing is open at ts (London calendar day + overnight sessions). */
export function isDealingOpenLondon(ts: number, week: DealingWeekLondon | null | undefined): boolean {
  if (!week || week.length !== 7) return true;
  return isDealingOpenLondonAt(ts, week);
}

/** Cached dealing-open lookup (minute buckets) for hot paths such as backtest. */
export class DealingOpenLookup {
  private readonly cache = new Map<number, boolean>();

  constructor(private readonly week: DealingWeekLondon | null | undefined) {}

  isOpen(ts: number): boolean {
    if (!this.week || this.week.length !== 7) return true;
    const key = Math.floor(ts / 60_000);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const open = isDealingOpenLondonAt(ts, this.week);
    this.cache.set(key, open);
    return open;
  }
}

/** Non-24/7: IG schedule or default Mon–Fri UK hours. 24/7: null (always open). */
export function resolveDealingWeekForProbes(
  is24_7: boolean,
  dealingWeekLondon: DealingWeekLondon | null | undefined
): DealingWeekLondon | null {
  if (is24_7) return null;
  if (dealingWeekLondon && dealingWeekLondon.length === 7) return dealingWeekLondon;
  return defaultDealingWeekLondonMonFri();
}
