/**
 * 1. searchPlaces(query)
 * Fuzzy offline search over stations + places.
 * Returns matches with type so the UI can ask "where near Vastral?".
 */

import { STATIONS, PLACES } from './data';
import type { PlaceMatch } from './types';

export function searchPlaces(query: string): PlaceMatch[] {
  if (!query || !query.trim()) return [];
  const q = query.trim().toLowerCase();

  const results: PlaceMatch[] = [];

  // Match stations
  for (const s of STATIONS) {
    const sNameLower = s.name.toLowerCase();
    if (sNameLower.includes(q)) {
      results.push({
        id: `station-${s.id}`,
        name: s.name,
        type: 'station',
        subtitle: `Metro Station (${s.lineIds.map((l) => l.toUpperCase()).join(' / ')} Line)`,
        stationId: s.id,
      });
    }
  }

  // Match places
  for (const p of PLACES) {
    const pNameLower = p.name.toLowerCase();
    const areaLower = p.area.toLowerCase();
    const catLower = p.category.toLowerCase();
    const qNorm = q.replace(/k/g, 'c');
    const pNameNorm = pNameLower.replace(/k/g, 'c');

    if (
      pNameLower.includes(q) ||
      areaLower.includes(q) ||
      catLower.includes(q) ||
      pNameNorm.includes(qNorm)
    ) {
      results.push({
        id: `place-${p.id}`,
        name: p.name,
        type: 'place',
        subtitle: `${p.area} • Nearest Metro: ${p.nearestStation}`,
        area: p.area,
        nearestStation: p.nearestStation,
        lat: p.lat,
        lon: p.lon,
      });
    }
  }

  // Sort matches:
  // 1. Exact name match first
  // 2. Starts-with match next
  // 3. Stations before places
  // 4. Alphabetical
  return results.sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    const aExact = aName === q;
    const bExact = bName === q;
    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;

    const aStarts = aName.startsWith(q);
    const bStarts = bName.startsWith(q);
    if (aStarts && !bStarts) return -1;
    if (!aStarts && bStarts) return 1;

    if (a.type !== b.type) {
      return a.type === 'station' ? -1 : 1;
    }

    return a.name.localeCompare(b.name);
  });
}
