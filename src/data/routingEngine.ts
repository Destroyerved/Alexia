/**
 * TransitSync — Shortest-Path Routing Engine
 *
 * Uses Dijkstra's algorithm on a graph of:
 *  - Segment edges (adjacent stops on the same line, cost = 1 stop)
 *  - Transfer edges (interchange between lines at a shared station, cost = 0 stops + 1 transfer)
 *  - Simulated edges (demo-only connections, clearly labelled)
 *
 * All results are deterministic given fixed input data.
 * The engine does NOT access the network at runtime.
 */

import {
  PHYSICAL_STATIONS,
  METRO_LINES,
  LINE_BY_ID,
  STATION_BY_ID,
  type LineId,
  type MetroLine,
  type Station,
} from './stationData';

// ── Graph node key ──────────────────────────────────────────────────────────
// A node in the routing graph is (stationId, lineId) — i.e. which platform.
// This lets us model being "on" a specific line at an interchange station.
type NodeKey = `${string}::${LineId}`;

function makeKey(stationId: string, lineId: LineId): NodeKey {
  return `${stationId}::${lineId}`;
}

// ── Edge types ───────────────────────────────────────────────────────────────
type EdgeKind = 'segment' | 'transfer' | 'simulated';

interface Edge {
  to: NodeKey;
  toStationId: string;
  toLineId: LineId;
  kind: EdgeKind;
  /** Weight: 1 for segment, 0 for real transfer, 0 for simulated transfer */
  weight: number;
  /** For simulated edges — shown as a warning in results */
  simulatedWarning?: string;
}

// ── Adjacency list ────────────────────────────────────────────────────────────
type Graph = Map<NodeKey, Edge[]>;

/**
 * Build the routing graph from METRO_LINES and PHYSICAL_STATIONS.
 *
 * Segment edges:   consecutive stops within a line (bidirectional).
 * Transfer edges:  any shared physical station across lines (bidirectional).
 * Simulated edges: explicitly configured demo scenarios.
 */
function buildGraph(): Graph {
  const graph: Graph = new Map();

  const ensureNode = (key: NodeKey) => {
    if (!graph.has(key)) graph.set(key, []);
  };

  const addEdge = (from: NodeKey, edge: Edge) => {
    ensureNode(from);
    graph.get(from)!.push(edge);
  };

  // 1. Segment edges (within each line, bidirectional)
  for (const line of METRO_LINES) {
    for (let i = 0; i < line.stops.length - 1; i++) {
      const aId = line.stops[i];
      const bId = line.stops[i + 1];
      const aKey = makeKey(aId, line.id);
      const bKey = makeKey(bId, line.id);
      ensureNode(aKey);
      ensureNode(bKey);
      addEdge(aKey, { to: bKey, toStationId: bId, toLineId: line.id, kind: 'segment', weight: 1 });
      addEdge(bKey, { to: aKey, toStationId: aId, toLineId: line.id, kind: 'segment', weight: 1 });
    }
  }

  // 2. Transfer edges at shared interchange stations (bidirectional)
  for (const station of PHYSICAL_STATIONS) {
    if (station.lineIds.length > 1) {
      // Add a zero-weight transfer edge between every pair of lines at this station
      for (let i = 0; i < station.lineIds.length; i++) {
        for (let j = 0; j < station.lineIds.length; j++) {
          if (i === j) continue;
          const fromKey = makeKey(station.id, station.lineIds[i]);
          const toKey   = makeKey(station.id, station.lineIds[j]);
          ensureNode(fromKey);
          addEdge(fromKey, {
            to: toKey,
            toStationId: station.id,
            toLineId: station.lineIds[j],
            kind: 'transfer',
            weight: 0,
          });
        }
      }
    }
  }

  // 3. Simulated interchange at Koteshwar Road (demo only, explicitly labelled)
  // Koteshwar Road is on Yellow Line only. The spec requires a simulated
  // transfer edge. We model it as a self-loop transfer on Yellow (same platform)
  // with a warning label, representing a future or hypothetical connecting service.
  // No fabricated station or line is introduced.
  const koteshwarId = 'koteshwar-road';
  const koteshwarKey = makeKey(koteshwarId, 'yellow');
  ensureNode(koteshwarKey);
  addEdge(koteshwarKey, {
    to: koteshwarKey,
    toStationId: koteshwarId,
    toLineId: 'yellow',
    kind: 'simulated',
    weight: 0,
    simulatedWarning:
      'SIMULATED INTERCHANGE — Koteshwar Road: No official connecting metro line ' +
      'has been announced or verified. This transfer is a demo scenario only.',
  });

  return graph;
}

