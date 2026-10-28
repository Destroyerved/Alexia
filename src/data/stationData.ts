/**
 * TransitSync — Ahmedabad Metro Network Data
 *
 * IMPORTANT NOTICES:
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. DEMO DATA ONLY. Not live transport information.
 * 2. Station lists are based on publicly available GMRC corridor maps and
 *    press releases, cross-referenced where possible. Operational status of
 *    individual stations has NOT been independently verified for every entry.
 * 3. Timetable data (first/last train, frequency) is APPROXIMATE and sourced
 *    from publicly reported estimates. Do NOT rely on these for actual travel.
 * 4. The "Koteshwar Road simulated interchange" is a DEMO scenario only.
 *    No official connecting metro line to Koteshwar Road has been announced
 *    or verified. It is NOT a real interchange.
 * 5. "Sabarmati Railway Station" is listed in publicly available GMRC phase
 *    maps but its precise operational status is UNVERIFIED in this demo.
 * 6. Interchange stations (Old High Court, Motera Stadium, GNLU) are modelled
 *    as single physical stations with membership in multiple lines.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * VERIFICATION NOTES (items requiring official confirmation):
 * - Operational status of Sabarmati Railway Station on Red Line.
 * - Exact station name casing and transliteration for all stations.
 * - Confirmed interchange platform layout at Old High Court, Motera Stadium, GNLU.
 * - Whether Koteshwar Road ever receives an official connecting service.
 */

// ── Core transit mode types ─────────────────────────────────────────────────
export type TransitMode = 'metro' | 'brts' | 'amts' | 'auto';

export type LineId = 'blue' | 'red' | 'yellow' | 'violet';

/**
 * A physical station. Each station has a unique id.
 * A station may appear in multiple lines (see LINE_MEMBERSHIPS).
 * Do not duplicate a physical station to model interchange — use lineIds instead.
 */
export interface Station {
  id: string;
  name: string;
  /** Metro line(s) this physical station belongs to */
  lineIds: LineId[];
  isTerminus?: boolean;
  /** Other transit modes (BRTS, AMTS, auto) available at this station */
  otherModes?: TransitMode[];
  /** Verification note for uncertain real-world facts */
  verificationNote?: string;
}

/**
 * A metro line definition.
 * stops: ordered list of station IDs in the line's primary direction.
 */
export interface MetroLine {
  id: LineId;
  name: string;
  shortName: string;
  hexColor: string;
  /** Primary direction label (terminus A → terminus B) */
  direction: string;
  /** Ordered station IDs in the line's canonical direction */
  stops: string[];
  timetable: LineTimetable;
}

/** Approximate timetable — configurable demo data, NOT live. */
export interface LineTimetable {
  firstTrain: string;        // e.g. "06:20" — approximate
  lastTrain: string;         // e.g. "22:05" — approximate
  frequencyMin: string;      // e.g. "9–12"
  endToEndMin: number;       // approximate end-to-end journey time in minutes
  /** Human-readable caveat shown in the UI */
  notice: string;
}

export interface LastMileOption {
  mode: TransitMode;
  label: string;
  description: string;
  approxWait: string;  // simulated, not live
  fare: string;        // illustrative demo estimate
}

// ─── TIMETABLE NOTICE (displayed wherever timetable data appears) ────────────
export const TIMETABLE_NOTICE =
  'Approximate demo estimates — not live or verified departure times.';

