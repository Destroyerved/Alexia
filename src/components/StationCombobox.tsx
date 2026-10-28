/**
 * StationCombobox — grouped, searchable station selector.
 *
 * Groups metro stations by line in the display order:
 *   Yellow Line → Red Line → Blue Line → Violet Line
 *
 * Shared interchange stations (Old High Court, Motera Stadium, GNLU) appear
 * in each line's group that they belong to. Exclusion by physical station ID
 * removes the station from ALL line groups it appears in.
 *
 * Accessibility: implements ARIA 1.1 combobox pattern with listbox popup.
 */
import { useState, useRef, useEffect, useMemo, useId } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { LINE_BY_ID, STATION_BY_ID, type LineId } from '../data/stationData';

/** Line display order per spec: Yellow → Red → Blue → Violet */
const LINE_ORDER: LineId[] = ['yellow', 'red', 'blue', 'violet'];

interface StationOption {
  id: string;
  name: string;
}

interface LineGroup {
  lineId: LineId;
  lineName: string;
  lineColor: string;
  stations: StationOption[];
}

interface FlatOption {
  id: string;
  name: string;
  lineId: LineId;
}

export interface StationComboboxProps {
  /** id for the underlying <input>, so the parent <label htmlFor> works */
  id: string;
  /** Current selected station ID (controlled) */
  value: string;
  /** Called with the new station ID when user selects, or '' when cleared */
  onChange: (stationId: string) => void;
  /** Station ID to exclude from all line groups (for destination selector) */
  excludeId?: string;
  placeholder?: string;
}

const LINE_DOT_CLASS: Record<LineId, string> = {
  yellow: 'bg-yellow-500',
  red:    'bg-red-600',
  blue:   'bg-blue-700',
  violet: 'bg-violet-600',
};

function buildAllGroups(excludeId?: string): LineGroup[] {
  return LINE_ORDER.map((lineId) => {
    const line = LINE_BY_ID[lineId];
    const stations: StationOption[] = line.stops
      .filter((sid) => sid !== excludeId)
      .map((sid) => ({ id: sid, name: STATION_BY_ID[sid]?.name ?? sid }));
    return {
      lineId,
      lineName: line.shortName + ' Line',
      lineColor: line.hexColor,
      stations,
    };
  }).filter((g) => g.stations.length > 0);
}

