"""Event bus and state persistence engine.

Implements FR-C1 and FR-C2:
- Async in-process pub/sub event bus with queue buffering.
- Persistent event log and incident lifecycle management in SQLite.
- SSE listener hooks for live streaming to the dashboard and mobile companion.
"""

from __future__ import annotations
import asyncio
import json
import logging
import os
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine, Dict, List, Optional, Set
from alexia.core.schemas import Event, Incident, generate_id
from alexia.core.paths import resolve_db_path

logger = logging.getLogger("alexia.bus")


class EventBus:
    """Async event bus managing event publishing, subscriber dispatch, and persistence."""

    def __init__(self, db_path: str = "data/alexia.db"):
        # source_db_path is what singletons compare against; db_path may fall back to *.sqlite
        self.db_path = self.source_db_path = resolve_db_path(db_path)
        os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
        self._queue: asyncio.Queue[Event] = asyncio.Queue()
        self._subscribers: Dict[str, List[Callable[[Event], Coroutine[Any, Any, None]]]] = {}
        self._sse_listeners: Set[asyncio.Queue[Dict[str, Any]]] = set()
        self._db_lock = threading.Lock()
        self._running = False
        self._worker_task: Optional[asyncio.Task] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._in_flight = 0  # published events whose subscribers have not finished yet
        self._dispatch_tasks: Set[asyncio.Task] = set()  # keeps running handler tasks referenced
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        try:
            conn = sqlite3.connect(self.db_path, timeout=10)
        except sqlite3.OperationalError:
            self.db_path = f"{self.db_path}.sqlite"
            conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._db_lock, self._get_connection() as conn:
            # Events table
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS events (
                    id TEXT PRIMARY KEY,
                    ts TEXT NOT NULL,
                    source TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    service TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    data_json TEXT NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_events_kind ON events (kind)")

            # Incidents table
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS incidents (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    category TEXT NOT NULL,
                    owner_agent TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    title TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    diagnosis_json TEXT NOT NULL,
                    plan_json TEXT NOT NULL,
                    snapshots_json TEXT NOT NULL,
                    events_json TEXT NOT NULL,
                    model_calls_json TEXT NOT NULL,
                    cost_usd REAL NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    resolved_at TEXT,
                    metadata_json TEXT NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents (status)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_incidents_updated ON incidents (updated_at)")

            # Incident Transitions History (Audit & Debug)
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS incident_transitions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    incident_id TEXT NOT NULL,
                    from_status TEXT,
                    to_status TEXT NOT NULL,
                    reason TEXT,
                    timestamp TEXT NOT NULL
                )
                """
            )
            conn.commit()

    # -----------------------------------------------------------------------
    # Subscription & Lifecycle
    # -----------------------------------------------------------------------
    def subscribe(self, pattern: str, callback: Callable[[Event], Coroutine[Any, Any, None]]) -> None:
        """Register an async callback for event kind or wildcard ('*')."""
        if pattern not in self._subscribers:
            self._subscribers[pattern] = []
        self._subscribers[pattern].append(callback)

    def register_sse_listener(self) -> asyncio.Queue[Dict[str, Any]]:
        """Register an SSE consumer queue."""
        q: asyncio.Queue[Dict[str, Any]] = asyncio.Queue(maxsize=100)
        self._sse_listeners.add(q)
        return q

    def unregister_sse_listener(self, q: asyncio.Queue[Dict[str, Any]]) -> None:
        """Unregister an SSE consumer queue."""
        self._sse_listeners.discard(q)

    async def start(self) -> None:
        """Start the async event processing loop (rebinding if a previous event loop has gone away)."""
        loop = asyncio.get_running_loop()
        if self._running and self._loop is loop:
            return
        # The singleton can outlive the loop it first ran on (an in-process app restart, or test runs);
        # asyncio queues and tasks are tied to one loop, so start fresh on the current one.
        self._running = True
        self._loop = loop
        self._queue = asyncio.Queue()
        self._in_flight = 0
        self._worker_task = loop.create_task(self._process_queue())
        logger.info("Alexia EventBus started.")

    async def stop(self) -> None:
        """Stop the event processing loop."""
        self._running = False
        task, self._worker_task = self._worker_task, None
        # Only a task on this loop can be awaited; one from a closed loop is already dead
        if task and task.get_loop() is asyncio.get_running_loop():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        logger.info("Alexia EventBus stopped.")

    # -----------------------------------------------------------------------
    # Publishing & Processing
    # -----------------------------------------------------------------------
    async def publish(self, event: Event) -> None:
        """Publish an event to the bus and persist it immediately."""
        self._persist_event(event)
        self._in_flight += 1
        await self._queue.put(event)

        # Broadcast immediately to SSE listeners for live timeline updates
        sse_payload = {
            "type": "event",
            "data": event.model_dump(),
        }
        self.broadcast_sse(sse_payload)

    def _persist_event(self, event: Event) -> None:
        with self._db_lock, self._get_connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO events (id, ts, source, kind, service, severity, data_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event.id,
                    event.ts,
                    event.source,
                    event.kind,
                    event.service,
                    event.severity,
                    json.dumps(event.data),
                ),
            )
            conn.commit()

    async def _process_queue(self) -> None:
        while self._running:
            try:
                event = await self._queue.get()
                callbacks: List[Callable[[Event], Coroutine[Any, Any, None]]] = []

                # Exact kind match
                if event.kind in self._subscribers:
                    callbacks.extend(self._subscribers[event.kind])
                # Source match (e.g., "collector.docker")
                if event.source in self._subscribers:
                    callbacks.extend(self._subscribers[event.source])
                # Universal wildcard match
                if "*" in self._subscribers:
                    callbacks.extend(self._subscribers["*"])

                # Handle each event in its own task: a long agent loop (Builder iterating on a fix) must not
                # delay detection of the next event (NFR1). drain() still waits for every handler to finish.
                task = asyncio.create_task(self._dispatch(event, callbacks))
                self._dispatch_tasks.add(task)
                task.add_done_callback(self._dispatch_tasks.discard)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in EventBus queue processor: {e}", exc_info=True)

    async def _dispatch(self, event: Event, callbacks: List[Callable[[Event], Coroutine[Any, Any, None]]]) -> None:
        try:
            if callbacks:
                results = await asyncio.gather(*(cb(event) for cb in callbacks), return_exceptions=True)
                for result in results:
                    if isinstance(result, Exception):
                        logger.error(f"Handler failed for event {event.id} ({event.kind}): {result!r}", exc_info=result)
        finally:
            self._in_flight -= 1
            self._queue.task_done()

    def is_busy(self) -> bool:
        """True while any published event is still being handled (e.g. an agent loop is running)."""
        return self._in_flight > 0

    async def drain(self) -> None:
        """Wait until every published event has been fully handled by its subscribers."""
        await self._queue.join()

    def broadcast_sse(self, message: Dict[str, Any]) -> None:
        """Non-blocking broadcast to all live SSE queues; safe to call from agent worker threads."""
        loop = self._loop
        if loop is not None and loop.is_running():
            try:
                current = asyncio.get_running_loop()
            except RuntimeError:
                current = None
            if current is not loop:
                # SSE queues belong to the server loop; asyncio queues are not thread-safe
                loop.call_soon_threadsafe(self._broadcast_now, message)
                return
        self._broadcast_now(message)

    def _broadcast_now(self, message: Dict[str, Any]) -> None:
        dead_listeners = []
        for q in list(self._sse_listeners):
            try:
                q.put_nowait(message)
            except asyncio.QueueFull:
                dead_listeners.append(q)
            except Exception:
                dead_listeners.append(q)

        for dl in dead_listeners:
            self._sse_listeners.discard(dl)

    # -----------------------------------------------------------------------
    # Incident State Management (FR-C2)
    # -----------------------------------------------------------------------
    def create_incident(self, incident: Incident) -> Incident:
        """Create and persist a new incident."""
        now = datetime.now(timezone.utc).isoformat()
        incident.created_at = now
        incident.updated_at = now
        incident.sync_frontend_fields()

        with self._db_lock, self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO incidents (
                    id, status, category, owner_agent, severity, title, summary,
                    diagnosis_json, plan_json, snapshots_json, events_json,
                    model_calls_json, cost_usd, created_at, updated_at, resolved_at, metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    incident.id,
                    incident.status,
                    incident.category,
                    incident.owner_agent,
                    incident.severity,
                    incident.title,
                    incident.summary,
                    json.dumps(incident.diagnosis.model_dump()),
                    json.dumps([a.model_dump() for a in incident.plan]),
                    json.dumps(incident.snapshots),
                    json.dumps(incident.events),
                    json.dumps(incident.model_calls),
                    incident.cost_usd,
                    incident.created_at,
                    incident.updated_at,
                    incident.resolved_at,
                    json.dumps(incident.metadata),
                ),
            )
            conn.execute(
                """
                INSERT INTO incident_transitions (incident_id, from_status, to_status, reason, timestamp)
                VALUES (?, ?, ?, ?, ?)
                """,
                (incident.id, None, incident.status, "Incident created", now),
            )
            conn.commit()

        self.broadcast_sse({"type": "incident_created", "data": incident.model_dump()})
        return incident

    def update_incident(self, incident: Incident, reason: str = "") -> Incident:
        """Update an existing incident and record state transitions."""
        now = datetime.now(timezone.utc).isoformat()
        incident.updated_at = now
        if incident.status == "resolved" and not incident.resolved_at:
            incident.resolved_at = now
        incident.sync_frontend_fields()

        with self._db_lock, self._get_connection() as conn:
            # Check previous status for transition tracking
            cur = conn.cursor()
            cur.execute("SELECT status FROM incidents WHERE id = ?", (incident.id,))
            row = cur.fetchone()
            from_status = row["status"] if row else None

            conn.execute(
                """
                UPDATE incidents SET
                    status = ?, category = ?, owner_agent = ?, severity = ?,
                    title = ?, summary = ?, diagnosis_json = ?, plan_json = ?,
                    snapshots_json = ?, events_json = ?, model_calls_json = ?,
                    cost_usd = ?, updated_at = ?, resolved_at = ?, metadata_json = ?
                WHERE id = ?
                """,
                (
                    incident.status,
                    incident.category,
                    incident.owner_agent,
                    incident.severity,
                    incident.title,
                    incident.summary,
                    json.dumps(incident.diagnosis.model_dump()),
                    json.dumps([a.model_dump() for a in incident.plan]),
                    json.dumps(incident.snapshots),
                    json.dumps(incident.events),
                    json.dumps(incident.model_calls),
                    incident.cost_usd,
                    incident.updated_at,
                    incident.resolved_at,
                    json.dumps(incident.metadata),
                    incident.id,
                ),
            )

            if from_status != incident.status:
                conn.execute(
                    """
                    INSERT INTO incident_transitions (incident_id, from_status, to_status, reason, timestamp)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (incident.id, from_status, incident.status, reason or "State update", now),
                )

            conn.commit()

        self.broadcast_sse({"type": "incident_updated", "data": incident.model_dump()})
        return incident

    def get_incident(self, incident_id: str) -> Optional[Incident]:
        """Fetch a single incident by ID."""
        with self._get_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT * FROM incidents WHERE id = ?", (incident_id,))
            row = cur.fetchone()
            if not row:
                return None
            return self._row_to_incident(row)

    def list_incidents(
        self,
        status: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[Incident]:
        """List incidents with optional filtering."""
        with self._get_connection() as conn:
            cur = conn.cursor()
            if status:
                cur.execute(
                    "SELECT * FROM incidents WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
                    (status, limit, offset),
                )
            else:
                cur.execute(
                    "SELECT * FROM incidents ORDER BY updated_at DESC LIMIT ? OFFSET ?",
                    (limit, offset),
                )
            rows = cur.fetchall()
            return [self._row_to_incident(r) for r in rows]

    def _row_to_incident(self, row: sqlite3.Row) -> Incident:
        """Convert a database row into an Incident Pydantic model."""
        diag_data = json.loads(row["diagnosis_json"])
        plan_data = json.loads(row["plan_json"])

        from alexia.core.schemas import Action, Diagnosis

        return Incident(
            id=row["id"],
            status=row["status"],
            category=row["category"],
            owner_agent=row["owner_agent"],
            severity=row["severity"],
            title=row["title"],
            summary=row["summary"],
            diagnosis=Diagnosis(**diag_data),
            plan=[Action(**a) for a in plan_data],
            snapshots=json.loads(row["snapshots_json"]),
            events=json.loads(row["events_json"]),
            model_calls=json.loads(row["model_calls_json"]),
            cost_usd=row["cost_usd"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            resolved_at=row["resolved_at"],
            metadata=json.loads(row["metadata_json"]),
        )


# Global singleton
_global_bus: Optional[EventBus] = None


def get_event_bus(db_path: str = "data/alexia.db") -> EventBus:
    """Retrieve or initialize the global EventBus instance."""
    global _global_bus
    if _global_bus is None or _global_bus.source_db_path != resolve_db_path(db_path):
        _global_bus = EventBus(db_path=db_path)
    return _global_bus
