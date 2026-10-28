<<<<<<< HEAD
# TransitSync 🚇
### One journey. Multiple modes. Fewer surprises.

TransitSync is an offline-first, Ahmedabad-focused public transport journey planner built during **METRO HACKS by GDG Gandhinagar**.

It explores a practical problem with urban commuting: reaching a destination often requires more than one mode of transport. A metro may cover most of the journey, but commuters still need to figure out the connection to a city bus, BRTS stop, or last-mile ride.

TransitSync brings these parts of a journey into one interface, helping commuters understand their metro route, possible transfers, delays, and onward travel options without depending on a continuously available internet connection for its core application.

**Live demo:** https://metrohacks-transitsync-gdg.netlify.app/

---

## The problem we're solving

Public transport journeys are rarely as simple as boarding one vehicle and getting off at the final stop.

A commuter might need to:

- Find a metro route between two stations.
- Understand whether the journey requires a transfer.
- Account for a possible delay before making the next connection.
- Identify onward travel options after reaching the destination metro station.
- Access basic journey-planning information even when connectivity is unreliable.

When these decisions are scattered across different websites, apps, and transport systems, planning a single journey becomes unnecessarily complicated.

TransitSync explores a more coordinated approach: **plan the metro journey first, then consider what happens before and after it.**

The focus is not just on finding a route between two stations. It is on making the overall journey easier to understand.

## What TransitSync does

### 🚉 Metro journey planning

TransitSync includes Ahmedabad Metro station and line data for four lines:

- Blue Line
- Red Line
- Yellow Line
- Violet Line

The planner uses the available station and interchange data to calculate a route between selected stations. Route information can include the journey's stops, transfers, and estimated travel duration.

Shared interchange stations need to be treated as the same physical station, even when they belong to multiple lines. This is important for producing meaningful routes rather than treating every line's station entry as an unrelated location.

### ⏱️ Delay simulation

TransitSync includes a delay simulator that demonstrates how a disruption can affect a planned journey.

Rather than presenting a simulated delay as a real incident, the feature allows users to explore the effect of additional delay on the journey estimate.

This is useful for demonstrating disruption-aware planning, but it is **not a live metro delay feed**.

### 🚌 Last-mile coordination

A metro station is not necessarily the commuter's final destination. TransitSync includes a last-mile section for exploring onward transport options such as:

- **AMTS:** Ahmedabad's city bus network.
- **Janmarg BRTS:** Ahmedabad's bus rapid transit system.
- **Auto-rickshaw / Rapido:** Options for arranging an onward ride.

The intended experience connects last-mile information to the selected destination metro station. The usefulness of the distance, walking-time, waiting-time, and fare estimates depends on the availability of reliable stop-level data.

Missing information should be shown as unavailable instead of being replaced with invented transport details.

### 🛵 Rapido handoff

TransitSync can provide a simple handoff to Rapido's official website.

The distinction matters: opening Rapido is not the same as booking a ride. TransitSync does not claim an official Rapido API integration, automatic booking, live vehicle availability, or verified prefilled ride links.

### 📶 Offline-first access

TransitSync is built as a Progressive Web App (PWA). Its production build includes a web app manifest and service worker, allowing the application shell and configured static assets to be cached.

Once the application has been loaded and the necessary assets have been cached, the core interface can remain accessible during a network interruption.

Offline access is particularly useful when a commuter needs to check locally bundled station data or explore the demo without relying on a live server for every interaction.

Offline does not mean that every external service works without internet access. Rapido's website, live transport feeds, and any future online integrations still require their respective services and connectivity.

---

## How it works

TransitSync uses a client-side application architecture rather than requiring a continuously running application server for its core demo.

At a high level, the flow is:

1. **Select stations:** The user chooses the boarding and destination stations from the available metro data.
2. **Calculate the route:** The application uses its station, line, and interchange relationships to determine a metro journey.
3. **Inspect the journey:** The interface presents the available route information and estimated duration.
4. **Explore disruptions:** The delay simulator demonstrates how an additional delay can affect the journey.
5. **Consider onward travel:** The last-mile section provides the interface for AMTS, BRTS, and ride-handoff options, subject to available data.
6. **Continue with the relevant service:** External services such as Rapido are opened separately when needed.

