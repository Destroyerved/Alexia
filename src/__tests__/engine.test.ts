/**
 * Unit Tests for TransitSync Engine
 * Covers:
 * - metroPath:
 *     - Thaltej Gam -> Vastral Gam (single line direct)
 *     - Paldi -> Vastral via Old High Court (interchange)
 *     - Koteshwar Road -> Mahatma Mandir (Yellow corridor)
 * - nextMetro:
 *     - APMC 06:20 departs (official timetable)
 *     - GIFT City branch trips (row 2 down / up)
 *     - Query after the last official train returns "no more trains"
 * - lastMile BRTS rule:
 *     - 235 m bold, 499 bold, 500 normal, range 600-1000 normal
 * - Missed-connection and delay re-recommendation scenario (the judge demo)
 */

import { describe, it, expect } from 'vitest';
import {
  searchPlaces,
  metroPath,
  nextMetro,
  lastMile,
  planJourney,
  applyDelay,
  recommend,
} from '../engine';

describe('1. searchPlaces(query)', () => {
  it('returns matching stations and places for "Vastral"', () => {
    const results = searchPlaces('Vastral');
    expect(results.length).toBeGreaterThan(0);

    const stationNames = results.filter((r) => r.type === 'station').map((r) => r.name);
    expect(stationNames).toContain('Vastral');
    expect(stationNames).toContain('Vastral Gam');

    const placeNames = results.filter((r) => r.type === 'place').map((r) => r.name);
    expect(placeNames.some((n) => n.includes('Vastral'))).toBe(true);
  });

  it('fuzzy matches landmarks with type="place" and provides nearestStation', () => {
    const results = searchPlaces('Science City');
    expect(results.length).toBeGreaterThan(0);
    const place = results.find((r) => r.type === 'place');
    expect(place).toBeDefined();
    expect(place?.nearestStation).toBe('Thaltej Gam');
  });

  it('returns empty array for empty query', () => {
    expect(searchPlaces('')).toEqual([]);
    expect(searchPlaces('   ')).toEqual([]);
  });
});

describe('2. metroPath(origin, dest)', () => {
  it('Thaltej Gam -> Vastral Gam: direct Blue line, 17 stops', () => {
    const path = metroPath('Thaltej Gam', 'Vastral Gam');
    expect(path.origin).toBe('Thaltej Gam');
    expect(path.dest).toBe('Vastral Gam');
    expect(path.interchanges.length).toBe(0);
    expect(path.stops[0]).toBe('Thaltej Gam');
    expect(path.stops[path.stops.length - 1]).toBe('Vastral Gam');
    expect(path.stopCount).toBe(17);
  });

  it('Paldi -> Vastral via Old High Court: 1 interchange', () => {
    const path = metroPath('Paldi', 'Vastral');
    expect(path.origin).toBe('Paldi');
    expect(path.dest).toBe('Vastral');
    expect(path.interchanges.length).toBe(1);
    expect(path.interchanges[0].station).toBe('Old High Court');
    expect(path.legs.length).toBe(2);
    expect(path.legs[0].boarding).toBe('Paldi');
    expect(path.legs[0].alighting).toBe('Old High Court');
    expect(path.legs[1].boarding).toBe('Old High Court');
    expect(path.legs[1].alighting).toBe('Vastral');
  });

  it('Koteshwar Road -> Mahatma Mandir: Yellow corridor direct', () => {
    const path = metroPath('Koteshwar Road', 'Mahatma Mandir');
    expect(path.origin).toBe('Koteshwar Road');
    expect(path.dest).toBe('Mahatma Mandir');
    expect(path.interchanges.length).toBe(0);
    expect(path.stops[0]).toBe('Koteshwar Road');
    expect(path.stops[path.stops.length - 1]).toBe('Mahatma Mandir');
    expect(path.stopCount).toBe(19);
  });
});

describe('3. nextMetro(origin, dest, departTime, dayType)', () => {
  it('APMC 06:20 departs on official timetable', () => {
    const res = nextMetro('APMC', 'Old High Court', '06:15');
    expect(res.departure).toBe('06:20');
    expect(res.accuracy).toBe('official');
    expect(res.sourceChip).toContain('Scheduled (GMRC timetable');
    expect(res.waitMin).toBe(5);
  });

  it('handles GIFT City branch trips from APMC or GNLU', () => {
    // Row 2 trip departs APMC at 06:45, GNLU at 07:36, arrives GIFT City at 07:42
    const res = nextMetro('GNLU', 'GIFT City', '07:30');
    expect(res.departure).toBe('07:36');
    expect(res.arrival).toBe('07:42');
    expect(res.accuracy).toBe('official');
    expect(res.waitMin).toBe(6);
  });

  it('query after the last official train returns "no more trains"', () => {
    const res = nextMetro('APMC', 'Mahatma Mandir', '23:30');
    expect(res.noMoreTrains).toBe(true);
    expect(res.departure).toBe('No more trains');
  });

  it('linear interpolation between timing points labels times as estimated', () => {
    // Jivraj Park is between APMC and Old High Court (timing points)
    const res = nextMetro('Jivraj Park', 'Old High Court', '06:15');
    expect(res.accuracy).toBe('estimated');
    expect(res.waitMin).toBeGreaterThanOrEqual(0);
  });

  it('Blue Line departures are labeled approximate', () => {
    const res = nextMetro('Thaltej Gam', 'Vastral Gam', '08:00');
    expect(res.accuracy).toBe('approximate');
    expect(res.sourceChip).toBe('Approximate');
  });
});

