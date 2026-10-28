/**
 * TransitSync Engine — Core Types
 * Pure TypeScript, zero external dependencies, offline-first.
 */

export type TransitSourceChip =
  | 'Scheduled (GMRC timetable w.e.f. 18 May 2026)'
  | 'Scheduled (open GTFS, unverified)'
  | 'Approximate'
  | 'Estimated'
  | 'Simulated delay';

export type AccuracyTag = 'official' | 'estimated' | 'approximate';

export interface PlaceMatch {
  id: string;
  name: string;
  type: 'station' | 'place';
  subtitle?: string;
  area?: string;
  nearestStation?: string; // Station name if type === 'place'
  stationId?: string;
  lat?: number;
  lon?: number;
}

export interface MetroPathResult {
  origin: string; // Station Name
  dest: string;   // Station Name
  stops: string[]; // List of station names along the journey
  direction: string; // e.g. "Vastral Gam" or "APMC → Motera Stadium"
  stopCount: number;
  interchanges: {
    station: string;
    fromLine: string;
    toLine: string;
  }[];
  legs: {
    lineId: string;
    lineName: string;
    direction: string;
    boarding: string;
    alighting: string;
    stops: string[];
  }[];
}

export interface NextMetroResult {
  origin: string;
  dest: string;
  departure: string; // "HH:MM"
  arrival: string;   // "HH:MM"
  waitMin: number;
  travelMin: number;
  accuracy: AccuracyTag;
  sourceChip: TransitSourceChip;
  fareINR: number | null;
  noMoreTrains?: boolean;
}

export interface FeederDeparture {
  routeId: string;
  routeName: string;
  longName: string;
  depTime: string;
  waitMin: number;
  atStopName: string;
}

export interface StopDistanceInfo {
  name: string | null;
  distM: number | null;
  walkMin: number | null;
  lat: number | null;
  lon: number | null;
  isBold: boolean; // distM < 500
  displayText: string;
  walkUrl?: string;
}

export interface LastMileResult {
  station: string;
  destinationQuery?: string;
  destinationCoords?: { lat: number; lon: number };
  brts: {
    hasData: boolean;
    stop: StopDistanceInfo;
    note: string;
  };
  amts: {
    hasData: boolean;
    stop: StopDistanceInfo;
    nextFeeder: FeederDeparture | null;
    note: string;
  };
  auto: {
    available: boolean;
    fareEstimateINR: number;
    distanceKm: number;
    baseFareINR: number;
    perKmINR: number;
    rapidoUrl: string;
    note: string;
  };
}

export interface JourneyLeg {
  id: string;
  mode: 'metro' | 'transfer' | 'amts' | 'brts' | 'auto' | 'walk';
  from: string;
  to: string;
  depTime: string;
  arrTime: string;
  durationMin: number;
  waitMin: number;
  lineName?: string;
  direction?: string;
  stopsCount?: number;
  stopsList?: string[];
  sourceChip: TransitSourceChip;
  accuracy?: AccuracyTag;
  fareINR?: number;
  statusAlert?: 'ok' | 'missed' | 'delayed';
  alertMessage?: string;
  getOffHint?: string; // "get off at X, N stops after Y"
}

export interface JourneyPlan {
  id: string;
  origin: string;
  destination: string;
  departureTime: string;
  arrivalTime: string;
  totalDurationMin: number;
  totalFareINR: number;
  legs: JourneyLeg[];
  lastMileOptions: LastMileResult;
  hasLikelyMissedConnection: boolean;
  missedLegIndices: number[];
  recommendationBanner?: string;
  activeDelay?: {
    legIndex: number;
    mode: 'metro' | 'amts' | 'brts';
    minutes: number;
  };
}
