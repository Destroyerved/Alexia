/**
 * 5. planJourney(origin, destination, now)
 * 6. applyDelay(plan, legIndex, minutes) + recommend(plan)
 *
 * Full itinerary with per-leg times, waits, transfer buffer.
 * Flag "likely missed" when wait after transfer exceeds 12 min or buffer < 3 min.
 * Every leg carries a source chip:
 *  - "Scheduled (GMRC timetable w.e.f. 18 May 2026)"
 *  - "Scheduled (open GTFS, unverified)"
 *  - "Approximate"
 *  - "Estimated"
 *  - "Simulated delay"
 * Never present anything as live data.
 */

import { metroPath } from './metroPath';
import { nextMetro, timeToMin, minToTime, type DayType } from './nextMetro';
import { lastMile } from './lastMile';
import { METRO_FARES, STATION_BY_NAME, STATION_BY_ID, PLACES } from './data';
import type { JourneyPlan, JourneyLeg } from './types';

export function planJourney(
  originInput: string,
  destInput: string,
  nowTime: string = '08:00',
  dayType: DayType = 'weekday',
): JourneyPlan {
  const normOrigin = originInput.trim().toLowerCase();
  const normDest = destInput.trim().toLowerCase();

  const startStation = STATION_BY_NAME.get(normOrigin) || STATION_BY_ID.get(normOrigin);
  let endStation = STATION_BY_NAME.get(normDest) || STATION_BY_ID.get(normDest);
  let destinationDisplayName = destInput.trim();

  // If destination is not a direct station, check if it's a landmark/place
  if (!endStation) {
    const matchedPlace = PLACES.find(
      (p) =>
        p.name.toLowerCase() === normDest ||
        p.id.toLowerCase() === normDest ||
        normDest.includes(p.name.toLowerCase()) ||
        p.name.toLowerCase().includes(normDest),
    );
    if (matchedPlace) {
      endStation =
        STATION_BY_NAME.get(matchedPlace.nearestStation.toLowerCase()) ||
        STATION_BY_ID.get(matchedPlace.nearestStation.toLowerCase());
      destinationDisplayName = matchedPlace.name;
    }
  }

  if (!startStation || !endStation) {
    throw new Error(`Station not found: ${!startStation ? originInput : destInput}`);
  }

  const path = metroPath(startStation.name, endStation.name);
  const legs: JourneyLeg[] = [];
  let currentTime = nowTime;
  let totalFare = 0;

  // Single or Multi-leg Metro journey
  if (path.legs.length === 0) {
    // Same station
    const lm = lastMile(
      startStation.name,
      destinationDisplayName !== startStation.name ? destinationDisplayName : undefined,
      nowTime,
    );
    return {
      id: `plan-${Date.now()}`,
      origin: startStation.name,
      destination: destinationDisplayName,
      departureTime: nowTime,
      arrivalTime: nowTime,
      totalDurationMin: 0,
      totalFareINR: 0,
      legs: [],
      lastMileOptions: lm,
      hasLikelyMissedConnection: false,
      missedLegIndices: [],
    };
  }

  for (let i = 0; i < path.legs.length; i++) {
    const legDef = path.legs[i];
    const metroRes = nextMetro(legDef.boarding, legDef.alighting, currentTime, dayType);

    // Compute "get off at X, N stops after Y" hint
    let getOffHint = `Get off at ${legDef.alighting}`;
    if (legDef.stops.length >= 3) {
      const stopsBefore = legDef.stops.length - 2;
      const refStop = legDef.stops[legDef.stops.length - 2];
      getOffHint = `Get off at ${legDef.alighting}, 1 stop after ${refStop}`;
      if (stopsBefore > 1) {
        getOffHint = `Get off at ${legDef.alighting}, ${legDef.stops.length - 1} stops after ${legDef.stops[0]}`;
      }
    }

    const legFare = metroRes.fareINR || 0;
    if (i === 0) {
      // Look up full end-to-end metro fare from origin to final destination
      const fullFare =
        METRO_FARES[startStation.name]?.[endStation.name] ??
        METRO_FARES[endStation.name]?.[startStation.name] ??
        legFare;
      totalFare = fullFare;
    }

    // Push metro leg
    legs.push({
      id: `leg-metro-${i}`,
      mode: 'metro',
      from: legDef.boarding,
      to: legDef.alighting,
      depTime: metroRes.departure,
      arrTime: metroRes.arrival,
      durationMin: metroRes.travelMin,
      waitMin: metroRes.waitMin,
      lineName: legDef.lineName,
      direction: legDef.direction,
      stopsCount: legDef.stops.length - 1,
      stopsList: legDef.stops,
      sourceChip: metroRes.sourceChip,
      accuracy: metroRes.accuracy,
      fareINR: legFare,
      getOffHint,
    });

    currentTime = metroRes.arrival;

    // If there is an interchange to the next leg, insert transfer leg
    if (i < path.legs.length - 1) {
      const nextLegDef = path.legs[i + 1];
      const transferStation = legDef.alighting;

      // Transfer takes ~3 min buffer
      const transferBufferMin = 3;
      const transferDepMin = timeToMin(currentTime);
      const transferArrMin = transferDepMin + transferBufferMin;

      // Query the next metro leg departing after arrival
      const nextLegMetro = nextMetro(nextLegDef.boarding, nextLegDef.alighting, minToTime(transferArrMin), dayType);

      const waitAtTransfer = nextLegMetro.noMoreTrains
        ? 999
        : timeToMin(nextLegMetro.departure) - transferDepMin;

      // Buffer rule: flag "likely missed" when wait after transfer exceeds 12 min or buffer < 3 min
      const isMissed = waitAtTransfer > 12 || waitAtTransfer < 3;

      legs.push({
        id: `leg-transfer-${i}`,
        mode: 'transfer',
        from: transferStation,
        to: transferStation,
        depTime: currentTime,
        arrTime: minToTime(transferArrMin),
        durationMin: transferBufferMin,
        waitMin: Math.max(0, waitAtTransfer - transferBufferMin),
        lineName: `Interchange: ${legDef.lineName} → ${nextLegDef.lineName}`,
        sourceChip: 'Scheduled (GMRC timetable w.e.f. 18 May 2026)',
        statusAlert: isMissed ? 'missed' : 'ok',
        alertMessage: isMissed
          ? waitAtTransfer > 12
            ? `Connection likely missed: wait is ${waitAtTransfer} min (> 12 min threshold)`
            : `Connection likely missed: transfer buffer is only ${waitAtTransfer} min (< 3 min)`
          : undefined,
      });

      currentTime = minToTime(transferArrMin);
    }
  }

  // Final destination last mile
  const finalStation = endStation.name;
  const lm = lastMile(
    finalStation,
    destinationDisplayName !== finalStation ? destinationDisplayName : undefined,
    currentTime,
  );

  // Overall journey departure and arrival
  const firstDep = legs.length > 0 ? legs[0].depTime : nowTime;
  const lastArr = legs.length > 0 ? legs[legs.length - 1].arrTime : nowTime;
  const totalDuration = Math.max(0, timeToMin(lastArr) - timeToMin(firstDep));

  // Check missed connections
  const missedIndices: number[] = [];
  legs.forEach((leg, idx) => {
    if (leg.statusAlert === 'missed') {
      missedIndices.push(idx);
    }
  });

  return {
    id: `plan-${Date.now()}`,
    origin: startStation.name,
    destination: destinationDisplayName,
    departureTime: firstDep,
    arrivalTime: lastArr,
    totalDurationMin: totalDuration,
    totalFareINR: totalFare,
    legs,
    lastMileOptions: lm,
    hasLikelyMissedConnection: missedIndices.length > 0,
    missedLegIndices: missedIndices,
  };
}