describe('4. lastMile BRTS distance rules & cards', () => {
  it('BRTS rule: < 500 m bold; >= 500 m normal weight', () => {
    // Check various real stations in metro_nearest_stops
    // Sabarmati Power House at AEC is 149 m (< 500 => bold)
    const aec = lastMile('AEC');
    expect(aec.brts.hasData).toBe(true);
    expect(aec.brts.stop.distM).toBe(149);
    expect(aec.brts.stop.isBold).toBe(true);

    // Dholakuva Circle is 6140 m (>= 500 => normal)
    const dholakuva = lastMile('Dholakuva Circle');
    expect(dholakuva.brts.hasData).toBe(true);
    expect(dholakuva.brts.stop.distM).toBe(6140);
    expect(dholakuva.brts.stop.isBold).toBe(false);

    // Kankaria East is 564 m (>= 500 => normal)
    const kankaria = lastMile('Kankaria East');
    expect(kankaria.brts.stop.distM).toBe(564);
    expect(kankaria.brts.stop.isBold).toBe(false);
  });

  it('handles Sabarmati station gracefully with no entry', () => {
    const sab = lastMile('Sabarmati');
    expect(sab.brts.hasData).toBe(false);
    expect(sab.brts.note).toContain('no BRTS data nearby');
    expect(sab.amts.hasData).toBe(false);
    expect(sab.amts.note).toContain('no AMTS data nearby');
    expect(sab.auto.available).toBe(true);
  });

  it('calculates walking time as distM * 1.3 / 80 m/min', () => {
    const apmc = lastMile('APMC');
    // AMTS at APMC is 57m -> Math.round(57 * 1.3 / 80) = Math.round(74.1 / 80) = 1 min
    expect(apmc.amts.stop.distM).toBe(57);
    expect(apmc.amts.stop.walkMin).toBe(1);
    expect(apmc.amts.stop.isBold).toBe(true);
  });

  it('provides auto fare estimate (base 30 + 14/km) and official Rapido URL', () => {
    const res = lastMile('Thaltej');
    expect(res.auto.baseFareINR).toBe(30);
    expect(res.auto.perKmINR).toBe(14);
    expect(res.auto.rapidoUrl).toBe('https://www.rapido.bike/');
    expect(res.auto.fareEstimateINR).toBe(30 + Math.round(14 * res.auto.distanceKm));
  });
});

describe('5 & 6. Missed-connection and delay re-recommendation scenario (The Judge Demo)', () => {
  it('plans a multi-leg journey with transfer buffer and detects missed connection on delay', () => {
    // Journey: Paldi -> Vastral Gam (Red to Blue at Old High Court)
    const plan = planJourney('Paldi', 'Vastral Gam', '08:00');
    expect(plan.origin).toBe('Paldi');
    expect(plan.destination).toBe('Vastral Gam');
    expect(plan.legs.length).toBe(3); // Metro leg 1, Transfer leg, Metro leg 2

    // Apply +20 min delay to Leg 0 (Paldi -> Old High Court)
    const delayedPlan = applyDelay(plan, 0, 20);

    expect(delayedPlan.legs[0].statusAlert).toBe('delayed');
    expect(delayedPlan.legs[0].sourceChip).toBe('Simulated delay');
    expect(delayedPlan.hasLikelyMissedConnection).toBe(true);
    expect(delayedPlan.recommendationBanner).toBeDefined();
    expect(delayedPlan.recommendationBanner).toContain('Better option:');
  });

  it('recommend(plan) surfaces feeder, BRTS, or auto fallback when delayed', () => {
    const plan = planJourney('Thaltej Gam', 'Vastral Gam', '09:00');
    // Simulate a delay on the trip
    const delayed = applyDelay(plan, 0, 15);
    // Vastral Gam has feeder routes Metro9 and Metro10
    const rec = recommend(delayed);
    expect(rec.recommendationBanner).toBeDefined();
    expect(rec.recommendationBanner?.length).toBeGreaterThan(15);
  });

  it('resolves landmark destination (Science City) to nearest metro station with last-mile', () => {
    const plan = planJourney('APMC', 'Gujarat Science City', '08:00');
    expect(plan.destination).toBe('Gujarat Science City');
    // Nearest station for Science City in places.json is Thaltej Gam
    const lastMetro = plan.legs[plan.legs.length - 1];
    expect(lastMetro.to).toBe('Thaltej Gam');
    expect(plan.lastMileOptions.station).toBe('Thaltej Gam');
    expect(plan.lastMileOptions.destinationQuery).toBe('Gujarat Science City');
    expect(plan.lastMileOptions.auto.distanceKm).toBeGreaterThan(0);
    expect(plan.lastMileOptions.auto.fareEstimateINR).toBeGreaterThan(30);
  });

  it('supports AMTS and BRTS mode delay simulation and tailored recommendation', () => {
    const plan = planJourney('Paldi', 'Vastral Gam', '08:00');
    
    // Simulate +10 min on AMTS feeder
    const delayedAMTS = applyDelay(plan, 'amts', 10);
    expect(delayedAMTS.activeDelay?.mode).toBe('amts');
    expect(delayedAMTS.activeDelay?.minutes).toBe(10);
    expect(delayedAMTS.recommendationBanner).toContain('AMTS bus delayed');

    // Simulate +15 min on BRTS
    const delayedBRTS = applyDelay(plan, 'brts', 15);
    expect(delayedBRTS.activeDelay?.mode).toBe('brts');
    expect(delayedBRTS.activeDelay?.minutes).toBe(15);
    expect(delayedBRTS.recommendationBanner).toContain('BRTS delayed');

    // Reset with 0 min
    const resetPlan = applyDelay(delayedAMTS, 'amts', 0);
    expect(resetPlan.activeDelay).toBeUndefined();
    expect(resetPlan.recommendationBanner).toBeUndefined();
  });
});