const ROUTING_GRAPH: Graph = buildGraph();

// ── Route result types ────────────────────────────────────────────────────────

export interface RouteLeg {
  line: MetroLine;
  /** Station IDs in order for this leg (includes board and alight station) */
  stationIds: string[];
  /** Direction label for this leg */
  direction: string;
  /** Number of stops ridden (not counting board station) */
  stopCount: number;
  isSimulated?: boolean;
  simulatedWarning?: string;
}

export interface Transfer {
  atStation: Station;
  fromLine: MetroLine;
  toLine: MetroLine;
  isSimulated?: boolean;
  simulatedWarning?: string;
}

export type RouteResult =
  | {
      found: true;
      legs: RouteLeg[];
      transfers: Transfer[];
      transferCount: number;
      totalStops: number;
      boardStationId: string;
      alightStationId: string;
      warnings: string[];
    }
  | {
      found: false;
      reason: string;
    };

// ── Dijkstra ──────────────────────────────────────────────────────────────────

/**
 * findRoute — returns the shortest route (fewest stops, then fewest transfers)
 * between two station IDs.
 *
 * Handles:
 * - Same station (trivial)
 * - Unknown station IDs
 * - Stations on the same line (direct route)
 * - Multi-interchange routes
 * - Unreachable destinations
 */