// ─── PHYSICAL STATIONS (54 unique stations) ─────────────────────────────────
// Each station appears ONCE. Line membership is declared via lineIds[].
// Shared interchange stations: old-high-court, motera-stadium, gnlu.
export const PHYSICAL_STATIONS: Station[] = [
  // ── Blue Line unique stations ──────────────────────────────────────────────
  {
    id: 'thaltej-gam',
    name: 'Thaltej Gam',
    lineIds: ['blue'],
    isTerminus: true,
  },
  {
    id: 'thaltej',
    name: 'Thaltej',
    lineIds: ['blue'],
  },
  {
    id: 'doordarshan-kendra',
    name: 'Doordarshan Kendra',
    lineIds: ['blue'],
  },
  {
    id: 'gurukul-road',
    name: 'Gurukul Road',
    lineIds: ['blue'],
  },
  {
    id: 'gujarat-university',
    name: 'Gujarat University',
    lineIds: ['blue'],
    otherModes: ['brts'],
  },
  {
    id: 'commerce-six-road',
    name: 'Commerce Six Road',
    lineIds: ['blue'],
    otherModes: ['brts'],
  },
  {
    id: 'sp-stadium',
    name: 'SP Stadium',
    lineIds: ['blue'],
  },
  // ── OLD HIGH COURT — Blue ↔ Red interchange ────────────────────────────────
  {
    id: 'old-high-court',
    name: 'Old High Court',
    lineIds: ['blue', 'red'],
    otherModes: ['amts'],
    verificationNote:
      'Interchange between Blue (East–West) and Red (North–South) lines. Platform layout unverified.',
  },
  {
    id: 'shahpur',
    name: 'Shahpur',
    lineIds: ['blue'],
  },
  {
    id: 'gheekanta',
    name: 'Gheekanta',
    lineIds: ['blue'],
    otherModes: ['amts', 'auto'],
  },
  {
    id: 'kalupur-railway-station',
    name: 'Kalupur Railway Station',
    lineIds: ['blue'],
    otherModes: ['amts', 'brts', 'auto'],
  },
  {
    id: 'kankaria-east',
    name: 'Kankaria East',
    lineIds: ['blue'],
  },
  {
    id: 'apparel-park',
    name: 'Apparel Park',
    lineIds: ['blue'],
  },
  {
    id: 'amraiwadi',
    name: 'Amraiwadi',
    lineIds: ['blue'],
  },
  {
    id: 'rabari-colony',
    name: 'Rabari Colony',
    lineIds: ['blue'],
  },
  {
    id: 'vastral',
    name: 'Vastral',
    lineIds: ['blue'],
  },
  {
    id: 'nirant-cross-road',
    name: 'Nirant Cross Road',
    lineIds: ['blue'],
  },
  {
    id: 'vastral-gam',
    name: 'Vastral Gam',
    lineIds: ['blue'],
    isTerminus: true,
  },

  // ── Red Line unique stations ────────────────────────────────────────────────
  {
    id: 'apmc',
    name: 'APMC',
    lineIds: ['red'],
    isTerminus: true,
  },
  {
    id: 'jivraj-park',
    name: 'Jivraj Park',
    lineIds: ['red'],
  },
  {
    id: 'rajiv-nagar',
    name: 'Rajiv Nagar',
    lineIds: ['red'],
  },
  {
    id: 'shreyas',
    name: 'Shreyas',
    lineIds: ['red'],
  },
  {
    id: 'paldi',
    name: 'Paldi',
    lineIds: ['red'],
  },
  {
    id: 'gandhigram',
    name: 'Gandhigram',
    lineIds: ['red'],
  },
  // old-high-court is shared — declared in Blue section above
  {
    id: 'usmanpura',
    name: 'Usmanpura',
    lineIds: ['red'],
  },
  {
    id: 'vijay-nagar',
    name: 'Vijay Nagar',
    lineIds: ['red'],
  },
  {
    id: 'vadaj',
    name: 'Vadaj',
    lineIds: ['red'],
  },
  {
    id: 'ranip',
    name: 'Ranip',
    lineIds: ['red'],
  },
  {
    id: 'sabarmati-railway-station',
    name: 'Sabarmati Railway Station',
    lineIds: ['red'],
    verificationNote:
      'Included in publicly available GMRC phase maps. Precise operational status is unverified in this demo network.',
  },
  {
    id: 'aec',
    name: 'AEC',
    lineIds: ['red'],
  },
  {
    id: 'sabarmati',
    name: 'Sabarmati',
    lineIds: ['red'],
  },
  // ── MOTERA STADIUM — Red ↔ Yellow interchange ──────────────────────────────
  {
    id: 'motera-stadium',
    name: 'Motera Stadium',
    lineIds: ['red', 'yellow'],
    isTerminus: true,   // terminus for Red; first stop of Yellow
    verificationNote:
      'Interchange between Red (North–South) and Yellow (Motera–Gandhinagar) lines.',
  },

  // ── Yellow Line unique stations ─────────────────────────────────────────────
  {
    id: 'koteshwar-road',
    name: 'Koteshwar Road',
    lineIds: ['yellow'],
    verificationNote:
      'SIMULATED INTERCHANGE at this station is a demo scenario only. ' +
      'No official connecting metro line to Koteshwar Road has been announced or verified. ' +
      'The extra transfer edge in the routing graph is explicitly labelled as unverified/simulated.',
  },
  {
    id: 'vishwakarma-college',
    name: 'Vishwakarma College',
    lineIds: ['yellow'],
  },
  {
    id: 'tapovan-circle',
    name: 'Tapovan Circle',
    lineIds: ['yellow'],
  },
  {
    id: 'narmada-canal',
    name: 'Narmada Canal',
    lineIds: ['yellow'],
  },
  {
    id: 'koba-circle',
    name: 'Koba Circle',
    lineIds: ['yellow'],
  },
  {
    id: 'juna-koba',
    name: 'Juna Koba',
    lineIds: ['yellow'],
  },
  {
    id: 'koba-gam',
    name: 'Koba Gam',
    lineIds: ['yellow'],
  },
  // ── GNLU — Yellow ↔ Violet interchange ────────────────────────────────────
  {
    id: 'gnlu',
    name: 'GNLU',
    lineIds: ['yellow', 'violet'],
    verificationNote:
      'Interchange between Yellow (Motera–Gandhinagar) and Violet (GIFT City branch) lines.',
  },
  {
    id: 'raysan',
    name: 'Raysan',
    lineIds: ['yellow'],
  },
  {
    id: 'randesan',
    name: 'Randesan',
    lineIds: ['yellow'],
  },
  {
    id: 'dholakuva-circle',
    name: 'Dholakuva Circle',
    lineIds: ['yellow'],
  },
  {
    id: 'infocity',
    name: 'Infocity',
    lineIds: ['yellow'],
  },
  {
    id: 'sector-1',
    name: 'Sector-1',
    lineIds: ['yellow'],
  },
  {
    id: 'sector-10a',
    name: 'Sector-10A',
    lineIds: ['yellow'],
  },
  {
    id: 'sachivalaya',
    name: 'Sachivalaya',
    lineIds: ['yellow'],
  },
  {
    id: 'akshardham',
    name: 'Akshardham',
    lineIds: ['yellow'],
  },
  {
    id: 'juna-sachivalaya',
    name: 'Juna Sachivalaya',
    lineIds: ['yellow'],
  },
  {
    id: 'sector-16',
    name: 'Sector-16',
    lineIds: ['yellow'],
  },
  {
    id: 'sector-24',
    name: 'Sector-24',
    lineIds: ['yellow'],
  },
  {
    id: 'mahatma-mandir',
    name: 'Mahatma Mandir',
    lineIds: ['yellow'],
    isTerminus: true,
  },

  // ── Violet Line unique stations ─────────────────────────────────────────────
  // gnlu is shared — declared in Yellow section above
  {
    id: 'pdeu',
    name: 'PDEU',
    lineIds: ['violet'],
  },
  {
    id: 'gift-city',
    name: 'GIFT City',
    lineIds: ['violet'],
    isTerminus: true,
  },
];

