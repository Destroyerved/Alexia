import { useState } from 'react';
import { Navigation, AlertCircle, ArrowRight, HelpCircle } from 'lucide-react';
import UnifiedSearchInput from './UnifiedSearchInput';
import { searchPlaces, type PlaceMatch } from '../engine';

interface JourneyPlannerProps {
  originQuery: string;
  originSelected: PlaceMatch | null;
  destQuery: string;
  destSelected: PlaceMatch | null;
  onOriginQueryChange: (query: string) => void;
  onOriginSelect: (item: PlaceMatch | null) => void;
  onDestQueryChange: (query: string) => void;
  onDestSelect: (item: PlaceMatch | null) => void;
  onFindRoute: () => void;
}

export default function JourneyPlanner({
  originQuery,
  originSelected,
  destQuery,
  destSelected,
  onOriginQueryChange,
  onOriginSelect,
  onDestQueryChange,
  onDestSelect,
  onFindRoute,
}: JourneyPlannerProps) {
  const [disambigList, setDisambigList] = useState<PlaceMatch[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleDestinationQueryChange = (text: string) => {
    onDestQueryChange(text);
    setValidationError(null);

    // If destination was typed as a general area (e.g. "Vastral"), check for multiple matches
    if (text.trim().length >= 3) {
      const placesInArea = searchPlaces(text).filter((p) => p.type === 'place');
      if (placesInArea.length > 1) {
        setDisambigList(placesInArea);
      } else {
        setDisambigList([]);
      }
    } else {
      setDisambigList([]);
    }
  };

  const handleDestinationSelect = (item: PlaceMatch | null) => {
    onDestSelect(item);
    setValidationError(null);
    setDisambigList([]);
  };

  const handleOriginQueryChange = (text: string) => {
    onOriginQueryChange(text);
    setValidationError(null);
  };

  const handleOriginSelect = (item: PlaceMatch | null) => {
    onOriginSelect(item);
    setValidationError(null);
  };

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    // Validate selections
    if (!originSelected) {
      setValidationError('Choose a boarding station from the list');
      return;
    }
    if (!destSelected) {
      setValidationError('Choose a destination from the list');
      return;
    }
    if (originSelected.name === destSelected.name) {
      setValidationError('Boarding and destination cannot be the same station.');
      return;
    }

    setValidationError(null);
    onFindRoute();
  };

  return (
    <section
      aria-labelledby="planner-heading"
      className="bg-[#F4E8D8] border border-[#E3D2B8] rounded-lg shadow-sm p-4 sm:p-6 relative z-10"
    >
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2
          id="planner-heading"
          className="text-base sm:text-lg font-bold text-[#0B2545] flex items-center gap-2"
        >
          <Navigation size={18} className="text-[#FF9933]" aria-hidden="true" />
          Plan Your Journey
        </h2>
        <span className="text-[11px] text-gray-500 italic">
          GMRC Metro & Feeder Bus GTFS (Offline-ready)
        </span>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          {/* Origin / Boarding Station */}
          <div>
            <UnifiedSearchInput
              id="boarding-input"
              label="Boarding Station"
              query={originQuery}
              selected={originSelected}
              onQueryChange={handleOriginQueryChange}
              onSelect={handleOriginSelect}
              placeholder="Type metro station or use GPS..."
              enableGPS={true}
            />
          </div>

          {/* Destination Station / Landmark */}
          <div>
            <UnifiedSearchInput
              id="destination-input"
              label="Destination"
              query={destQuery}
              selected={destSelected}
              onQueryChange={handleDestinationQueryChange}
              onSelect={handleDestinationSelect}
              placeholder="Station, landmark, or area (e.g. Science City, Vastral)..."
              enableGPS={false}
            />
          </div>
        </div>

        {/* Disambiguation chooser banner */}
        {disambigList.length > 0 && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-900">
            <div className="flex items-center gap-1.5 font-semibold text-amber-800 mb-2">
              <HelpCircle size={14} className="text-amber-600" />
              Where near {destQuery} do you want to go?
            </div>
            <div className="flex flex-wrap gap-1.5">
              {disambigList.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onDestQueryChange(p.name);
                    onDestSelect(p);
                    setDisambigList([]);
                  }}
                  className="bg-white hover:bg-amber-100 border border-amber-300 text-amber-900 px-2 py-1 rounded text-xs transition-colors"
                >
                  {p.name}{' '}
                  {p.nearestStation && (
                    <span className="text-gray-500 font-normal">
                      ({p.nearestStation})
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Inline Validation Error Message */}
        {validationError && (
          <p
            role="alert"
            className="flex items-center gap-1.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2.5 mb-3"
          >
            <AlertCircle size={14} className="shrink-0 text-red-600" />
            <span>{validationError}</span>
          </p>
        )}

        {/* Find Route Button */}
        <button
          type="submit"
          className="w-full sm:w-auto bg-[#0B2545] hover:bg-[#163a6b] text-white font-semibold text-sm px-6 py-2.5 rounded-md transition-colors flex items-center justify-center gap-2 cursor-pointer shadow-sm active:scale-[0.99]"
          aria-label="Find route between selected stations"
        >
          <span>Find Route</span>
          <ArrowRight size={15} />
        </button>
      </form>
    </section>
  );
}