export function findRoute(fromId: string, toId: string): RouteResult {
  // Validate inputs
  if (!fromId || !toId) {
    return { found: false, reason: 'Boarding or destination station not specified.' };
  }

  const fromStation = STATION_BY_ID[fromId];
  const toStation   = STATION_BY_ID[toId];

  if (!fromStation) {
    return { found: false, reason: `Unknown boarding station: "${fromId}".` };
  }
  if (!toStation) {
    return { found: false, reason: `Unknown destination station: "${toId}".` };
  }

  // Trivial: same station
  if (fromId === toId) {
    return {
      found: true,
      legs: [],
      transfers: [],
      transferCount: 0,
      totalStops: 0,
      boardStationId: fromId,
      alightStationId: toId,
      warnings: ['Boarding and destination are the same station.'],
    };
  }

  // ── Dijkstra (cost = stops; secondary: transfers) ─────────────────────────
  const dist = new Map<NodeKey, { cost: number; transfers: number }>();
  const prev = new Map<NodeKey, { key: NodeKey; edge: Edge } | null>();

  // Priority queue (simple sorted array — graph is small enough)
  type PQItem = { key: NodeKey; cost: number; transfers: number };
  const pq: PQItem[] = [];

  const push = (item: PQItem) => {
    pq.push(item);
    pq.sort((a, b) => a.cost !== b.cost ? a.cost - b.cost : a.transfers - b.transfers);
  };

  // Initialise: start from all platforms of the boarding station
  for (const lineId of fromStation.lineIds) {
    const startKey = makeKey(fromId, lineId);
    dist.set(startKey, { cost: 0, transfers: 0 });
    prev.set(startKey, null);
    push({ key: startKey, cost: 0, transfers: 0 });
  }

  // Collect all goal keys (any platform at destination station)
  const goalKeys = new Set(toStation.lineIds.map((l) => makeKey(toId, l)));

  while (pq.length > 0) {
    const curr = pq.shift()!;

    const bestDist = dist.get(curr.key);
    if (bestDist && (curr.cost > bestDist.cost || (curr.cost === bestDist.cost && curr.transfers > bestDist.transfers))) {
      continue; // stale
    }

    if (goalKeys.has(curr.key)) break; // found optimal path to destination

    const edges = ROUTING_GRAPH.get(curr.key) ?? [];
    for (const edge of edges) {
      // Skip self-loop simulated edges during pathfinding
      if (edge.to === curr.key) continue;

      const newCost      = curr.cost + edge.weight;
      const newTransfers = curr.transfers + (edge.kind === 'transfer' ? 1 : 0);

      const existing = dist.get(edge.to);
      if (!existing || newCost < existing.cost || (newCost === existing.cost && newTransfers < existing.transfers)) {
        dist.set(edge.to, { cost: newCost, transfers: newTransfers });
        prev.set(edge.to, { key: curr.key, edge });
        push({ key: edge.to, cost: newCost, transfers: newTransfers });
      }
    }
  }

  // Find the best goal key reached
  let bestGoal: NodeKey | null = null;
  for (const gk of goalKeys) {
    if (dist.has(gk)) {
      if (!bestGoal) {
        bestGoal = gk;
      } else {
        const best = dist.get(bestGoal)!;
        const cand = dist.get(gk)!;
        if (cand.cost < best.cost || (cand.cost === best.cost && cand.transfers < best.transfers)) {
          bestGoal = gk;
        }
      }
    }
  }

  if (!bestGoal) {
    return {
      found: false,
      reason: `No route found between "${fromStation.name}" and "${toStation.name}". The stations may be on disconnected parts of the network.`,
    };
  }

  // ── Reconstruct path ───────────────────────────────────────────────────────
  const path: Array<{ key: NodeKey; edge: Edge | null }> = [];
  let cur: NodeKey | null = bestGoal;
  while (cur !== null) {
    const p = prev.get(cur);
    path.unshift({ key: cur, edge: p?.edge ?? null });
    cur = p?.key ?? null;
  }

  // ── Build legs and transfers ───────────────────────────────────────────────
  const legs: RouteLeg[] = [];
  const transfers: Transfer[] = [];
  const warnings: string[] = [];

  // Check for simulated interchange at koteshwar-road
  const hasSimulatedEdge = path.some((p) => {
    const edges = ROUTING_GRAPH.get(p.key) ?? [];
    return edges.some((e) => e.kind === 'simulated' && e.to !== p.key);
  });
  if (hasSimulatedEdge) {
    warnings.push(
      'SIMULATED INTERCHANGE — Koteshwar Road: No official connecting metro line has been announced or verified. This is a demo scenario only.',
    );
  }

  // Group path nodes into line-continuous legs
  // A new leg starts whenever the lineId changes (= a transfer happened)
  let currentLegStations: string[] = [];
  let currentLineId: LineId | null = null;

  for (let i = 0; i < path.length; i++) {
    const { key, edge } = path[i];
    const [stationId, lineId] = key.split('::') as [string, LineId];

    if (currentLineId === null) {
      // First node
      currentLineId = lineId;
      currentLegStations = [stationId];
    } else if (lineId === currentLineId) {
      if (edge?.kind === 'segment') {
        // Continuing on same line
        currentLegStations.push(stationId);
      }
      // If same line but not a segment edge, it's a same-line transfer (simulated) — ignore
    } else {
      // Line changed — close previous leg and open new one
      const prevLine = LINE_BY_ID[currentLineId];
      // Direction: compare positions in the line
      const prevLineStops = prevLine.stops;
      const boardIdx  = prevLineStops.indexOf(currentLegStations[0]);
      const alightIdx = prevLineStops.indexOf(currentLegStations[currentLegStations.length - 1]);
      const direction =
        boardIdx <= alightIdx
          ? prevLine.direction
          : prevLine.direction.split(' → ').reverse().join(' → ');

      legs.push({
        line: prevLine,
        stationIds: [...currentLegStations],
        direction,
        stopCount: currentLegStations.length - 1,
      });

      // Record transfer
      const transferStationId = currentLegStations[currentLegStations.length - 1];
      const transferStation   = STATION_BY_ID[transferStationId];
      const isSimulatedTransfer = edge?.kind === 'simulated';
      const transfer: Transfer = {
        atStation: transferStation,
        fromLine: prevLine,
        toLine: LINE_BY_ID[lineId],
        isSimulated: isSimulatedTransfer,
        simulatedWarning: edge?.simulatedWarning,
      };
      transfers.push(transfer);

      if (isSimulatedTransfer && edge?.simulatedWarning) {
        warnings.push(edge.simulatedWarning);
      }

      // Start new leg at this same station
      currentLineId = lineId;
      currentLegStations = [stationId];
    }
  }

  // Close the last leg
  if (currentLineId !== null && currentLegStations.length > 0) {
    const lastLine = LINE_BY_ID[currentLineId];
    const lastLineStops = lastLine.stops;
    const boardIdx  = lastLineStops.indexOf(currentLegStations[0]);
    const alightIdx = lastLineStops.indexOf(currentLegStations[currentLegStations.length - 1]);
    const direction =
      boardIdx <= alightIdx
        ? lastLine.direction
        : lastLine.direction.split(' → ').reverse().join(' → ');

    legs.push({
      line: lastLine,
      stationIds: [...currentLegStations],
      direction,
      stopCount: currentLegStations.length - 1,
    });
  }

  // Total stops = sum of leg stop counts (transfers are not counted as extra stops)
  const totalStops = legs.reduce((sum, leg) => sum + leg.stopCount, 0);

  return {
    found: true,
    legs,
    transfers,
    transferCount: transfers.length,
    totalStops,
    boardStationId: fromId,
    alightStationId: toId,
    warnings,
  };
}
