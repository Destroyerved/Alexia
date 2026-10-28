/**
 * TransitSync — Part A–D feature tests
 *
 * Part A: Metro station selector dataset integrity
 * Part B: Last-mile data model and Rapido handoff
 */
import { describe, it, expect } from 'vitest';
import {
  STATIONS,
  METRO_LINES,
  STATION_BY_ID,
  LINE_BY_ID,
} from '../data/stationData';
import { getStationLastMile } from '../data/lastMileData';
import {
  buildJourneyDetailText,
  buildRapidoUrl,
  RAPIDO_BASE_URL,
} from '../data/rapidoHandoff';

// ── Part A: Station selector dataset ─────────────────────────────────────────

describe('Part A — Selector dataset completeness', () => {
  it('has exactly 54 unique stations in STATIONS', () => {
    expect(STATIONS.length).toBe(54);
  });

  it('STATIONS entries all have unique IDs', () => {
    const ids = STATIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(54);
  });

  it('Yellow Line has 21 stations for selector', () => {
    expect(LINE_BY_ID['yellow'].stops.length).toBe(21);
  });

  it('Red Line has 15 stations for selector', () => {
    expect(LINE_BY_ID['red'].stops.length).toBe(15);
  });

  it('Blue Line has 18 stations for selector', () => {
    expect(LINE_BY_ID['blue'].stops.length).toBe(18);
  });

  it('Violet Line has 3 stations for selector', () => {
    expect(LINE_BY_ID['violet'].stops.length).toBe(3);
  });

  it('total line-membership options = 57 (18+15+21+3)', () => {
    const total = METRO_LINES.reduce((sum, l) => sum + l.stops.length, 0);
    expect(total).toBe(57);
  });

  it('all four lines are available in LINE_BY_ID', () => {
    expect(LINE_BY_ID['yellow']).toBeDefined();
    expect(LINE_BY_ID['red']).toBeDefined();
    expect(LINE_BY_ID['blue']).toBeDefined();
    expect(LINE_BY_ID['violet']).toBeDefined();
  });

  it('Yellow Line starts at Motera Stadium and ends at Mahatma Mandir', () => {
    const stops = LINE_BY_ID['yellow'].stops;
    expect(stops[0]).toBe('motera-stadium');
    expect(stops[stops.length - 1]).toBe('mahatma-mandir');
  });

  it('Red Line starts at APMC and ends at Motera Stadium', () => {
    const stops = LINE_BY_ID['red'].stops;
    expect(stops[0]).toBe('apmc');
    expect(stops[stops.length - 1]).toBe('motera-stadium');
  });

  it('Blue Line starts at Thaltej Gam and ends at Vastral Gam', () => {
    const stops = LINE_BY_ID['blue'].stops;
    expect(stops[0]).toBe('thaltej-gam');
    expect(stops[stops.length - 1]).toBe('vastral-gam');
  });

  it('Violet Line starts at GNLU and ends at GIFT City', () => {
    const stops = LINE_BY_ID['violet'].stops;
    expect(stops[0]).toBe('gnlu');
    expect(stops[stops.length - 1]).toBe('gift-city');
  });

  it('STATION_BY_ID resolves every station in STATIONS', () => {
    for (const s of STATIONS) {
      expect(STATION_BY_ID[s.id]).toBeDefined();
      expect(STATION_BY_ID[s.id].name).toBe(s.name);
    }
  });
});

describe('Part A — Boarding exclusion from destination', () => {
  it('excluding a non-interchange station removes it from its line only', () => {
    const excludeId = 'thaltej-gam';
    const filtered = LINE_BY_ID['blue'].stops.filter((id) => id !== excludeId);
    expect(filtered).not.toContain(excludeId);
    expect(filtered.length).toBe(LINE_BY_ID['blue'].stops.length - 1);
  });

  it('excluding old-high-court removes it from both Blue and Red stops', () => {
    const excludeId = 'old-high-court';
    const blueFiltered = LINE_BY_ID['blue'].stops.filter((id) => id !== excludeId);
    const redFiltered  = LINE_BY_ID['red'].stops.filter((id) => id !== excludeId);
    expect(blueFiltered).not.toContain(excludeId);
    expect(redFiltered).not.toContain(excludeId);
  });

  it('excluding motera-stadium removes it from both Red and Yellow stops', () => {
    const excludeId = 'motera-stadium';
    const redFiltered    = LINE_BY_ID['red'].stops.filter((id) => id !== excludeId);
    const yellowFiltered = LINE_BY_ID['yellow'].stops.filter((id) => id !== excludeId);
    expect(redFiltered).not.toContain(excludeId);
    expect(yellowFiltered).not.toContain(excludeId);
  });

  it('excluding gnlu removes it from both Yellow and Violet stops', () => {
    const excludeId = 'gnlu';
    const yellowFiltered = LINE_BY_ID['yellow'].stops.filter((id) => id !== excludeId);
    const violetFiltered = LINE_BY_ID['violet'].stops.filter((id) => id !== excludeId);
    expect(yellowFiltered).not.toContain(excludeId);
    expect(violetFiltered).not.toContain(excludeId);
  });

  it('shared interchange stations appear in multiple line stops', () => {
    expect(LINE_BY_ID['blue'].stops).toContain('old-high-court');
    expect(LINE_BY_ID['red'].stops).toContain('old-high-court');
    expect(LINE_BY_ID['red'].stops).toContain('motera-stadium');
    expect(LINE_BY_ID['yellow'].stops).toContain('motera-stadium');
    expect(LINE_BY_ID['yellow'].stops).toContain('gnlu');
    expect(LINE_BY_ID['violet'].stops).toContain('gnlu');
  });
});

// ── Part B: Last-mile data model ──────────────────────────────────────────────

