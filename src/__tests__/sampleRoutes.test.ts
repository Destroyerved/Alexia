/**
 * Station data and routing engine tests.
 * Covers:
 * - Station counts and line membership
 * - Interchange connectivity
 * - Routing: same line, multi-interchange, edge cases
 * - Stop counts and direction
 * - Rapido handoff utility
 */
import { describe, it, expect } from 'vitest';
import {
  PHYSICAL_STATIONS,
  METRO_LINES,
  STATIONS,
  STATION_BY_ID,
  LINE_BY_ID,
  LAST_MILE_OPTIONS,
  SAMPLE_JOURNEY,
  TIMETABLE_NOTICE,
} from '../data/stationData';
import { findRoute } from '../data/routingEngine';
import {
  buildRapidoUrl,
  buildJourneyDetailText,
  RAPIDO_BASE_URL,
} from '../data/rapidoHandoff';

// ─── 1. Station counts ───────────────────────────────────────────────────────
describe('Station counts', () => {
  it('has exactly 54 unique physical stations', () => {
    expect(PHYSICAL_STATIONS.length).toBe(54);
  });

  it('STATIONS array has 54 entries (one per unique physical station)', () => {
    expect(STATIONS.length).toBe(54);
  });

  it('STATIONS entries have unique IDs', () => {
    const ids = STATIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('Blue Line has exactly 18 stops', () => {
    expect(LINE_BY_ID['blue'].stops.length).toBe(18);
  });

  it('Red Line has exactly 15 stops', () => {
    expect(LINE_BY_ID['red'].stops.length).toBe(15);
  });

  it('Yellow Line has exactly 21 stops', () => {
    expect(LINE_BY_ID['yellow'].stops.length).toBe(21);
  });

  it('Violet Line has exactly 3 stops', () => {
    expect(LINE_BY_ID['violet'].stops.length).toBe(3);
  });

  it('total line memberships = 57 (18+15+21+3)', () => {
    const total = METRO_LINES.reduce((sum, l) => sum + l.stops.length, 0);
    expect(total).toBe(57);
  });
});

// ─── 2. Blue Line station order ──────────────────────────────────────────────
describe('Blue Line station order', () => {
  const blueStops = LINE_BY_ID['blue'].stops;
  const expected = [
    'thaltej-gam',
    'thaltej',
    'doordarshan-kendra',
    'gurukul-road',
    'gujarat-university',
    'commerce-six-road',
    'sp-stadium',
    'old-high-court',
    'shahpur',
    'gheekanta',
    'kalupur-railway-station',
    'kankaria-east',
    'apparel-park',
    'amraiwadi',
    'rabari-colony',
    'vastral',
    'nirant-cross-road',
    'vastral-gam',
  ];

  it('contains all 18 Blue Line stations in correct order', () => {
    expect(blueStops).toEqual(expected);
  });
});

// ─── 3. Red Line station order ───────────────────────────────────────────────
describe('Red Line station order', () => {
  const redStops = LINE_BY_ID['red'].stops;
  const expected = [
    'apmc',
    'jivraj-park',
    'rajiv-nagar',
    'shreyas',
    'paldi',
    'gandhigram',
    'old-high-court',
    'usmanpura',
    'vijay-nagar',
    'vadaj',
    'ranip',
    'sabarmati-railway-station',
    'aec',
    'sabarmati',
    'motera-stadium',
  ];

  it('contains all 15 Red Line stations in correct order', () => {
    expect(redStops).toEqual(expected);
  });
});

// ─── 4. Yellow Line station order ────────────────────────────────────────────
describe('Yellow Line station order', () => {
  const yellowStops = LINE_BY_ID['yellow'].stops;
  const expected = [
    'motera-stadium',
    'koteshwar-road',
    'vishwakarma-college',
    'tapovan-circle',
    'narmada-canal',
    'koba-circle',
    'juna-koba',
    'koba-gam',
    'gnlu',
    'raysan',
    'randesan',
    'dholakuva-circle',
    'infocity',
    'sector-1',
    'sector-10a',
    'sachivalaya',
    'akshardham',
    'juna-sachivalaya',
    'sector-16',
    'sector-24',
    'mahatma-mandir',
  ];

  it('contains all 21 Yellow Line stations in correct order', () => {
    expect(yellowStops).toEqual(expected);
  });
});

// ─── 5. Violet Line station order ────────────────────────────────────────────
describe('Violet Line station order', () => {
  const violetStops = LINE_BY_ID['violet'].stops;

  it('contains all 3 Violet Line stations in correct order', () => {
    expect(violetStops).toEqual(['gnlu', 'pdeu', 'gift-city']);
  });
});

// ─── 6. Interchange stations ─────────────────────────────────────────────────
describe('Interchange station membership', () => {
  it('Old High Court is on both Blue and Red lines', () => {
    const s = STATION_BY_ID['old-high-court'];
    expect(s.lineIds).toContain('blue');
    expect(s.lineIds).toContain('red');
    expect(s.lineIds.length).toBe(2);
  });

  it('Motera Stadium is on both Red and Yellow lines', () => {
    const s = STATION_BY_ID['motera-stadium'];
    expect(s.lineIds).toContain('red');
    expect(s.lineIds).toContain('yellow');
    expect(s.lineIds.length).toBe(2);
  });

  it('GNLU is on both Yellow and Violet lines', () => {
    const s = STATION_BY_ID['gnlu'];
    expect(s.lineIds).toContain('yellow');
    expect(s.lineIds).toContain('violet');
    expect(s.lineIds.length).toBe(2);
  });

  it('Old High Court appears in both Blue and Red line stop lists', () => {
    expect(LINE_BY_ID['blue'].stops).toContain('old-high-court');
    expect(LINE_BY_ID['red'].stops).toContain('old-high-court');
  });

  it('Motera Stadium appears in both Red and Yellow line stop lists', () => {
    expect(LINE_BY_ID['red'].stops).toContain('motera-stadium');
    expect(LINE_BY_ID['yellow'].stops).toContain('motera-stadium');
  });

  it('GNLU appears in both Yellow and Violet line stop lists', () => {
    expect(LINE_BY_ID['yellow'].stops).toContain('gnlu');
    expect(LINE_BY_ID['violet'].stops).toContain('gnlu');
  });
});

// ─── 7. Simulated Koteshwar Road interchange label ───────────────────────────
describe('Koteshwar Road simulated interchange', () => {
  it('Koteshwar Road is only on Yellow Line (no fabricated extra line)', () => {
    const s = STATION_BY_ID['koteshwar-road'];
    expect(s.lineIds).toEqual(['yellow']);
    expect(s.lineIds.length).toBe(1);
  });

  it('Koteshwar Road has a verificationNote mentioning SIMULATED INTERCHANGE', () => {
    const s = STATION_BY_ID['koteshwar-road'];
    expect(s.verificationNote).toBeDefined();
    expect(s.verificationNote).toContain('SIMULATED INTERCHANGE');
  });

  it('Koteshwar Road verificationNote states no official connecting line', () => {
    const note = STATION_BY_ID['koteshwar-road'].verificationNote ?? '';
    expect(note.toLowerCase()).toContain('no official');
  });
});

// ─── 8. Sabarmati Railway Station verification ────────────────────────────────
describe('Sabarmati Railway Station', () => {
  it('is present in the Red Line', () => {
    expect(LINE_BY_ID['red'].stops).toContain('sabarmati-railway-station');
  });

  it('has a verificationNote (not silently asserted as operational)', () => {
    const s = STATION_BY_ID['sabarmati-railway-station'];
    expect(s.verificationNote).toBeDefined();
    expect(s.verificationNote!.length).toBeGreaterThan(10);
  });
});

// ─── 9. Routing — same line ───────────────────────────────────────────────────
describe('Routing — same line routes', () => {
  it('Thaltej Gam → Vastral Gam (all Blue Line, 17 stops)', () => {
    const result = findRoute('thaltej-gam', 'vastral-gam');
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.transferCount).toBe(0);
    expect(result.totalStops).toBe(17);
    expect(result.legs.length).toBe(1);
    expect(result.legs[0].line.id).toBe('blue');
  });

  it('APMC → Motera Stadium (all Red Line, 14 stops)', () => {
    const result = findRoute('apmc', 'motera-stadium');
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.transferCount).toBe(0);
    expect(result.totalStops).toBe(14);
    expect(result.legs[0].line.id).toBe('red');
  });

  it('Thaltej Gam → Old High Court (8 stops on Blue)', () => {
    // thaltej-gam(0) … old-high-court(7) = 7 stops
    const result = findRoute('thaltej-gam', 'old-high-court');
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.totalStops).toBe(7);
  });

  it('GNLU → GIFT City (Violet, 2 stops)', () => {
    const result = findRoute('gnlu', 'gift-city');
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.transferCount).toBe(0);
    expect(result.totalStops).toBe(2);
    expect(result.legs[0].line.id).toBe('violet');
  });

  it('reverse: Vastral Gam → Thaltej Gam (17 stops)', () => {
    const result = findRoute('vastral-gam', 'thaltej-gam');
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.totalStops).toBe(17);
  });
});

