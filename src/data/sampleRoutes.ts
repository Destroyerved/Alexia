/**
 * sampleRoutes.ts — backward-compatibility re-export.
 * All data now lives in stationData.ts.
 * This file re-exports the types and values that existing tests
 * and the old RouteCard component reference by this module path.
 */
export type {
  TransitMode,
  LineId,
  Station,
  MetroLine,
  LastMileOption,
  LineTimetable,
} from './stationData';

export {
  PHYSICAL_STATIONS,
  METRO_LINES,
  STATIONS,
  STATION_BY_ID,
  LINE_BY_ID,
  LAST_MILE_OPTIONS,
  SAMPLE_JOURNEY,
  TIMETABLE_NOTICE,
} from './stationData';