describe('Part B — Last-mile data model', () => {
  it('getStationLastMile returns an object for any valid station ID', () => {
    const info = getStationLastMile('thaltej-gam');
    expect(info).toMatchObject({ stationId: 'thaltej-gam' });
  });

  it('stations without known AMTS/BRTS have null for both modes', () => {
    const info = getStationLastMile('apmc');
    expect(info.amts).toBeNull();
    expect(info.brts).toBeNull();
  });

  it('unknown station IDs return null for both modes', () => {
    const info = getStationLastMile('does-not-exist');
    expect(info.amts).toBeNull();
    expect(info.brts).toBeNull();
  });

  it('kalupur-railway-station has both AMTS and BRTS info', () => {
    const info = getStationLastMile('kalupur-railway-station');
    expect(info.amts).not.toBeNull();
    expect(info.brts).not.toBeNull();
  });

  it('AMTS info for kalupur is marked isSimulated', () => {
    const info = getStationLastMile('kalupur-railway-station');
    expect(info.amts?.isSimulated).toBe(true);
  });

  it('BRTS info for kalupur is marked isSimulated', () => {
    const info = getStationLastMile('kalupur-railway-station');
    expect(info.brts?.isSimulated).toBe(true);
  });

  it('old-high-court has AMTS but no BRTS entry', () => {
    const info = getStationLastMile('old-high-court');
    expect(info.amts).not.toBeNull();
    expect(info.brts).toBeNull();
  });

  it('gujarat-university has BRTS but no AMTS entry', () => {
    const info = getStationLastMile('gujarat-university');
    expect(info.amts).toBeNull();
    expect(info.brts).not.toBeNull();
  });

  it('gheekanta has AMTS but no BRTS entry', () => {
    const info = getStationLastMile('gheekanta');
    expect(info.amts).not.toBeNull();
    expect(info.brts).toBeNull();
  });

  it('commerce-six-road has BRTS but no AMTS entry', () => {
    const info = getStationLastMile('commerce-six-road');
    expect(info.amts).toBeNull();
    expect(info.brts).not.toBeNull();
  });

  it('AMTS/BRTS entries do not fabricate stop names or distances', () => {
    const info = getStationLastMile('kalupur-railway-station');
    expect(info.amts?.stopName).toBeNull();
    expect(info.amts?.distanceM).toBeNull();
    expect(info.brts?.stopName).toBeNull();
    expect(info.brts?.distanceM).toBeNull();
  });

  it('AMTS/BRTS entries have a non-empty statusNote', () => {
    const info = getStationLastMile('kalupur-railway-station');
    expect(info.amts?.statusNote.length).toBeGreaterThan(10);
    expect(info.brts?.statusNote.length).toBeGreaterThan(10);
  });
});

// ── Part B: Rapido handoff with onward destination ─────────────────────────

describe('Part B — Rapido handoff (onward destination)', () => {
  it('buildJourneyDetailText returns null when only pickupStation provided (no destination)', () => {
    expect(buildJourneyDetailText({ pickupStation: 'GNLU' })).toBeNull();
  });

  it('buildJourneyDetailText returns null when pickupStation is missing', () => {
    expect(buildJourneyDetailText({ onwardDestination: 'Some Place' })).toBeNull();
    expect(buildJourneyDetailText({ dropStation: 'Station B' })).toBeNull();
    expect(buildJourneyDetailText({})).toBeNull();
  });

  it('buildJourneyDetailText works with onwardDestination', () => {
    const text = buildJourneyDetailText({
      pickupStation: 'GNLU',
      onwardDestination: 'Science City, Ahmedabad',
    });
    expect(text).not.toBeNull();
    expect(text).toContain('GNLU');
    expect(text).toContain('Science City, Ahmedabad');
  });

  it('buildJourneyDetailText still works with legacy dropStation', () => {
    const text = buildJourneyDetailText({
      pickupStation: 'Old High Court',
      dropStation: 'Kalupur Railway Station',
    });
    expect(text).not.toBeNull();
    expect(text).toContain('Old High Court');
    expect(text).toContain('Kalupur Railway Station');
  });

  it('onwardDestination takes precedence over dropStation when both are supplied', () => {
    const text = buildJourneyDetailText({
      pickupStation: 'GNLU',
      dropStation: 'Old value',
      onwardDestination: 'New Onward Destination',
    });
    expect(text).toContain('New Onward Destination');
    expect(text).not.toContain('Old value');
  });

  it('detail text contains a manual-entry note', () => {
    const text = buildJourneyDetailText({
      pickupStation: 'GNLU',
      onwardDestination: 'Sector-1, Gandhinagar',
    });
    expect(text?.toLowerCase()).toContain('manually');
  });

  it('buildRapidoUrl always returns the official base URL (no prefill)', () => {
    expect(buildRapidoUrl({ pickupStation: 'GNLU' })).toBe(RAPIDO_BASE_URL);
    expect(buildRapidoUrl({ pickupStation: '', dropStation: '' })).toBe(RAPIDO_BASE_URL);
    expect(RAPIDO_BASE_URL).toBe('https://www.rapido.bike/');
  });

  it('Rapido pickup should be the metro destination station (not the boarding station)', () => {
    // The detail text is generated with pickupStation = metro exit (alighting station)
    const text = buildJourneyDetailText({
      pickupStation: 'Kalupur Railway Station', // the metro exit
      onwardDestination: '123 CG Road',
    });
    expect(text).toContain('Pickup:      Kalupur Railway Station');
    expect(text).toContain('Destination: 123 CG Road');
  });

  it('buildJourneyDetailText with empty onwardDestination (after trim) returns null', () => {
    const text = buildJourneyDetailText({
      pickupStation: 'GNLU',
      onwardDestination: '',
    });
    expect(text).toBeNull();
  });
});