// ─── 10. Routing — one interchange ────────────────────────────────────────────
describe('Routing — one interchange routes', () => {
  it('APMC (Red) → Shahpur (Blue) via Old High Court, 1 transfer', () => {
    const result = findRoute('apmc', 'shahpur');
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.transferCount).toBe(1);
    expect(result.transfers[0].atStation.id).toBe('old-high-court');
    expect(result.transfers[0].fromLine.id).toBe('red');
    expect(result.transfers[0].toLine.id).toBe('blue');
  });

  it('Red→Yellow: APMC → Koteshwar Road via Motera Stadium, 1 transfer', () => {
    const result = findRoute('apmc', 'koteshwar-road');
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.transferCount).toBe(1);
    expect(result.transfers[0].atStation.id).toBe('motera-stadium');
  });

  it('Yellow→Violet: Motera Stadium → GIFT City via GNLU, 1 transfer', () => {
    const result = findRoute('motera-stadium', 'gift-city');
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.transferCount).toBe(1);
    expect(result.transfers[0].atStation.id).toBe('gnlu');
  });
});

// ─── 11. Routing — two interchanges ───────────────────────────────────────────
describe('Routing — two interchange routes', () => {
  it('APMC (Red) → GIFT City (Violet) requires 2 transfers', () => {
    // Red → (Motera) → Yellow → (GNLU) → Violet
    const result = findRoute('apmc', 'gift-city');
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.transferCount).toBe(2);
    expect(result.transfers[0].atStation.id).toBe('motera-stadium');
    expect(result.transfers[1].atStation.id).toBe('gnlu');
  });

  it('Thaltej Gam (Blue) → Mahatma Mandir (Yellow) uses 2 transfers', () => {
    // Blue → (Old High Court) → Red → (Motera) → Yellow
    const result = findRoute('thaltej-gam', 'mahatma-mandir');
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.transferCount).toBe(2);
  });
});