The important architectural decision is that the core journey-planning experience can operate from bundled application data. It does not need to fetch a new response from a remote backend every time a user interacts with the planner.

### A note on data accuracy

TransitSync is a hackathon prototype, not an official Ahmedabad transport information system.

- Station and route results depend on the bundled dataset.
- Timetable and frequency values used by the demo are approximate and should not be treated as verified departure times.
- Delay simulation is illustrative.
- AMTS/BRTS stop distances, waiting times, and fares should only be displayed when supported by configured data, with simulated values clearly labelled.
- Live vehicle tracking and live service status are not claimed.
- External ride services handle their own availability and booking processes.

These distinctions are deliberate. A transport planner should communicate uncertainty instead of making estimates look like facts.

---

## Offline support: what to expect

| Capability | Expected behavior |
|---|---|
| Open the application | Available online; offline reopening depends on previously cached assets |
| Load the application interface | Can work offline after the required assets have been cached |
| Use bundled station and route data | Can work offline when the relevant data is included in the application build |
| Use the delay simulator | Can work offline if its logic and required data are locally available |
| Fetch live metro, AMTS, or BRTS information | Not provided by the current demo |
| Open the Rapido website | Requires internet access |
| Install as a PWA | Supported by the PWA configuration in compatible browsers |

**First visit:** An initial visit generally requires internet access so the browser can download the application and its assets. Offline behavior should be tested after the first successful load; it should not be assumed merely because the project uses a service worker.

---

## Technology stack

| Technology | Purpose |
|---|---|
| React | Component-based user interface |
| TypeScript | Type-safe application logic and data structures |
| Vite | Development server and production build |
| Tailwind CSS v4 | Styling and responsive layouts |
| Lucide React | Interface icons |
| vite-plugin-pwa | PWA configuration and service-worker integration |
| Vitest | Automated tests for application logic |
| Netlify | Hosting and production deployment |
| Git and GitHub | Version control and source-code hosting |

The current architecture is intentionally lightweight: the core planner runs in the browser, while the station data and demo behavior are supplied by the application itself.

---

## Built for METRO HACKS

**Event:** METRO HACKS by GDG Gandhinagar  
**Track:** Track 2 — City Public Transport  
**Problem statement:** Problem 6 — Multi-Modal Coordination  
**Location focus:** Ahmedabad, Gujarat, India

TransitSync was developed to explore how multiple transport modes can be considered as parts of a single commuter journey.

The project starts with metro routing and a browser-based prototype, with a design that can accommodate better AMTS/BRTS stop data and more reliable transport integrations over time.

The broader goal is to make public transport easier to navigate without making the experience dependent on perfect connectivity.

---

## Run locally

### Prerequisites

- Node.js with npm
- Git

### 1. Clone the repository

```bash
git clone https://github.com/niyatijoshi707/metrohacks-transitsync.git
cd metrohacks-transitsync
```

### 2. Install dependencies

```bash
npm install
```

### 3. Start the development server

=======
# TransitSync — Ahmedabad Integrated Public Transport

**Offline-First Multi-Modal Journey Planner**  
Built for **METRO HACKS by GDG Gandhinagar**  
*Track 2: City Public Transport · Problem 6: Multi-Modal Coordination*

---

## 🚀 Overview

TransitSync coordinates journey planning across the entire public transit ecosystem of Ahmedabad and Gandhinagar:
- **GMRC Metro Rail**: 54 physical stations across 4 corridors (Blue, Red, Yellow, and Violet Phase-2 GIFT City branch).
- **AMTS Feeder Buses**: Official GTFS scheduled departures for routes Metro1–Metro14 and Feeder-8/9.
- **Janmarg BRTS**: Dedicated bus rapid transit stops, physical walking distances, and offline-safe walking directions.
- **Auto-Rickshaw & Rapido Handoff**: Fare estimates (base ₹30 + ₹14/km) with direct deep-link handoff to the Rapido app.
- **100% Offline-First Architecture**: Progressive Web App (PWA) with zero runtime server dependencies. Operates seamlessly in airplane mode or during network outages in underground metro concourses.

---