// ─── INDEX: station by ID ───────────────────────────────────────────────────
export const STATION_BY_ID: Record<string, Station> = Object.fromEntries(
  PHYSICAL_STATIONS.map((s) => [s.id, s]),
);

// ─── METRO LINES (with ordered stop IDs) ────────────────────────────────────
export const METRO_LINES: MetroLine[] = [
  // ── Blue Line — East–West (18 stations) ────────────────────────────────────
  {
    id: 'blue',
    name: 'Blue Line — East–West Corridor',
    shortName: 'Blue',
    hexColor: '#1D4ED8',
    direction: 'Thaltej Gam → Vastral Gam',
    stops: [
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
    ],
    timetable: {
      firstTrain: '06:20',
      lastTrain: '22:00–22:05',
      frequencyMin: '9–12',
      endToEndMin: 44,
      notice: TIMETABLE_NOTICE,
    },
  },

  // ── Red Line — North–South (15 stations) ───────────────────────────────────
  {
    id: 'red',
    name: 'Red Line — North–South Corridor',
    shortName: 'Red',
    hexColor: '#B91C1C',
    direction: 'APMC → Motera Stadium',
    stops: [
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
    ],
    timetable: {
      firstTrain: '06:20',
      lastTrain: '22:05–22:09',
      frequencyMin: '9–12',
      endToEndMin: 32,
      notice: TIMETABLE_NOTICE,
    },
  },

  // ── Yellow Line — Motera to Gandhinagar (21 stations) ──────────────────────
  {
    id: 'yellow',
    name: 'Yellow Line — Motera–Gandhinagar',
    shortName: 'Yellow',
    hexColor: '#CA8A04',
    direction: 'Motera Stadium → Mahatma Mandir',
    stops: [
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
    ],
    timetable: {
      firstTrain: '07:26–08:32',
      lastTrain: '19:22–19:31',
      frequencyMin: '~12',
      endToEndMin: 46,
      notice: TIMETABLE_NOTICE,
    },
  },

  // ── Violet Line — GIFT City branch (3 stations) ────────────────────────────
  {
    id: 'violet',
    name: 'Violet Line — GIFT City Branch',
    shortName: 'Violet',
    hexColor: '#7C3AED',
    direction: 'GNLU → GIFT City',
    stops: [
      'gnlu',
      'pdeu',
      'gift-city',
    ],
    timetable: {
      firstTrain: '07:43–07:57',
      lastTrain: '18:13–18:23',
      frequencyMin: '~12',
      endToEndMin: 8,
      notice: TIMETABLE_NOTICE,
    },
  },
];