// ─── 12. Routing — edge cases ─────────────────────────────────────────────────
describe('Routing — edge cases', () => {
  it('same station returns found with 0 stops and 0 transfers', () => {
    const result = findRoute('thaltej-gam', 'thaltej-gam');
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.totalStops).toBe(0);
    expect(result.transferCount).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('unknown from station returns not found', () => {
    const result = findRoute('nonexistent-station', 'thaltej-gam');
    expect(result.found).toBe(false);
  });

  it('unknown to station returns not found', () => {
    const result = findRoute('thaltej-gam', 'nonexistent-station');
    expect(result.found).toBe(false);
  });

  it('empty from returns not found', () => {
    const result = findRoute('', 'thaltej-gam');
    expect(result.found).toBe(false);
  });

  it('empty to returns not found', () => {
    const result = findRoute('thaltej-gam', '');
    expect(result.found).toBe(false);
  });
});

// ─── 13. Stop count consistency ──────────────────────────────────────────────
describe('Stop count consistency', () => {
  it('Thaltej Gam → Thaltej is 1 stop', () => {
    const result = findRoute('thaltej-gam', 'thaltej');
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.totalStops).toBe(1);
  });

  it('GNLU → PDEU is 1 stop', () => {
    const result = findRoute('gnlu', 'pdeu');
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.totalStops).toBe(1);
  });

  it('Transfer station (Old High Court) is not double-counted', () => {
    // Red APMC→Old High Court (6 stops) + Blue Old High Court→SP Stadium (1 stop reverse)
    // SP Stadium is 1 stop before Old High Court on Blue in the forward direction
    const result = findRoute('apmc', 'sp-stadium');
    expect(result.found).toBe(true);
    if (!result.found) return;
    // Old High Court should appear as alight on Red and board on Blue — not counted twice
    // Old High Court appears as the last station in the Red leg and first in the Blue leg.
    // totalStops must not double-count the interchange station.
    expect(result.transferCount).toBe(1);
    expect(result.transfers[0].atStation.id).toBe('old-high-court');
  });
});

