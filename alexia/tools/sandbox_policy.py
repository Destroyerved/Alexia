"""Static policy checks for code that the Builder executes in its sandbox.

The Builder's model output is untrusted input.  We want it to be able to call the
ShopLite API through FastAPI's TestClient, but never to read host files, spawn
processes, open sockets, or import the operating system.  The checks here are
intentionally conservative and run *before* a generated test or patch is written
to disk or executed.

This is a defence-in-depth layer, not the only one: the sandbox also runs in a
throwaway directory, with a stripped environment and a hard timeout.
"""

from __future__ import annotations

import ast
import os
from typing import Iterable, List, Tuple

MAX_TEST_BYTES = 64 * 1024

ALLOWED_IMPORT_ROOTS = {
    "__future__",
    "fastapi",
    "app",
    "pytest",
    "typing",
    "json",
    "math",
    "re",
    "datetime",
}

FORBIDDEN_NAMES = {
    "__import__",
    "breakpoint",
    "compile",
    "delattr",
    "eval",
    "exec",
    "getattr",
    "globals",
    "input",
    "locals",
    "open",
    "setattr",
    "vars",
}

# Attribute names that can escape the test harness even without an explicit import.
FORBIDDEN_ATTRIBUTES = {
    "system",
    "popen",
    "spawn",
    "spawnl",
    "spawnv",
    "execv",
    "execve",
    "execl",
    "execle",
    "fork",
    "remove",
    "unlink",
    "rmdir",
    "rmtree",
    "chmod",
    "chown",
    "kill",
    "killpg",
    "socket",
    "connect",
    "urlopen",
    "request",
    "Popen",
    "run",
    "call",
    "check_call",
    "check_output",
}

FORBIDDEN_PATCH_TOKENS = (
    "subprocess",
    "os.system",
    "os.popen",
    "os.exec",
    "os.spawn",
    "socket.",
    "shutil.",
    "ctypes.",
    "importlib",
    "pickle.",
    "marshal.",
    "__import__",
    "eval(",
    "exec(",
    "compile(",
    "open(",
)

ALLOWED_PATCH_PREFIXES = ("app/",)
FORBIDDEN_PATCH_FILES = {
    "app/conftest.py",
    "app/sitecustomize.py",
    "app/usercustomize.py",
}

SAFE_ENV_ALLOWLIST = {
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "LANG",
    "LC_ALL",
    "PYTHONIOENCODING",
    "PYTHONHASHSEED",
    "PYTHONDONTWRITEBYTECODE",
    "PYTHONPATH",
}


def safe_environment(base: dict, extra: dict | None = None) -> dict:
    """Return a copy of `base` with credentials and unrelated secrets removed."""
    env = {k: v for k, v in base.items() if k in SAFE_ENV_ALLOWLIST}
    env.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    env.setdefault("PYTHONHASHSEED", "0")
    env["ALEXIA_SANDBOX"] = "1"
    if extra:
        env.update(extra)
    return env