// ─── INDEX: line by ID ──────────────────────────────────────────────────────
export const LINE_BY_ID: Record<LineId, MetroLine> = Object.fromEntries(
  METRO_LINES.map((l) => [l.id, l]),
) as Record<LineId, MetroLine>;

/**
 * STATIONS — flat list of unique physical stations, for use in
 * boarding selector, destination datalist, and search.
 * Each station appears ONCE. Shared interchange stations appear ONCE.
 */
export const STATIONS: { id: string; name: string; lineIds: LineId[] }[] =
  PHYSICAL_STATIONS.map((s) => ({ id: s.id, name: s.name, lineIds: s.lineIds }));

// ─── LAST-MILE OPTIONS (simulated) ──────────────────────────────────────────
export const LAST_MILE_OPTIONS: LastMileOption[] = [
  {
    mode: 'amts',
    label: 'AMTS City Bus',
    description:
      'Ahmedabad Municipal Transport Service — urban bus network covering most neighbourhoods.',
    approxWait: '~8 min (simulated)',
    fare: '₹5 – ₹15 (illustrative demo estimate)',
  },
  {
    mode: 'brts',
    label: 'Janmarg BRTS',
    description:
      'Bus Rapid Transit System — dedicated corridors on SG Highway, Satellite Road, and other arterials.',
    approxWait: '~5 min (simulated)',
    fare: '₹5 – ₹20 (illustrative demo estimate)',
  },
  {
    mode: 'auto',
    label: 'Auto-Rickshaw',
    description:
      'Available outside most metro stations. Metered fare as per RTO tariff.',
    approxWait: 'Immediate – 3 min (simulated)',
    fare: '₹25 minimum + meter (illustrative demo estimate)',
  },
];

// ─── SAMPLE JOURNEY (used before a real route is calculated) ────────────────
// References live data structures so it stays consistent if station data changes.
const _blueLine = LINE_BY_ID['blue'];
export const SAMPLE_JOURNEY = {
  from: 'Thaltej Gam',
  to: 'Kalupur Railway Station',
  line: _blueLine,
  boardAt: 'Thaltej Gam',
  alightAt: 'Kalupur Railway Station',
  // First 11 stops of the Blue Line (Thaltej Gam → Kalupur Railway Station incl.)
  stops: _blueLine.stops.slice(0, 11).map((id) => STATION_BY_ID[id]),
  durationMin: 28,         // simulated
  fareINR: 30,             // simulated
  nextDeparture: '09:14',  // simulated
};
