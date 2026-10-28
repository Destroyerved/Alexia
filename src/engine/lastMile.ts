/**
 * 4. lastMile(station, destination)
 * From metro_nearest_stops.json.
 * BRTS and AMTS cards with straight-line distance x 1.3 / 80 m/min walking estimate.
 * Distance rule: < 500 m bold; >= 500 m normal weight.
 * Next feeder departure from feeder_timetable.json when available.
 * Auto option with fare estimate: base 30 + 14/km and Rapido link.
 */

import { METRO_NEAREST_STOPS, FEEDER_TIMETABLE, STATION_BY_NAME, STATION_BY_ID, PLACES } from './data';
import { timeToMin } from './nextMetro';
import type { LastMileResult, StopDistanceInfo, FeederDeparture } from './types';

// Map station names to feeder routes serving them
const STATION_FEEDER_ROUTES: Record<string, string[]> = {
  APMC: ['Metro13'],
  Amraiwadi: ['Feeder-8', 'Feeder-9'],
  'Apparel Park': ['Feeder-8', 'Feeder-9'],
  'Doordarshan Kendra': ['Metro1', 'Metro2', 'Metro7', 'Metro8'],
  'Gujarat University': ['Metro1', 'Metro2'],
  'Jivraj Park': ['Metro13', 'Metro14'],
  'Koteshwar Road': ['Metro11'],
  'Motera Stadium': ['Metro11'],
  'Nirant Cross Road': ['Metro9', 'Metro10'],
  'Rajiv Nagar': ['Metro13', 'Metro14'],
  Ranip: ['Metro13'],
  Thaltej: ['Metro1', 'Metro2', 'Metro3', 'Metro4', 'Metro5', 'Metro6', 'Metro7', 'Metro8'],
  'Thaltej Gam': ['Metro3', 'Metro4', 'Metro5', 'Metro6', 'Metro7', 'Metro8'],
  Vastral: ['Metro9', 'Metro10'],
  'Vastral Gam': ['Metro9', 'Metro10'],
};

function buildStopInfo(
  stopData: { name: string; lat: number; lon: number; distM: number } | undefined,
): StopDistanceInfo {
  if (!stopData || typeof stopData.distM !== 'number') {
    return {
      name: null,
      distM: null,
      walkMin: null,
      lat: null,
      lon: null,
      isBold: false,
      displayText: 'no data nearby',
    };
  }

  const d = stopData.distM;
  const isBold = d < 500;
  // straight-line distance x 1.3 / 80 m/min walking estimate
  const walkMin = Math.max(1, Math.round((d * 1.3) / 80));

  const walkUrl = `https://www.google.com/maps/dir/?api=1&destination=${stopData.lat},${stopData.lon}&travelmode=walking`;

  return {
    name: stopData.name,
    distM: d,
    walkMin,
    lat: stopData.lat,
    lon: stopData.lon,
    isBold,
    displayText: `${d} m (~${walkMin} min walk)`,
    walkUrl,
  };
}

/**
 * Find the next feeder departure at or after departTime (default now)
 */
function findNextFeeder(stationName: string, departTime: string): FeederDeparture | null {
  const routeIds = STATION_FEEDER_ROUTES[stationName];
  if (!routeIds || routeIds.length === 0) return null;

  const currentMin = timeToMin(departTime);
  let bestDeparture: FeederDeparture | null = null;
  let minWait = Infinity;

  for (const rId of routeIds) {
    const route = FEEDER_TIMETABLE.routes[rId];
    if (!route) continue;

    for (const trip of route.trips) {
      // Find stop in this trip matching the station area
      // Try first stop or stop matching station name
      for (const [stopId, depTimeStr] of trip.stops) {
        const stopObj = FEEDER_TIMETABLE.stops[stopId];
        const isMatch =
          stopObj &&
          (stopObj.name.toLowerCase().includes(stationName.toLowerCase()) ||
            trip.stops[0][0] === stopId);

        if (isMatch) {
          const tripMin = timeToMin(depTimeStr);
          if (tripMin >= currentMin) {
            const wait = tripMin - currentMin;
            if (wait < minWait) {
              minWait = wait;
              bestDeparture = {
                routeId: rId,
                routeName: route.name,
                longName: route.longName,
                depTime: depTimeStr,
                waitMin: wait,
                atStopName: stopObj.name,
              };
            }
          }
          break; // Stop at first matching stop in trip
        }
      }
    }
  }

  return bestDeparture;
}

export function lastMile(
  stationInput: string,
  destinationQuery?: string,
  departTime: string = '08:00',
): LastMileResult {
  const normStation = stationInput.trim().toLowerCase();
  const st = STATION_BY_NAME.get(normStation) || STATION_BY_ID.get(normStation);
  const stationName = st ? st.name : stationInput;

  const nearest = METRO_NEAREST_STOPS[stationName];

  // BRTS Stop info
  const brtsStop = buildStopInfo(nearest?.brts);
  const brtsHasData = brtsStop.name !== null;

  // AMTS Stop info
  const amtsStop = buildStopInfo(nearest?.amts);
  const amtsHasData = amtsStop.name !== null;

  // Feeder departure
  const nextFeeder = findNextFeeder(stationName, departTime);

  // Auto fare estimate (base 30 + 14/km)
  // Determine distance: if destination is a place, compute haversine distance, else default 3 km
  let distKm = 3.0; // fallback standard last mile
  let destCoords: { lat: number; lon: number } | undefined;

  if (destinationQuery) {
    const matchedPlace = PLACES.find(
      (p) =>
        p.name.toLowerCase().includes(destinationQuery.toLowerCase()) ||
        destinationQuery.toLowerCase().includes(p.name.toLowerCase()),
    );
    if (matchedPlace && nearest?.lat && nearest?.lon) {
      destCoords = { lat: matchedPlace.lat, lon: matchedPlace.lon };
      // Haversine
      const R = 6371;
      const dLat = ((matchedPlace.lat - nearest.lat) * Math.PI) / 180;
      const dLon = ((matchedPlace.lon - nearest.lon) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((nearest.lat * Math.PI) / 180) *
          Math.cos((matchedPlace.lat * Math.PI) / 180) *
          Math.sin(dLon / 2) *
          Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      distKm = Math.max(1, Math.round(R * c * 10) / 10);
    }
  }

  const baseFareINR = 30;
  const perKmINR = 14;
  const fareEstimateINR = Math.round(baseFareINR + perKmINR * distKm);

  return {
    station: stationName,
    destinationQuery,
    destinationCoords: destCoords,
    brts: {
      hasData: brtsHasData,
      stop: brtsStop,
      note: brtsHasData
        ? `Janmarg BRTS: ${brtsStop.name}`
        : 'no BRTS data nearby',
    },
    amts: {
      hasData: amtsHasData,
      stop: amtsStop,
      nextFeeder,
      note: amtsHasData
        ? `AMTS: ${amtsStop.name}${nextFeeder ? ` (Feeder ${nextFeeder.routeName} at ${nextFeeder.depTime})` : ''}`
        : 'no AMTS data nearby',
    },
    auto: {
      available: true,
      fareEstimateINR,
      distanceKm: distKm,
      baseFareINR,
      perKmINR,
      rapidoUrl: 'https://www.rapido.bike/',
      note: `Auto-Rickshaw: ~₹${fareEstimateINR} (ESTIMATE: ₹${baseFareINR} base + ₹${perKmINR}/km for ~${distKm} km). No ride is booked automatically.`,
    },
  };
}
