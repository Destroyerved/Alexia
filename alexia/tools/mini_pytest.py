"""Tiny pytest-compatible runner for the Builder sandbox in builds that ship without pytest.

The PyInstaller AlexiaServer.exe excludes pytest, so the sandbox runs regression tests through
`AlexiaServer.exe --sandbox-test <file>` (or `python -m alexia.tools.mini_pytest <file>`): plain
`def test_*()` functions with assert statements, executed in a fresh process from the sandbox dir.
Exit code 0 = all passed, 1 = a test failed or the file could not be collected.
"""

from __future__ import annotations

import os
import runpy
import sys
import time
import traceback


def run(test_path: str) -> int:
    sys.path.insert(0, os.getcwd())
    started = time.perf_counter()
    try:
        namespace = runpy.run_path(test_path, run_name="sandbox_regression")
    except Exception:
        print(f"ERROR collecting {test_path}")
        traceback.print_exc(limit=4)
        print("1 error during collection")
        return 1

    tests = [(name, fn) for name, fn in namespace.items() if name.startswith("test_") and callable(fn)]
    print(f"collected {len(tests)} item{'s' if len(tests) != 1 else ''}")
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"{test_path}::{name} PASSED")
        except Exception as exc:
            failed += 1
            print(f"{test_path}::{name} FAILED")
            print(f"E   {type(exc).__name__}: {exc}")
    elapsed = time.perf_counter() - started
    passed = len(tests) - failed
    status = "FAILED" if failed else "PASSED"
    print(f"{status}: {passed} passed, {failed} failed in {elapsed:.2f}s")
    return 1 if failed or not tests else 0


if __name__ == "__main__":
    sys.exit(run(sys.argv[1]))
