"""Database query and statistics telemetry collector.

Implements FR-S3 and FR-S4:
- Detects SQL injection payloads (' OR 1=1, UNION SELECT, comment sequences).
- Flags row read anomalies when queries return > 10x baseline volume.
- Emits 'sqli_pattern' and 'row_read_anomaly' events to Sentinel.
"""

from __future__ import annotations
import asyncio
import logging
import re
from typing import Optional
from alexia.core.bus import get_event_bus
from alexia.core.schemas import Event

logger = logging.getLogger("alexia.collector.db")

RE_SQLI_PATTERNS = re.compile(
    r"(?i)(?:\bunion\s+(?:all\s+)?select\b|'\s*or\s+['\d\w]+\s*=\s*['\d\w]+|--|/\*|\bwaitfor\s+delay\b|\bxp_cmdshell\b|\bexec\s*\(|\bdrop\s+table\b|\binto\s+outfile\b)"
)


class DBStatsCollector:
    """Monitors database queries and response row volumes for anomalies."""

    def __init__(self, baseline_rows_per_query: int = 15, service: str = "shoplite-api"):
        self.baseline_rows_per_query = baseline_rows_per_query
        self.service = service
        self.bus = get_event_bus()

    async def inspect_query(
        self,
        query_string: str,
        rows_returned: int = 1,
        client_ip: str = "127.0.0.1",
    ) -> Optional[Event]:
        """Inspect a query string and response size for attack signatures."""
        has_sqli_pattern = bool(RE_SQLI_PATTERNS.search(query_string))
        has_row_anomaly = rows_returned > (self.baseline_rows_per_query * 10)

        if has_sqli_pattern:
            event = Event(
                source="collector.db",
                kind="sqli_pattern",
                service=self.service,
                severity="critical",
                data={
                    "ip": client_ip,
                    "payload": query_string,
                    "rows_returned": rows_returned,
                    "anomaly_type": "sql_injection_pattern",
                },
            )
            await self.bus.publish(event)
            return event

        if has_row_anomaly:
            event = Event(
                source="collector.db",
                kind="row_read_anomaly",
                service=self.service,
                severity="high",
                data={
                    "ip": client_ip,
                    "query": query_string[:200],
                    "rows_returned": rows_returned,
                    "baseline": self.baseline_rows_per_query,
                    "anomaly_type": "exfiltration_volume_anomaly",
                },
            )
            await self.bus.publish(event)
            return event

        return None
