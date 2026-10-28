/**
 * Rapido Last-Mile Handoff Utility
 *
 * IMPORTANT:
 * Rapido does NOT publicly document a deep-link or URL parameter format
 * for third-party prefill of pickup/destination.
 * (Verified by search — no public API or deep-link spec found, Oct 2026.)
 *
 * We therefore implement the reliable fallback:
 * - Open https://www.rapido.bike/ in a new tab.
 * - Show a confirmation panel with pickup, destination, and copy buttons.
 * - Allow users to copy journey details into Rapido manually.
 *
 * This utility constructs the copyable text and the Rapido URL.
 * It does NOT claim a ride is booked, does not claim live availability,
 * and does not show actual fares from Rapido.
 */

export const RAPIDO_BASE_URL = 'https://www.rapido.bike/';

export interface RapidoHandoffData {
  pickupStation: string;
  /**
   * Metro alighting station — kept for backward compatibility.
   * In the Rapido panel the pickup IS the metro exit, so this field is used
   * only when `onwardDestination` is not supplied.
   */
  dropStation?: string;
  /**
   * User-entered final destination address (post-metro leg).
   * When present, takes precedence over `dropStation` in the detail text.
   */
  onwardDestination?: string;
}

/**
 * Build a safe URL to open the Rapido website.
 * No pickup/drop prefill is attempted (no public format exists).
 * Returns RAPIDO_BASE_URL.
 */
export function buildRapidoUrl(_data: RapidoHandoffData): string {
  // No supported deep-link format — open the homepage.
  return RAPIDO_BASE_URL;
}

/**
 * Build a human-readable journey detail string for copy/paste into the Rapido app.
 *
 * `onwardDestination` (user-entered final address) takes precedence over the
 * legacy `dropStation` field. Returns null if pickupStation or a destination
 * value is missing.
 */
export function buildJourneyDetailText(data: Partial<RapidoHandoffData>): string | null {
  const { pickupStation, dropStation, onwardDestination } = data;
  if (!pickupStation) return null;
  // Prefer the user-entered onward destination; fall back to dropStation
  const destination = onwardDestination || dropStation;
  if (!destination) return null;
  return [
    'TransitSync — Last-Mile Handoff (Auto-Rickshaw via Rapido)',
    `Pickup:      ${pickupStation}`,
    `Destination: ${destination}`,
    '',
    'Note: Enter these details manually in the Rapido app.',
    'Rapido availability, fare, and booking are handled entirely by Rapido.',
  ].join('\n');
}

/**
 * Attempt to copy text to the clipboard.
 * Returns true on success, false if clipboard API is unavailable or denied.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
    // Fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
