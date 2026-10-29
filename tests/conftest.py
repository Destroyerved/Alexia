"""Run every test against a throwaway data directory.

Without this the suite reads and writes the developer's live data/alexia.db (shared with a running
server and the eval harness), so a paused kill switch or leftover approvals leak between runs.
Must execute before any alexia module creates its SQLite singletons.
"""

import os
import tempfile

os.environ["ALEXIA_DATA_DIR"] = tempfile.mkdtemp(prefix="alexia_test_data_")
os.environ.pop("ALEXIA_DB", None)
os.environ.pop("EVIDENCE_DIR", None)
os.environ.pop("SNAPSHOT_DIR", None)
