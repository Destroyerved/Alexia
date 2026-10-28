/**
 * TransitSync Engine — Static Data Loader
 * Bundles all offline datasets so the app runs 100% offline in airplane mode.
 */

// Import raw JSON datasets
import stationsData from '../../data/stations.json';
import linesData from '../../data/lines.json';
import placesData from '../../data/places.json';
import metroFaresData from '../../data/metro_fares.json';
import metroNearestStopsData from '../../data/metro_nearest_stops.json';
import metroTimetableData from '../../data/metro_timetable.json';
import feederTimetableData from '../../data/feeder_timetable.json';

export interface StationRaw {
  id: string;
  name: string;
  lineIds: string[];
  isTerminus?: boolean;
  otherModes?: string[];
  verificationNote?: string;
}

export interface MetroLineRaw {
  id: string;
  name: string;
  shortName: string;
  hexColor: string;
  direction: string;
  stops: string[]; // station IDs
}

export interface PlaceRaw {
  id: string;
  name: string;
  category: string;
  area: string;
  nearestStation: string;
  lat: number;
  lon: number;
}

export interface NearestStopEntry {
  lat: number;
  lon: number;
  brts?: {
    name: string;
    lat: number;
    lon: number;
    distM: number;
  };
  amts?: {
    name: string;
    lat: number;
    lon: number;
    distM: number;
    stopsWithin500m?: number;
  };
}

export interface FeederRouteTrip {
  dep: string;
  direction: string;
  stops: [string, string][] | string[][];
}

export interface FeederRouteRaw {
  name: string;
  longName: string;
  serviceId: string;
  tripCount: number;
  firstDeparture: string;
  lastDeparture: string;
  trips: FeederRouteTrip[];
}

export interface FeederStopRaw {
  name: string;
  lat: number;
  lon: number;
}

export const STATIONS: StationRaw[] = stationsData as StationRaw[];
export const LINES: MetroLineRaw[] = linesData as MetroLineRaw[];
export const PLACES: PlaceRaw[] = placesData as PlaceRaw[];
export const METRO_FARES = (metroFaresData as { fares: Record<string, Record<string, number>> }).fares;
export const METRO_NEAREST_STOPS = metroNearestStopsData as Record<string, NearestStopEntry>;
export const METRO_TIMETABLE = metroTimetableData;
export const FEEDER_TIMETABLE = feederTimetableData as unknown as {
  routes: Record<string, FeederRouteRaw>;
  stops: Record<string, FeederStopRaw>;
};

// Maps for O(1) lookups
export const STATION_BY_ID = new Map<string, StationRaw>();
export const STATION_BY_NAME = new Map<string, StationRaw>();
for (const s of STATIONS) {
  STATION_BY_ID.set(s.id, s);
  STATION_BY_NAME.set(s.name.toLowerCase(), s);
}

export const LINE_BY_ID = new Map<string, MetroLineRaw>();
for (const l of LINES) {
  LINE_BY_ID.set(l.id, l);
}
