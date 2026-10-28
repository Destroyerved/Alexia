/**
 * 2. metroPath(origin, dest)
 * Shortest path with interchanges across the 54 Ahmedabad metro stations.
 * Returns stops, direction, stop count, and per-leg interchange details.
 */

import { LINES, STATION_BY_NAME, STATION_BY_ID } from './data';
import type { MetroPathResult } from './types';

// Node is (stationId, lineId)
interface Edge {
  toStationId: string;
  toLineId: string;
  weight: number; // 1 for same-line segment, 0 for interchange
  isInterchange: boolean;
}

export function metroPath(originInput: string, destInput: string): MetroPathResult {
  const normOrigin = originInput.trim().toLowerCase();
  const normDest = destInput.trim().toLowerCase();

  const startStation = STATION_BY_NAME.get(normOrigin) || STATION_BY_ID.get(normOrigin);
  const endStation = STATION_BY_NAME.get(normDest) || STATION_BY_ID.get(normDest);

  if (!startStation || !endStation) {
    throw new Error(`Station not found: ${!startStation ? originInput : destInput}`);
  }

  if (startStation.id === endStation.id) {
    return {
      origin: startStation.name,
      dest: endStation.name,
      stops: [startStation.name],
      direction: 'Same Station',
      stopCount: 0,
      interchanges: [],
      legs: [],
    };
  }

  // Build Dijkstra graph on (stationId, lineId)
  const graph = new Map<string, Edge[]>();
  const makeKey = (sId: string, lId: string) => `${sId}::${lId}`;

  // Add line segment edges
  for (const line of LINES) {
    for (let i = 0; i < line.stops.length; i++) {
      const u = line.stops[i];
      const uKey = makeKey(u, line.id);
      if (!graph.has(uKey)) graph.set(uKey, []);

      if (i > 0) {
        const v = line.stops[i - 1];
        graph.get(uKey)!.push({
          toStationId: v,
          toLineId: line.id,
          weight: 1,
          isInterchange: false,
        });
      }
      if (i < line.stops.length - 1) {
        const v = line.stops[i + 1];
        graph.get(uKey)!.push({
          toStationId: v,
          toLineId: line.id,
          weight: 1,
          isInterchange: false,
        });
      }
    }
  }

  // Add transfer edges at shared stations:
  // Old High Court (blue <-> red)
  // Motera Stadium (red <-> yellow)
  // GNLU (yellow <-> violet)
  const sharedStations = ['old-high-court', 'motera-stadium', 'gnlu'];
  for (const sId of sharedStations) {
    const st = STATION_BY_ID.get(sId);
    if (!st || st.lineIds.length < 2) continue;
    for (const l1 of st.lineIds) {
      for (const l2 of st.lineIds) {
        if (l1 !== l2) {
          const k1 = makeKey(sId, l1);
          if (!graph.has(k1)) graph.set(k1, []);
          graph.get(k1)!.push({
            toStationId: sId,
            toLineId: l2,
            weight: 0, // transfer cost
            isInterchange: true,
          });
        }
      }
    }
  }

  // Dijkstra from all possible starting lines of startStation
  const distMap = new Map<string, number>();
  const transferMap = new Map<string, number>();
  const prevMap = new Map<string, { stationId: string; lineId: string } | null>();

  // Queue of states
  const queue: { node: string; dist: number; transfers: number }[] = [];

  for (const lineId of startStation.lineIds) {
    const k = makeKey(startStation.id, lineId);
    distMap.set(k, 0);
    transferMap.set(k, 0);
    prevMap.set(k, null);
    queue.push({ node: k, dist: 0, transfers: 0 });
  }

  while (queue.length > 0) {
    // Pick node with lowest distance (then lowest transfers)
    queue.sort((a, b) => {
      if (a.dist !== b.dist) return a.dist - b.dist;
      return a.transfers - b.transfers;
    });
    const current = queue.shift()!;
    const [currStationId, currLineId] = current.node.split('::');

    if (currStationId === endStation.id) {
      // Reached destination! Since queue order is optimal, this is a shortest path.
      break;
    }

    const edges = graph.get(current.node) || [];
    for (const edge of edges) {
      const neighborKey = makeKey(edge.toStationId, edge.toLineId);
      const newDist = current.dist + edge.weight;
      const newTransfers = current.transfers + (edge.isInterchange ? 1 : 0);

      const oldDist = distMap.has(neighborKey) ? distMap.get(neighborKey)! : Infinity;
      const oldTransfers = transferMap.has(neighborKey) ? transferMap.get(neighborKey)! : Infinity;

      if (newDist < oldDist || (newDist === oldDist && newTransfers < oldTransfers)) {
        distMap.set(neighborKey, newDist);
        transferMap.set(neighborKey, newTransfers);
        prevMap.set(neighborKey, { stationId: currStationId, lineId: currLineId });
        queue.push({ node: neighborKey, dist: newDist, transfers: newTransfers });
      }
    }
  }

  // Find best destination node
  let bestDestKey: string | null = null;
  let bestDist = Infinity;
  let bestTransfers = Infinity;

  for (const lineId of endStation.lineIds) {
    const k = makeKey(endStation.id, lineId);
    if (distMap.has(k)) {
      const d = distMap.get(k)!;
      const t = transferMap.get(k)!;
      if (d < bestDist || (d === bestDist && t < bestTransfers)) {
        bestDist = d;
        bestTransfers = t;
        bestDestKey = k;
      }
    }
  }

  if (!bestDestKey) {
    throw new Error(`No route found between ${startStation.name} and ${endStation.name}`);
  }

  // Backtrack path
  const pathNodes: { stationId: string; lineId: string }[] = [];
  let curr: { stationId: string; lineId: string } | null = {
    stationId: bestDestKey.split('::')[0],
    lineId: bestDestKey.split('::')[1],
  };

  while (curr) {
    pathNodes.unshift(curr);
    const k = makeKey(curr.stationId, curr.lineId);
    curr = prevMap.get(k) || null;
  }

  // Group into legs
  const legs: MetroPathResult['legs'] = [];
  const interchanges: MetroPathResult['interchanges'] = [];
  const allStopsNames: string[] = [];

  let currentLegStops: string[] = [pathNodes[0].stationId];
  let currentLegLine = pathNodes[0].lineId;

  for (let i = 1; i < pathNodes.length; i++) {
    const prevNode = pathNodes[i - 1];
    const node = pathNodes[i];

    if (node.lineId !== prevNode.lineId && node.stationId === prevNode.stationId) {
      // Interchange at this station!
      const transferStationObj = STATION_BY_ID.get(node.stationId)!;
      const fromLineObj = LINES.find((l) => l.id === prevNode.lineId)!;
      const toLineObj = LINES.find((l) => l.id === node.lineId)!;

      // Finish previous leg
      const boardingStation = STATION_BY_ID.get(currentLegStops[0])!.name;
      const alightingStation = STATION_BY_ID.get(currentLegStops[currentLegStops.length - 1])!.name;
      const lineDef = LINES.find((l) => l.id === currentLegLine)!;

      // Determine leg direction
      const firstIdx = lineDef.stops.indexOf(currentLegStops[0]);
      const lastIdx = lineDef.stops.indexOf(currentLegStops[currentLegStops.length - 1]);
      const legDirection =
        lastIdx >= firstIdx
          ? STATION_BY_ID.get(lineDef.stops[lineDef.stops.length - 1])!.name
          : STATION_BY_ID.get(lineDef.stops[0])!.name;

      legs.push({
        lineId: currentLegLine,
        lineName: lineDef.name,
        direction: legDirection,
        boarding: boardingStation,
        alighting: alightingStation,
        stops: currentLegStops.map((id) => STATION_BY_ID.get(id)!.name),
      });

      interchanges.push({
        station: transferStationObj.name,
        fromLine: fromLineObj.shortName + ' Line',
        toLine: toLineObj.shortName + ' Line',
      });

      // Start new leg
      currentLegLine = node.lineId;
      currentLegStops = [node.stationId];
    } else {
      currentLegStops.push(node.stationId);
    }
  }

  // Push final leg
  if (currentLegStops.length > 0) {
    const boardingStation = STATION_BY_ID.get(currentLegStops[0])!.name;
    const alightingStation = STATION_BY_ID.get(currentLegStops[currentLegStops.length - 1])!.name;
    const lineDef = LINES.find((l) => l.id === currentLegLine)!;
    const firstIdx = lineDef.stops.indexOf(currentLegStops[0]);
    const lastIdx = lineDef.stops.indexOf(currentLegStops[currentLegStops.length - 1]);
    const legDirection =
      lastIdx >= firstIdx
        ? STATION_BY_ID.get(lineDef.stops[lineDef.stops.length - 1])!.name
        : STATION_BY_ID.get(lineDef.stops[0])!.name;

    legs.push({
      lineId: currentLegLine,
      lineName: lineDef.name,
      direction: legDirection,
      boarding: boardingStation,
      alighting: alightingStation,
      stops: currentLegStops.map((id) => STATION_BY_ID.get(id)!.name),
    });
  }

  // Build unique flat stop list in order
  for (const leg of legs) {
    for (let i = 0; i < leg.stops.length; i++) {
      if (allStopsNames.length === 0 || allStopsNames[allStopsNames.length - 1] !== leg.stops[i]) {
        allStopsNames.push(leg.stops[i]);
      }
    }
  }

  // Overall direction summary
  const overallDirection = legs.map((l) => l.direction).join(' → ');

  return {
    origin: startStation.name,
    dest: endStation.name,
    stops: allStopsNames,
    direction: overallDirection,
    stopCount: allStopsNames.length - 1, // stops travelled
    interchanges,
    legs,
  };
}
