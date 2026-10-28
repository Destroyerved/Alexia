/**
 * 3. nextMetro(origin, dest, departTime, dayType)
 * Uses official per-train times for Red/Yellow/Violet where available.
 * Blue Line uses the generated list.
 * Linear interpolation between timing points labelled as "estimated".
 * Returns departure, arrival, wait, accuracy tag, and fare.
 */

import { METRO_TIMETABLE, METRO_FARES, STATION_BY_NAME, STATION_BY_ID, LINES } from './data';
import { metroPath } from './metroPath';
import type { NextMetroResult, AccuracyTag } from './types';

// Convert "HH:MM" to minutes from midnight
export function timeToMin(t: string): number {
  const parts = t.split(':').map((p) => parseInt(p, 10));
  return parts[0] * 60 + parts[1];
}

// Convert minutes from midnight to "HH:MM"
export function minToTime(m: number): string {
  const norm = ((m % 1440) + 1440) % 1440;
  const hh = Math.floor(norm / 60)
    .toString()
    .padStart(2, '0');
  const mm = Math.floor(norm % 60)
    .toString()
    .padStart(2, '0');
  return `${hh}:${mm}`;
}

export type DayType = 'weekday' | 'saturday' | 'sunday';

// Build ordered stop lists for Red+Yellow corridor
function getRedYellowStops(): string[] {
  const red = LINES.find((l) => l.id === 'red')!;
  const yellow = LINES.find((l) => l.id === 'yellow')!;
  // Red: APMC ... Motera Stadium
  // Yellow: Motera Stadium ... Mahatma Mandir
  const combined = [...red.stops];
  for (const s of yellow.stops) {
    if (!combined.includes(s)) combined.push(s);
  }
  return combined.map((sId) => STATION_BY_ID.get(sId)!.name);
}

const RED_YELLOW_CORRIDOR = getRedYellowStops();
// Blue corridor: Thaltej Gam ... Vastral Gam
const BLUE_CORRIDOR = LINES.find((l) => l.id === 'blue')!.stops.map((id) => STATION_BY_ID.get(id)!.name);

interface InterpolatedStopTimes {
  [stationName: string]: {
    time: string;
    isEstimated: boolean;
  };
}

/**
 * Interpolate times linearly by station order between timing points
 */
function interpolateTripTimes(
  tripTimes: Record<string, string | undefined>,
  corridor: string[],
): InterpolatedStopTimes {
  const result: InterpolatedStopTimes = {};

  // Stations in this corridor that have times in tripTimes
  const knownIndices: { index: number; station: string; min: number }[] = [];

  for (let i = 0; i < corridor.length; i++) {
    const st = corridor[i];
    const val = tripTimes[st];
    if (val) {
      knownIndices.push({
        index: i,
        station: st,
        min: timeToMin(val),
      });
      result[st] = {
        time: val,
        isEstimated: false, // Official timing point
      };
    }
  }

  if (knownIndices.length < 2) {
    return result;
  }

  // Interpolate between each consecutive pair of known points
  for (let k = 0; k < knownIndices.length - 1; k++) {
    const p1 = knownIndices[k];
    const p2 = knownIndices[k + 1];

    const spanIndices = Math.abs(p2.index - p1.index);
    const spanMin = p2.min - p1.min;

    const step = p2.index > p1.index ? 1 : -1;
    let currIdx = p1.index + step;
    let stepCount = 1;

    while (currIdx !== p2.index) {
      const st = corridor[currIdx];
      const interpolatedMin = Math.round(p1.min + (spanMin * stepCount) / spanIndices);
      result[st] = {
        time: minToTime(interpolatedMin),
        isEstimated: true,
      };
      currIdx += step;
      stepCount++;
    }
  }

  return result;
}