export default function StationCombobox({
  id,
  value,
  onChange,
  excludeId,
  placeholder = '— Search or select station —',
}: StationComboboxProps) {
  const listboxId   = useId();
  const inputRef    = useRef<HTMLInputElement>(null);
  const wrapperRef  = useRef<HTMLDivElement>(null);

  const [inputText,      setInputText]      = useState('');
  const [isOpen,         setIsOpen]         = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(-1);

  // Sync display text whenever the controlled value changes
  useEffect(() => {
    setInputText(value ? (STATION_BY_ID[value]?.name ?? '') : '');
  }, [value]);

  // Reset keyboard highlight when exclusion list changes
  useEffect(() => {
    setHighlightedIdx(-1);
  }, [excludeId]);

  // Close dropdown on click/touch outside
  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setHighlightedIdx(-1);
        setInputText(value ? (STATION_BY_ID[value]?.name ?? '') : '');
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  // The effect only needs to re-subscribe when `value` changes (for the revert)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // ── Derived option lists ───────────────────────────────────────────────────

  const allGroups = useMemo(() => buildAllGroups(excludeId), [excludeId]);

  const filteredGroups = useMemo<LineGroup[]>(() => {
    const q = inputText.toLowerCase().trim();
    if (!q) return allGroups;
    return allGroups
      .map((g) => ({
        ...g,
        stations: g.stations.filter((s) =>
          s.name.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.stations.length > 0);
  }, [allGroups, inputText]);

  const flatOptions = useMemo<FlatOption[]>(
    () =>
      filteredGroups.flatMap((g) =>
        g.stations.map((s) => ({ id: s.id, name: s.name, lineId: g.lineId })),
      ),
    [filteredGroups],
  );

  // ── Helpers ────────────────────────────────────────────────────────────────

  const optionElementId = (lineId: LineId, stationId: string) =>
    `${listboxId}-opt-${lineId}-${stationId}`;

  const activeDescendant =
    highlightedIdx >= 0 && flatOptions[highlightedIdx]
      ? optionElementId(
          flatOptions[highlightedIdx].lineId,
          flatOptions[highlightedIdx].id,
        )
      : undefined;

  const selectOption = (stationId: string, name: string) => {
    onChange(stationId);
    setInputText(name);
    setIsOpen(false);
    setHighlightedIdx(-1);
  };

  const clearSelection = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
    setInputText('');
    setIsOpen(false);
    setHighlightedIdx(-1);
    inputRef.current?.focus();
  };

  // ── Event handlers ─────────────────────────────────────────────────────────

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    setInputText(text);
    setIsOpen(true);
    setHighlightedIdx(-1);
    if (!text) onChange('');
  };

  const handleInputFocus = () => setIsOpen(true);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        setHighlightedIdx(-1);
        setInputText(value ? (STATION_BY_ID[value]?.name ?? '') : '');
        break;
      case 'ArrowDown':
        e.preventDefault();
        setIsOpen(true);
        setHighlightedIdx((prev) =>
          prev < flatOptions.length - 1 ? prev + 1 : prev,
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIdx((prev) => (prev > 0 ? prev - 1 : 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (isOpen && highlightedIdx >= 0) {
          const opt = flatOptions[highlightedIdx];
          if (opt) selectOption(opt.id, opt.name);
        } else {
          setIsOpen(true);
        }
        break;
      case 'Tab':
        if (isOpen) {
          setIsOpen(false);
          setHighlightedIdx(-1);
          setInputText(value ? (STATION_BY_ID[value]?.name ?? '') : '');
        }
        break;
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div ref={wrapperRef} className="relative">
      {/* Input row */}
      <div className="relative flex items-center">
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-activedescendant={activeDescendant}
          value={inputText}
          onChange={handleInputChange}
          onFocus={handleInputFocus}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="w-full border border-gray-300 rounded-md pl-3 pr-14 py-2 text-sm text-gray-800 bg-white focus:outline-none focus:ring-2 focus:ring-[#0B2545] focus:border-[#0B2545]"
        />
        {value && (
          <button
            type="button"
            onClick={clearSelection}
            tabIndex={-1}
            className="absolute right-7 flex items-center justify-center text-gray-400 hover:text-gray-600 focus:outline-none p-0.5"
            aria-label="Clear selection"
          >
            <X size={13} aria-hidden="true" />
          </button>
        )}
        <ChevronDown
          size={14}
          className="absolute right-2.5 text-gray-400 pointer-events-none"
          aria-hidden="true"
        />
      </div>

      {/* Dropdown */}
      {isOpen && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Metro stations"
          className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-md shadow-lg max-h-64 overflow-y-auto text-sm"
        >
          {filteredGroups.length === 0 ? (
            <li
              role="option"
              aria-selected={false}
              className="px-3 py-2 text-xs text-gray-400 italic"
            >
              No stations match your search.
            </li>
          ) : (
            filteredGroups.map((group) => (
              <li key={group.lineId} role="presentation">
                {/* Group header */}
                <div
                  role="presentation"
                  className="sticky top-0 bg-gray-50 border-b border-gray-100 px-3 py-1.5 flex items-center gap-2"
                >
                  <span
                    className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${LINE_DOT_CLASS[group.lineId]}`}
                    aria-hidden="true"
                  />
                  <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
                    {group.lineName}
                  </span>
                </div>
                {/* Options */}
                <ul role="presentation">
                  {group.stations.map((station) => {
                    const flatIdx = flatOptions.findIndex(
                      (o) => o.id === station.id && o.lineId === group.lineId,
                    );
                    const isHighlighted = highlightedIdx === flatIdx && flatIdx >= 0;
                    const isSelected    = station.id === value;
                    return (
                      <li
                        key={`${group.lineId}-${station.id}`}
                        id={optionElementId(group.lineId, station.id)}
                        role="option"
                        aria-selected={isSelected}
                        // Prevent input blur before click fires
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => selectOption(station.id, station.name)}
                        className={[
                          'px-4 py-2 cursor-pointer transition-colors',
                          isHighlighted
                            ? 'bg-[#0B2545] text-white'
                            : isSelected
                            ? 'bg-blue-50 text-[#0B2545] font-semibold'
                            : 'text-gray-800 hover:bg-gray-50',
                        ].join(' ')}
                      >
                        {station.name}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