## ⚖️ What is Real / Estimated / Simulated

Transparency is a core design principle of TransitSync. Every itinerary leg displays an explicit source chip indicating the provenance of its data:

### 1. What is Real
- **Metro Stations & Network Topology**: All 54 physical metro stations, correct line sequences, and physical interchange hubs (Old High Court, Motera Stadium, GNLU).
- **Official GMRC Timetables**: Exact per-train departure and arrival times from the official GMRC timetable (effective 18 May 2026) for major corridor timing points (APMC, Old High Court, Motera Stadium, Koteshwar Road, GNLU, Infocity, Sachivalaya, Mahatma Mandir, and the GNLU–GIFT City branch).
- **AMTS Feeder Bus GTFS Timetables**: Static GTFS scheduled departures and stop sequences for routes Metro1 through Metro14 and Apparel Park Feeder-8/Feeder-9.
- **Transit Hub Coordinates**: Actual GPS coordinates and straight-line distances from metro stations to nearest AMTS and Janmarg BRTS stops.
- **Official Metro Fares**: Matrix fares in INR from GMRC fare charts.
- **External Links**: Direct link to Rapido (`https://www.rapido.bike/`) and Google Maps walking directions (automatically disabled when offline).

### 2. What is Estimated
- **Intermediate Metro Timings**: For metro stations between published GMRC timing points, departure times are linearly interpolated based on station order and labeled with the `Estimated` source chip.
- **Blue Line Departures**: Because GMRC publishes frequency charts rather than individual train tables for the Blue Line, departure times are generated using the published headways (12 min peak, 15 min off-peak) and labeled with the `Approximate` source chip.
- **Walking Times**: Walking duration is calculated as `straightLineDistanceM × 1.3 / (80 m/min)` (accounting for road circuity and standard urban walking speed).
- **Last-Mile Distance & Auto Fares**: Auto-rickshaw fares are calculated using the Ahmedabad municipal formula `₹30 base + ₹14/km` applied to straight-line distance or landmark Haversine coordinates.

### 3. What is Simulated
- **Transport Delays**: The Delay Simulator panel simulates real-world delays (+5, +10, +20 minutes) on Metro, AMTS, or BRTS.
- **Missed Connection Detection**: If a delay reduces a transfer buffer below 3 minutes or increases connection wait past 12 minutes, the engine flags the connection as `"Connection Likely Missed"` and dynamically recommends alternative modes (Janmarg BRTS, feeder bus, or auto-rickshaw).
- **Live Vehicle Tracking**: Real-time vehicle GPS positions are not polled; all coordination logic is executed deterministically offline from static datasets.

---

## 🏆 5-Step Judge Demo Script

Follow these 5 steps to verify all hackathon requirements during judging:

### Step 1: Airplane Mode / Offline Reliability
1. Open the application in your browser (`http://localhost:5173/` or deployed Netlify URL).
2. Open DevTools → **Network** tab → Check **Offline** (or enable Airplane Mode on your device).
3. Notice the header status badge updates instantly to **"Offline Mode (PWA Cached)"**. All routing calculations, station search, and schedules continue to work with 0 network latency.

### Step 2: Station & Landmark Search with Disambiguation
1. In the **Destination** field, type `"Science City"` or `"Vastral"`.
2. Notice the autocomplete surfaces landmarks with a distinctive landmark chip and notes its nearest metro station.
3. If searching an area with multiple landmarks (e.g., `"Vastral"`), notice the disambiguation banner: *"Where near Vastral do you want to go?"* with one-click choices for *RTO East*, *Vastral Lake*, and *Madhav Farm*.

### Step 3: Multi-Modal Itinerary & Source Chips
1. Click the **"Paldi → Vastral Gam"** quick scenario button (or set Boarding: `Paldi`, Destination: `Vastral Gam`) and click **Find Route**.
2. Examine the generated multi-leg itinerary:
   - **Leg 1**: Metro Red Line from Paldi to Old High Court.
   - **Leg 2**: Physical transfer buffer at Old High Court interchange (`~3 min`).
   - **Leg 3**: Metro Blue Line to Vastral Gam with clear navigation guidance (*"Get off at Vastral Gam, 1 stop after Nirant Cross Road"*).
   - Note the transparent source chips: `Scheduled (GMRC timetable w.e.f. 18 May 2026)` and `Approximate`.

