import { useState, useRef, useEffect, useId } from 'react';
import { Search, Navigation, X, Building, Train } from 'lucide-react';
import { searchPlaces, type PlaceMatch } from '../engine';
import { METRO_NEAREST_STOPS } from '../engine/data';

export interface UnifiedSearchInputProps {
  id: string;
  label: string;
  query: string;
  selected: PlaceMatch | null;
  onQueryChange: (query: string) => void;
  onSelect: (item: PlaceMatch | null) => void;
  placeholder?: string;
  enableGPS?: boolean;
}

export default function UnifiedSearchInput({
  id,
  label,
  query,
  selected,
  onQueryChange,
  onSelect,
  placeholder = 'Search station or landmark...',
  enableGPS = false,
}: UnifiedSearchInputProps) {
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const [isOpen, setIsOpen] = useState(false);
  const [matches, setMatches] = useState<PlaceMatch[]>([]);
  const [highlightedIdx, setHighlightedIdx] = useState(-1);
  const [isLocating, setIsLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  // Close dropdown on click outside
  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    // Typing updates query and clears selected
    onQueryChange(text);
    onSelect(null);

    // Matching must use only query, never selected. Show up to 8 matches immediately.
    if (text.trim().length > 0) {
      const results = searchPlaces(text).slice(0, 8);
      setMatches(results);
      setIsOpen(true);
      setHighlightedIdx(-1);
    } else {
      setMatches([]);
      setIsOpen(true);
    }
  };

  const handleSelect = (match: PlaceMatch) => {
    // Choosing a result sets both query and selected
    onQueryChange(match.name);
    onSelect(match);
    setIsOpen(false);
    setHighlightedIdx(-1);
  };

  const handleClear = () => {
    // The x button clears the field and keeps focus and the dropdown open
    onQueryChange('');
    onSelect(null);
    setMatches([]);
    setIsOpen(true);
    inputRef.current?.focus();
  };

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    // On focus, select all text so the next keystroke replaces it
    e.currentTarget.select();

    if (query.trim().length > 0) {
      const results = searchPlaces(query).slice(0, 8);
      setMatches(results);
      setIsOpen(true);
      setHighlightedIdx(-1);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen && matches.length > 0) {
        setIsOpen(true);
        setHighlightedIdx(0);
        return;
      }
      setHighlightedIdx((prev) => (prev < matches.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIdx((prev) => (prev > 0 ? prev - 1 : matches.length - 1));
    } else if (e.key === 'Enter') {
      if (isOpen && highlightedIdx >= 0 && matches[highlightedIdx]) {
        e.preventDefault();
        handleSelect(matches[highlightedIdx]);
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  const handleGPS = () => {
    if (!navigator.geolocation) {
      setLocationError('Geolocation not supported on this device');
      return;
    }
    setIsLocating(true);
    setLocationError(null);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setIsLocating(false);
        const { latitude, longitude } = pos.coords;

        // Find nearest station from METRO_NEAREST_STOPS coordinates
        let minD = Infinity;
        let closestStationName: string | null = null;

        for (const [stName, data] of Object.entries(METRO_NEAREST_STOPS)) {
          if (data?.lat && data?.lon) {
            const d =
              Math.pow(latitude - data.lat, 2) + Math.pow(longitude - data.lon, 2);
            if (d < minD) {
              minD = d;
              closestStationName = stName;
            }
          }
        }

        if (closestStationName) {
          const match = searchPlaces(closestStationName).find(
            (p) => p.name.toLowerCase() === closestStationName?.toLowerCase(),
          );
          if (match) {
            handleSelect(match);
          } else {
            onQueryChange(closestStationName);
            onSelect(null);
          }
        }
      },
      (err) => {
        setIsLocating(false);
        setLocationError(`Location error: ${err.message}`);
      },
      { timeout: 8000 },
    );
  };

  return (
    <div ref={wrapperRef} className="relative w-full">
      <div className="flex items-center justify-between mb-1">
        <label
          htmlFor={id}
          className="block text-xs font-bold text-gray-700 uppercase tracking-wide"
        >
          {label}
        </label>
        {enableGPS && (
          <button
            type="button"
            onClick={handleGPS}
            disabled={isLocating}
            className="flex items-center gap-1 text-[11px] text-[#0B2545] hover:text-blue-800 font-medium focus:outline-none focus:underline"
            title="Use current location to find nearest metro station"
          >
            <Navigation size={11} className={isLocating ? 'animate-spin' : ''} />
            {isLocating ? 'Locating...' : 'Nearest Station'}
          </button>
        )}
      </div>

      <div className="relative flex items-center">
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={isOpen}
          aria-autocomplete="list"
          aria-controls={listboxId}
          data-selected={Boolean(selected)}
          value={query}
          onChange={handleInputChange}
          onFocus={handleFocus}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="w-full border border-gray-300 rounded-md pl-9 pr-8 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-[#0B2545] focus:border-[#0B2545]"
        />

        <Search size={15} className="absolute left-2.5 text-gray-400 pointer-events-none" />

        {query && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute right-2 text-gray-400 hover:text-gray-600 focus:outline-none p-1"
            aria-label="Clear search"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {locationError && (
        <p className="text-[11px] text-red-600 mt-0.5">{locationError}</p>
      )}

      {/* Autocomplete / Disambiguation dropdown */}
      {isOpen && matches.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-y-auto divide-y divide-gray-100 text-sm"
        >
          {matches.map((match, idx) => {
            const isSelected = highlightedIdx === idx;
            return (
              <li
                key={match.id}
                role="option"
                aria-selected={isSelected}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleSelect(match);
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                }}
                onClick={() => handleSelect(match)}
                className={`px-3 py-2 cursor-pointer flex items-start gap-2.5 transition-colors ${
                  isSelected ? 'bg-blue-50 text-[#0B2545]' : 'hover:bg-gray-50 text-gray-800'
                }`}
              >
                <div className="mt-0.5 shrink-0 text-gray-400">
                  {match.type === 'station' ? (
                    <Train size={15} className="text-[#0B2545]" />
                  ) : (
                    <Building size={15} className="text-[#FF9933]" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-semibold text-xs sm:text-sm text-gray-900 truncate">
                      {match.name}
                    </span>
                    <span
                      className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                        match.type === 'station'
                          ? 'bg-blue-100 text-blue-800'
                          : 'bg-amber-100 text-amber-800'
                      }`}
                    >
                      {match.type === 'station' ? 'Metro station' : 'Place'}
                    </span>
                  </div>
                  {match.subtitle && (
                    <p className="text-xs text-gray-500 truncate">{match.subtitle}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