/**
 * 6. applyDelay(plan, legIndexOrMode, minutes)
 * Recompute times, push departure/arrival, flag missed connections.
 * Accepts either leg index (0, 1, 2) or transport mode ('metro' | 'amts' | 'brts').
 */
export function applyDelay(
  plan: JourneyPlan,
  legIndexOrMode: number | 'metro' | 'amts' | 'brts',
  minutes: number,
): JourneyPlan {
  // If minutes is 0, return clean plan without active delay
  if (minutes === 0) {
    return {
      ...plan,
      activeDelay: undefined,
      recommendationBanner: undefined,
    };
  }

  // Handle bus/feeder delays (AMTS or BRTS last-mile feeder)
  if (legIndexOrMode === 'amts' || legIndexOrMode === 'brts') {
    const delayedArrivalMin = timeToMin(plan.arrivalTime) + minutes;
    const lastMetroLeg = [...plan.legs].reverse().find((l) => l.mode === 'metro');
    const alightStation = lastMetroLeg ? lastMetroLeg.to : plan.destination;
    const updatedLastMile = lastMile(
      alightStation,
      plan.destination !== alightStation ? plan.destination : undefined,
      minToTime(delayedArrivalMin),
    );

    const updatedPlan: JourneyPlan = {
      ...plan,
      arrivalTime: minToTime(delayedArrivalMin),
      totalDurationMin: plan.totalDurationMin + minutes,
      lastMileOptions: updatedLastMile,
      activeDelay: {
        legIndex: -1,
        mode: legIndexOrMode,
        minutes,
      },
    };
    return recommend(updatedPlan);
  }

  // Resolve target leg index for Metro
  let legIndex = 0;
  if (typeof legIndexOrMode === 'number') {
    legIndex = legIndexOrMode;
  } else if (legIndexOrMode === 'metro') {
    const idx = plan.legs.findIndex((l) => l.mode === 'metro');
    legIndex = idx >= 0 ? idx : 0;
  }

  if (legIndex < 0 || legIndex >= plan.legs.length) return plan;

  const newLegs: JourneyLeg[] = plan.legs.map((leg) => ({ ...leg }));
  const targetLeg = newLegs[legIndex];

  // Apply delay minutes to target leg
  const delayedArrMin = timeToMin(targetLeg.arrTime) + minutes;
  targetLeg.arrTime = minToTime(delayedArrMin);
  targetLeg.durationMin += minutes;
  targetLeg.sourceChip = 'Simulated delay';
  targetLeg.statusAlert = 'delayed';
  targetLeg.alertMessage = `Simulated delay of +${minutes} min applied.`;

  // Cascade delay to subsequent legs
  let currentMin = delayedArrMin;
  const missedIndices: number[] = [];

  for (let i = legIndex + 1; i < newLegs.length; i++) {
    const leg = newLegs[i];
    const originalDepMin = timeToMin(leg.depTime);

    if (leg.mode === 'transfer') {
      // Transfer leg now starts when delayed previous leg arrived
      leg.depTime = minToTime(currentMin);
      currentMin += leg.durationMin;
      leg.arrTime = minToTime(currentMin);
      leg.sourceChip = 'Simulated delay';
    } else {
      // Next transit leg: check if delayed arrival misses scheduled departure
      if (currentMin > originalDepMin) {
        // MISSED CONNECTION!
        leg.statusAlert = 'missed';
        leg.alertMessage = `Connection likely missed: arrived at ${minToTime(currentMin)}, but train departed at ${leg.depTime}.`;
        leg.sourceChip = 'Simulated delay';
        missedIndices.push(i);

        // Shift this leg to reflect missed connection or next available slot
        const delayOffset = currentMin - originalDepMin;
        leg.depTime = minToTime(timeToMin(leg.depTime) + delayOffset);
        leg.arrTime = minToTime(timeToMin(leg.arrTime) + delayOffset);
        currentMin = timeToMin(leg.arrTime);
      } else {
        // Still made it
        currentMin = timeToMin(leg.arrTime);
      }
    }
  }

  // Also include transfer leg warnings if buffer < 3 or wait > 12
  newLegs.forEach((leg, idx) => {
    if (leg.statusAlert === 'missed' && !missedIndices.includes(idx)) {
      missedIndices.push(idx);
    }
  });

  const lastMetroLeg = [...newLegs].reverse().find((l) => l.mode === 'metro');
  const alightStation = lastMetroLeg ? lastMetroLeg.to : plan.destination;
  const updatedLastMile = lastMile(
    alightStation,
    plan.destination !== alightStation ? plan.destination : undefined,
    minToTime(currentMin),
  );

  const updatedPlan: JourneyPlan = {
    ...plan,
    arrivalTime: minToTime(currentMin),
    totalDurationMin: Math.max(0, currentMin - timeToMin(newLegs[0]?.depTime || plan.departureTime)),
    legs: newLegs,
    lastMileOptions: updatedLastMile,
    hasLikelyMissedConnection: missedIndices.length > 0,
    missedLegIndices: missedIndices,
    activeDelay: {
      legIndex,
      mode: 'metro',
      minutes,
    },
  };

  return recommend(updatedPlan);
}

