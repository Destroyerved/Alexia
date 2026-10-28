/**
 * TransitSync — Last-Mile Connection Data
 *
 * DATA STATUS: DEMO / SIMULATED ONLY.
 * ─────────────────────────────────────────────────────────────────────────────
 * No real AMTS/BRTS stop names, distances, schedules, or fares are claimed
 * in this file. All entries are flagged with `isSimulated: true`.
 *
 * This module is intentionally separate from stationData.ts so that real,
 * verified AMTS/BRTS stop data can be added station-by-station in a future
 * version without touching the core station and routing data.
 *
 * Presence of a station entry here does NOT constitute a claim that a
 * particular bus service exists at that location. It only means the entry
 * can be displayed in the UI with an appropriate "not confirmed" label.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface AmtsBrtsStopInfo {
  /** Official stop name — null until officially verified */
  stopName: string | null;
  /** Approximate walking distance from metro exit in metres — null if unverified */
  distanceM: number | null;
  /** Estimated walking time in minutes — null if unverified */
  walkMinEstimate: number | null;
  /** Approximate wait time for next service — null if unverified */
  waitMinEstimate: string | null;
  /** Illustrative fare estimate — null if unverified */
  fareEstimate: string | null;
  /** true = demo/simulated data; false only when officially verified */
  isSimulated: boolean;
  /** Short status message shown in the UI */
  statusNote: string;
}

export interface StationLastMileInfo {
  stationId: string;
  /** null = no AMTS stop data for this station in this demo */
  amts: AmtsBrtsStopInfo | null;
  /** null = no BRTS stop data for this station in this demo */
  brts: AmtsBrtsStopInfo | null;
}

// ── Shared "available but unverified" templates ──────────────────────────────
// Do NOT populate stopName, distanceM, etc. until official data is available.

const AMTS_NEARBY: AmtsBrtsStopInfo = {
  stopName: null,
  distanceM: null,
  walkMinEstimate: null,
  waitMinEstimate: null,
  fareEstimate: null,
  isSimulated: true,
  statusNote:
    'AMTS service reported near this station. Stop details not confirmed in this demo.',
};

const BRTS_NEARBY: AmtsBrtsStopInfo = {
  stopName: null,
  distanceM: null,
  walkMinEstimate: null,
  waitMinEstimate: null,
  fareEstimate: null,
  isSimulated: true,
  statusNote:
    'Janmarg BRTS corridor reported near this station. Stop details not confirmed in this demo.',
};

// ── Per-station last-mile data ───────────────────────────────────────────────
// Derived from otherModes[] entries in stationData.ts.
// Add real verified data here as it becomes available — do NOT fabricate it.
const STATION_LAST_MILE_MAP: Record<
  string,
  Partial<Pick<StationLastMileInfo, 'amts' | 'brts'>>
> = {
  'old-high-court':          { amts: AMTS_NEARBY },
  'gheekanta':               { amts: AMTS_NEARBY },
  'kalupur-railway-station': { amts: AMTS_NEARBY, brts: BRTS_NEARBY },
  'gujarat-university':      { brts: BRTS_NEARBY },
  'commerce-six-road':       { brts: BRTS_NEARBY },
};

/**
 * Look up last-mile connection info for a station.
 * Always returns a StationLastMileInfo object; modes without data are null.
 */
export function getStationLastMile(stationId: string): StationLastMileInfo {
  const entry = STATION_LAST_MILE_MAP[stationId] ?? {};
  return {
    stationId,
    amts: entry.amts ?? null,
    brts: entry.brts ?? null,
  };
}