### Step 4: Delay Simulator & Multi-Modal Coordination
1. In the **Delay Simulator** panel, click **"+10 min"** or **"+20 min"** on the Metro service.
2. Watch the engine dynamically cascade the delay:
   - The transfer leg turns red with the alert: *"Connection Likely Missed: arrived at 08:32, but train departed at 08:24"*.
   - The animated recommendation banner surfaces the next best multi-modal fallback: *"Better option: Take AMTS Feeder Metro9 departing at 08:45"* or *"Switch to Janmarg BRTS"*.

### Step 5: Last-Mile Connectivity & Online/Offline Behavior
1. Scroll down to the **Last-Mile Feeder & Transit Options** cards:
   - **Janmarg BRTS Card**: Distances `< 500 m` are highlighted in **bold**; distances `≥ 500 m` in normal weight.
   - **AMTS Card**: Displays next scheduled GTFS feeder bus departure and wait time.
   - **Auto-Rickshaw Card**: Displays estimated fare (`₹30 + ₹14/km`) and direct **"Open Rapido"** handoff link.
2. While offline, notice the "Walk to BRTS stop" button disables and reads **"Map needs internet"**, preventing broken navigation pages in airplane mode.

---

## 🛠️ Technology Stack

- **Framework**: React 19 + TypeScript + Vite 8
- **Styling**: Tailwind CSS v4 (Indian government portal aesthetic: Navy `#0B2545`, Saffron `#FF9933`, White background)
- **Offline & PWA**: `vite-plugin-pwa` with Workbox Service Worker caching
- **Icons**: `lucide-react`
- **Testing**: Vitest with jsdom (116 passing unit and integration tests)
- **Linting**: Oxlint

---

## 💻 Local Development & Testing

### 1. Install dependencies
```bash
npm install
```

### 2. Run local development server
>>>>>>> 705bd65 (feat: complete multimodal TransitSync journey planner)
```bash
npm run dev
```

<<<<<<< HEAD
Open the local URL printed in the terminal, usually `http://localhost:5173/`.

### 4. Run the tests

=======
### 3. Run unit and integration tests (116 tests)
>>>>>>> 705bd65 (feat: complete multimodal TransitSync journey planner)
```bash
npm run test
```

<<<<<<< HEAD
### 5. Create a production build

=======
### 4. Build production PWA bundle
>>>>>>> 705bd65 (feat: complete multimodal TransitSync journey planner)
```bash
npm run build
```

<<<<<<< HEAD
The production output is generated in the `dist/` directory.

To check the production build locally, use:

```bash
npm run preview
```

PWA caching and offline behavior should be tested against a production build or deployed HTTPS site, rather than inferred solely from the development server.

---

## Project status and limitations

TransitSync is an evolving prototype. The existing planner, station data, route calculation, delay simulation, and PWA setup form its foundation.

Some capabilities depend on further implementation and data verification:

- Complete, searchable station selection across all four lines.
- Consistent station identity and validation for shared interchanges.
- Destination-aware last-mile options.
- Verified AMTS and BRTS stop locations and distances.
- Reliable estimates for walking time, waiting time, and fares.
- Any future live transport integrations.

These are areas for continued development, not reasons to treat simulated data as live information.

Contributions should preserve the existing architecture, avoid duplicating station identities, and keep verified data separate from demo estimates.

---

## Contributing

Contributions that improve routing correctness, offline reliability, accessibility, test coverage, and transport-data quality are especially valuable.

A good contribution should:

1. Preserve existing functionality.
2. Use the existing station dataset where appropriate.
3. Avoid fabricating transport information.
4. Include tests for changes to routing or data behavior.
5. Keep offline capabilities and limitations explicit.

---

## License

Add the project's chosen license before distributing or reusing the code. Until a license is confirmed in the repository, do not assume that the project is open source under a particular license.

---

**TransitSync — because the journey doesn't end at the metro station.**
=======
### 5. Preview production build locally
```bash
npm run preview
```
>>>>>>> 705bd65 (feat: complete multimodal TransitSync journey planner)