/**
 * 6. recommend(plan)
 * Recommends the next best option (next feeder, BRTS, or auto) when a delay occurs.
 */
export function recommend(plan: JourneyPlan): JourneyPlan {
  // If there's a missed connection or active delay applied
  if (!plan.hasLikelyMissedConnection && !plan.activeDelay) {
    return {
      ...plan,
      recommendationBanner: undefined,
    };
  }

  const lm = plan.lastMileOptions;
  const mode = plan.activeDelay?.mode;
  let rec = 'Better option: ';

  if (mode === 'amts') {
    if (lm.brts.hasData && (lm.brts.stop.distM || 0) < 1000) {
      rec += `AMTS bus delayed. Switch to Janmarg BRTS at ${lm.brts.stop.name} (~${lm.brts.stop.walkMin} min walk, ${lm.brts.stop.distM} m).`;
    } else if (lm.auto.available) {
      rec += `AMTS bus delayed. Take an Auto-Rickshaw directly from station exit (~₹${lm.auto.fareEstimateINR}, ${lm.auto.distanceKm} km via Rapido).`;
    } else {
      rec += 'AMTS bus delayed. Proceed to the nearest arterial road or check subsequent departures.';
    }
  } else if (mode === 'brts') {
    if (lm.amts.nextFeeder) {
      rec += `BRTS delayed. Take AMTS Feeder ${lm.amts.nextFeeder.routeName} departing at ${lm.amts.nextFeeder.depTime} (${lm.amts.nextFeeder.waitMin} min wait).`;
    } else if (lm.auto.available) {
      rec += `BRTS delayed. Take an Auto-Rickshaw directly (~₹${lm.auto.fareEstimateINR}, ${lm.auto.distanceKm} km via Rapido).`;
    } else {
      rec += 'BRTS delayed. Check AMTS routes or hail a local auto-rickshaw.';
    }
  } else {
    // Metro delay or missed connection
    if (lm.amts.nextFeeder) {
      rec += `Take AMTS Feeder ${lm.amts.nextFeeder.routeName} departing at ${lm.amts.nextFeeder.depTime} (${lm.amts.nextFeeder.waitMin} min wait).`;
    } else if (lm.brts.hasData && (lm.brts.stop.distM || 0) < 1000) {
      rec += `Switch to Janmarg BRTS at ${lm.brts.stop.name} (~${lm.brts.stop.walkMin} min walk, ${lm.brts.stop.distM} m).`;
    } else if (lm.auto.available) {
      rec += `Take an Auto-Rickshaw directly from exit (~₹${lm.auto.fareEstimateINR}, ${lm.auto.distanceKm} km via Rapido).`;
    } else {
      rec += 'Wait for the next scheduled service or consider walking to the nearest arterial road.';
    }
  }

  return {
    ...plan,
    recommendationBanner: rec,
  };
}