export function nextMetro(
  originInput: string,
  destInput: string,
  departTime: string,
  dayType: DayType = 'weekday',
): NextMetroResult {
  const normOrigin = originInput.trim().toLowerCase();
  const normDest = destInput.trim().toLowerCase();
  const startStation = STATION_BY_NAME.get(normOrigin) || STATION_BY_ID.get(normOrigin);
  const endStation = STATION_BY_NAME.get(normDest) || STATION_BY_ID.get(normDest);

  if (!startStation || !endStation) {
    throw new Error(`Station not found: ${!startStation ? originInput : destInput}`);
  }

  const originName = startStation.name;
  const destName = endStation.name;

  // Fare lookup
  let fareINR: number | null = null;
  if (METRO_FARES[originName] && METRO_FARES[originName][destName] !== undefined) {
    fareINR = METRO_FARES[originName][destName];
  } else if (METRO_FARES[destName] && METRO_FARES[destName][originName] !== undefined) {
    fareINR = METRO_FARES[destName][originName];
  }

  const depMinTarget = timeToMin(departTime);

  // Determine path
  const path = metroPath(originName, destName);
  const firstLeg = path.legs[0];

  if (!firstLeg) {
    // Same station
    return {
      origin: originName,
      dest: destName,
      departure: departTime,
      arrival: departTime,
      waitMin: 0,
      travelMin: 0,
      accuracy: 'official',
      sourceChip: 'Scheduled (GMRC timetable w.e.f. 18 May 2026)',
      fareINR: 0,
    };
  }

  // Case A: Blue Line Journey
  if (firstLeg.lineId === 'blue') {
    const blueGen = METRO_TIMETABLE.blueLineGenerated;
    const isEastbound = BLUE_CORRIDOR.indexOf(firstLeg.alighting) >= BLUE_CORRIDOR.indexOf(firstLeg.boarding);

    const departuresList = isEastbound
      ? blueGen.departFromThaltejGam[dayType] || blueGen.departFromThaltejGam.weekday
      : blueGen.departFromVastralGam[dayType] || blueGen.departFromVastralGam.weekday;

    // Linear station index travel time calculation
    const totalStops = BLUE_CORRIDOR.length - 1; // 17 segments
    const endToEndMin = blueGen.travelMinEndToEnd || 45;
    const minPerStop = endToEndMin / totalStops;

    const fromIdx = isEastbound
      ? BLUE_CORRIDOR.indexOf(firstLeg.boarding)
      : BLUE_CORRIDOR.length - 1 - BLUE_CORRIDOR.indexOf(firstLeg.boarding);

    const toIdx = isEastbound
      ? BLUE_CORRIDOR.indexOf(firstLeg.alighting)
      : BLUE_CORRIDOR.length - 1 - BLUE_CORRIDOR.indexOf(firstLeg.alighting);

    const rideMinutes = Math.round(Math.abs(toIdx - fromIdx) * minPerStop);

    // Find next train departing terminus that reaches origin >= depMinTarget
    let bestDepTime: string | null = null;
    let bestArrTime: string | null = null;
    let minWait = Infinity;

    for (const termDep of departuresList) {
      const termMin = timeToMin(termDep);
      const stationDepMin = Math.round(termMin + fromIdx * minPerStop);

      if (stationDepMin >= depMinTarget) {
        const wait = stationDepMin - depMinTarget;
        if (wait < minWait) {
          minWait = wait;
          bestDepTime = minToTime(stationDepMin);
          bestArrTime = minToTime(stationDepMin + rideMinutes);
        }
      }
    }

    if (!bestDepTime || minWait === Infinity) {
      return {
        origin: originName,
        dest: destName,
        departure: 'No more trains',
        arrival: 'No more trains',
        waitMin: 0,
        travelMin: rideMinutes,
        accuracy: 'approximate',
        sourceChip: 'Approximate',
        fareINR,
        noMoreTrains: true,
      };
    }

    return {
      origin: originName,
      dest: destName,
      departure: bestDepTime,
      arrival: bestArrTime!,
      waitMin: minWait,
      travelMin: rideMinutes,
      accuracy: 'approximate',
      sourceChip: 'Approximate',
      fareINR,
    };
  }

  // Case B: Red / Yellow / Violet Lines (Official throughServices + interpolation)
  const through = METRO_TIMETABLE.throughServices;
  const isDown = (
    (RED_YELLOW_CORRIDOR.includes(firstLeg.boarding) && RED_YELLOW_CORRIDOR.includes(firstLeg.alighting) &&
      RED_YELLOW_CORRIDOR.indexOf(firstLeg.boarding) < RED_YELLOW_CORRIDOR.indexOf(firstLeg.alighting)) ||
    (firstLeg.boarding === 'GNLU' && (firstLeg.alighting === 'PDEU' || firstLeg.alighting === 'GIFT City')) ||
    (firstLeg.boarding === 'PDEU' && firstLeg.alighting === 'GIFT City')
  );

  const direction = isDown ? 'down' : 'up';
  const trips = through[direction];

  let bestDepTime: string | null = null;
  let bestArrTime: string | null = null;
  let bestWait = Infinity;
  let bestAccuracy: AccuracyTag = 'official';

  for (const trip of trips) {
    // Check if this trip serves this leg
    const corridor = trip.to === 'GIFT City' || trip.from === 'GIFT City'
      ? (direction === 'down' ? [...RED_YELLOW_CORRIDOR.slice(0, RED_YELLOW_CORRIDOR.indexOf('GNLU') + 1), 'PDEU', 'GIFT City'] : ['GIFT City', 'PDEU', ...RED_YELLOW_CORRIDOR.slice(0, RED_YELLOW_CORRIDOR.indexOf('GNLU') + 1)].reverse())
      : (direction === 'down' ? RED_YELLOW_CORRIDOR : [...RED_YELLOW_CORRIDOR].reverse());

    const interpolated = interpolateTripTimes(trip.times as Record<string, string | undefined>, corridor);

    const boardInfo = interpolated[firstLeg.boarding];
    const alightInfo = interpolated[firstLeg.alighting];

    if (boardInfo && alightInfo) {
      const boardMin = timeToMin(boardInfo.time);
      const alightMin = timeToMin(alightInfo.time);

      if (boardMin >= depMinTarget && alightMin >= boardMin) {
        const wait = boardMin - depMinTarget;
        if (wait < bestWait) {
          bestWait = wait;
          bestDepTime = boardInfo.time;
          bestArrTime = alightInfo.time;
          bestAccuracy = boardInfo.isEstimated || alightInfo.isEstimated ? 'estimated' : 'official';
        }
      }
    }
  }

  if (!bestDepTime || bestWait === Infinity) {
    return {
      origin: originName,
      dest: destName,
      departure: 'No more trains',
      arrival: 'No more trains',
      waitMin: 0,
      travelMin: 0,
      accuracy: 'official',
      sourceChip: 'Scheduled (GMRC timetable w.e.f. 18 May 2026)',
      fareINR,
      noMoreTrains: true,
    };
  }

  const travelMin = timeToMin(bestArrTime!) - timeToMin(bestDepTime);

  return {
    origin: originName,
    dest: destName,
    departure: bestDepTime,
    arrival: bestArrTime!,
    waitMin: bestWait,
    travelMin,
    accuracy: bestAccuracy,
    sourceChip: 'Scheduled (GMRC timetable w.e.f. 18 May 2026)',
    fareINR,
  };
}