def _reject_dunder_attributes(tree: ast.AST) -> List[str]:
    errors: List[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr.startswith("__") and node.attr.endswith("__"):
            errors.append(f"dunder attribute access is not allowed: .{node.attr}")
    return errors


def validate_generated_test(source: str) -> Tuple[bool, str]:
    """Validate a model-written pytest file before it is executed.

    Returns `(True, "")` when the file only uses the permitted API-testing
    surface, otherwise `(False, reason)`.
    """
    if not isinstance(source, str) or not source.strip():
        return False, "generated test is empty"
    if len(source.encode("utf-8")) > MAX_TEST_BYTES:
        return False, f"generated test exceeds {MAX_TEST_BYTES // 1024} KiB"
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return False, f"generated test is not valid Python: {exc}"

    errors: List[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root not in ALLOWED_IMPORT_ROOTS:
                    errors.append(f"import of {alias.name!r} is not allowed")
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if root not in ALLOWED_IMPORT_ROOTS:
                errors.append(f"import from {node.module!r} is not allowed")
        elif isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id in FORBIDDEN_NAMES:
                errors.append(f"call to {func.id}() is not allowed")
            elif isinstance(func, ast.Attribute) and func.attr in FORBIDDEN_ATTRIBUTES:
                errors.append(f"call to .{func.attr}() is not allowed")

    errors.extend(_reject_dunder_attributes(tree))
    if errors:
        # De-duplicate while preserving order for a readable audit trail.
        return False, "; ".join(dict.fromkeys(errors))
    return True, ""


def validate_patch(patch_text: str) -> Tuple[bool, str]:
    """Validate a generated unified diff before the sandbox applies it.

    Patches may only touch ShopLite application files (`app/`), and added lines
    may not introduce process, network, filesystem, or dynamic-execution
    primitives.  Existing imports such as `import os` and `import sqlite3` are
    fine; the dangerous calls themselves are rejected.
    """
    if not isinstance(patch_text, str) or not patch_text.strip():
        return False, "generated patch is empty"

    from alexia.tools.diffutil import parse_diff

    files = parse_diff(patch_text)
    if not files:
        return False, "generated patch contains no file sections"

    errors: List[str] = []
    for old_path, new_path, hunks in files:
        rel = (new_path or old_path or "").replace("\\", "/")
        if not rel:
            errors.append("patch has a file entry without a path")
            continue
        if os.path.isabs(rel) or ".." in rel.split("/"):
            errors.append(f"patch path escapes the sandbox: {rel!r}")
            continue
        if not rel.startswith(ALLOWED_PATCH_PREFIXES):
            errors.append(f"patch may only modify app/ files, not {rel!r}")
            continue
        if rel in FORBIDDEN_PATCH_FILES:
            errors.append(f"patch may not modify {rel!r}")
            continue
        if not hunks:
            errors.append(f"patch entry for {rel!r} has no hunks")
            continue
        for hunk in hunks:
            for line in hunk:
                if not line.startswith("+"):
                    continue
                added = line[1:]
                lowered = added.lower()
                for token in FORBIDDEN_PATCH_TOKENS:
                    if token.lower() in lowered:
                        errors.append(f"patch adds forbidden primitive {token!r} in {rel}")
                        break
                if "import " in lowered and any(
                    mod in lowered
                    for mod in ("subprocess", "socket", "ctypes", "importlib", "multiprocessing")
                ):
                    errors.append(f"patch adds a forbidden import in {rel}")

    if errors:
        return False, "; ".join(dict.fromkeys(errors))
    return True, ""


FORBIDDEN_PATCH_MODULES = frozenset(
    {"subprocess", "socket", "ctypes", "importlib", "multiprocessing", "pty", "winreg"}
)


def validate_patched_source(source_text: str, rel_path: str = "app/main.py") -> Tuple[bool, str]:
    """Parse the full patched application module with `ast.parse` to catch multi-line/obfuscated bypasses."""
    try:
        tree = ast.parse(source_text, filename=rel_path)
    except SyntaxError as exc:
        return False, f"patched file {rel_path} has invalid Python syntax: {exc.msg} (line {exc.lineno})"

    errors: List[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root in FORBIDDEN_PATCH_MODULES:
                    errors.append(f"patched file imports forbidden module {alias.name!r}")
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if root in FORBIDDEN_PATCH_MODULES:
                errors.append(f"patched file imports from forbidden module {node.module!r}")
        elif isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id in {"eval", "exec", "compile", "__import__"}:
                errors.append(f"patched file calls forbidden builtin {func.id}()")
            elif isinstance(func, ast.Attribute) and func.attr in {"system", "popen", "Popen"}:
                errors.append(f"patched file calls forbidden method .{func.attr}()")

    errors.extend(_reject_dunder_attributes(tree))
    if errors:
        return False, "; ".join(dict.fromkeys(errors))
    return True, ""


def policy_summary() -> dict:
    """Metadata for documentation/tests describing what the sandbox permits."""
    return {
        "max_test_bytes": MAX_TEST_BYTES,
        "allowed_import_roots": sorted(ALLOWED_IMPORT_ROOTS),
        "forbidden_names": sorted(FORBIDDEN_NAMES),
        "allowed_patch_prefixes": list(ALLOWED_PATCH_PREFIXES),
        "secret_env_stripped": True,
        "timeout_seconds": 120,
    }