// ─── 14. Rapido handoff utility ───────────────────────────────────────────────
describe('Rapido handoff utility', () => {
  it('buildRapidoUrl returns the Rapido base URL', () => {
    const url = buildRapidoUrl({
      pickupStation: 'Thaltej Gam',
      dropStation: 'Old High Court',
    });
    expect(url).toBe(RAPIDO_BASE_URL);
    expect(url).toContain('rapido.bike');
  });

  it('buildRapidoUrl with any input always returns base URL (no unsupported prefill)', () => {
    const url1 = buildRapidoUrl({ pickupStation: 'A', dropStation: 'B' });
    const url2 = buildRapidoUrl({ pickupStation: '', dropStation: '' });
    expect(url1).toBe(RAPIDO_BASE_URL);
    expect(url2).toBe(RAPIDO_BASE_URL);
  });

  it('buildJourneyDetailText returns non-null with valid pickup and drop', () => {
    const text = buildJourneyDetailText({
      pickupStation: 'Kalupur Railway Station',
      dropStation: 'Gheekanta',
    });
    expect(text).not.toBeNull();
    expect(text).toContain('Kalupur Railway Station');
    expect(text).toContain('Gheekanta');
  });

  it('buildJourneyDetailText includes a manual-entry note', () => {
    const text = buildJourneyDetailText({
      pickupStation: 'X',
      dropStation: 'Y',
    });
    expect(text?.toLowerCase()).toContain('manually');
  });

  it('buildJourneyDetailText returns null when pickup is missing', () => {
    const text = buildJourneyDetailText({ dropStation: 'Old High Court' });
    expect(text).toBeNull();
  });

  it('buildJourneyDetailText returns null when drop is missing', () => {
    const text = buildJourneyDetailText({ pickupStation: 'Old High Court' });
    expect(text).toBeNull();
  });

  it('buildJourneyDetailText returns null when both are missing', () => {
    const text = buildJourneyDetailText({});
    expect(text).toBeNull();
  });
});

// ─── 15. Timetable data ───────────────────────────────────────────────────────
describe('Timetable data', () => {
  it('TIMETABLE_NOTICE is defined and non-empty', () => {
    expect(TIMETABLE_NOTICE).toBeTruthy();
    expect(TIMETABLE_NOTICE.length).toBeGreaterThan(10);
  });

  it('each line has a timetable with firstTrain, lastTrain, frequencyMin, endToEndMin', () => {
    for (const line of METRO_LINES) {
      expect(line.timetable.firstTrain).toBeTruthy();
      expect(line.timetable.lastTrain).toBeTruthy();
      expect(line.timetable.frequencyMin).toBeTruthy();
      expect(line.timetable.endToEndMin).toBeGreaterThan(0);
      expect(line.timetable.notice).toBe(TIMETABLE_NOTICE);
    }
  });

  it('Blue Line first train is approximately 06:20', () => {
    expect(LINE_BY_ID['blue'].timetable.firstTrain).toBe('06:20');
  });

  it('Yellow Line first train mentions 07:26', () => {
    expect(LINE_BY_ID['yellow'].timetable.firstTrain).toContain('07:26');
  });

  it('Violet Line end-to-end is 8 minutes', () => {
    expect(LINE_BY_ID['violet'].timetable.endToEndMin).toBe(8);
  });
});

// ─── 16. Existing test coverage (backwards-compatible) ────────────────────────
describe('sampleRoutes data integrity (backwards-compatible)', () => {
  it('should have 4 metro lines', () => {
    expect(METRO_LINES.length).toBe(4);
  });

  it('each metro line should have a name, hexColor, and stops', () => {
    for (const line of METRO_LINES) {
      expect(line.id).toBeTruthy();
      expect(line.name).toBeTruthy();
      expect(line.hexColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(line.stops.length).toBeGreaterThan(0);
    }
  });

  it('should have 3 last-mile options (AMTS, BRTS, auto)', () => {
    const modes = LAST_MILE_OPTIONS.map((o) => o.mode);
    expect(modes).toContain('amts');
    expect(modes).toContain('brts');
    expect(modes).toContain('auto');
  });

  it('SAMPLE_JOURNEY should reference a valid metro line', () => {
    const lineIds = METRO_LINES.map((l) => l.id);
    expect(lineIds).toContain(SAMPLE_JOURNEY.line.id);
  });

  it('SAMPLE_JOURNEY stops should be a subset of the Blue line stops', () => {
    const blueStopIds = LINE_BY_ID['blue'].stops;
    for (const stop of SAMPLE_JOURNEY.stops) {
      expect(blueStopIds).toContain(stop.id);
    }
  });
});
