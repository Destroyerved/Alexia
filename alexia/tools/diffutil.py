"""Minimal unified-diff support for the Builder sandbox (no git or patch binary needed on the host).

`make_diff` renders a git-style diff for one file; `apply_diff_to_dir` applies a (possibly multi-file)
unified diff to a directory, locating each hunk by its context so model-written line numbers may drift.
"""

from __future__ import annotations

import difflib
import os
import re
from typing import Dict, List, Optional, Tuple

_HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def make_diff(rel_path: str, old: str, new: str) -> str:
    """Unified diff of one file, with a/ b/ prefixes like `git diff`."""
    lines = difflib.unified_diff(
        old.splitlines(keepends=True),
        new.splitlines(keepends=True),
        fromfile=f"a/{rel_path}",
        tofile=f"b/{rel_path}",
    )
    return "".join(line if line.endswith("\n") else line + "\n" for line in lines)


def _strip_prefix(path: str) -> str:
    path = path.strip().split("\t")[0]
    if path.startswith(("a/", "b/")):
        path = path[2:]
    return path


def parse_diff(diff_text: str) -> List[Tuple[Optional[str], Optional[str], List[List[str]]]]:
    """Return [(old_path, new_path, hunks)], each hunk a list of raw ' ', '-', '+' lines."""
    files: List[Tuple[Optional[str], Optional[str], List[List[str]]]] = []
    old_path = new_path = None
    hunks: List[List[str]] = []
    current: Optional[List[str]] = None
    for raw in diff_text.splitlines():
        if raw.startswith("--- "):
            if old_path is not None or new_path is not None:
                files.append((old_path, new_path, hunks))
            old_path, new_path, hunks, current = raw[4:], None, [], None
        elif raw.startswith("+++ "):
            new_path = raw[4:]
        elif _HUNK_RE.match(raw):
            current = []
            hunks.append(current)
        elif current is not None and raw[:1] in (" ", "-", "+"):
            current.append(raw)
        elif current is not None and raw == "":
            current.append(" ")  # blank context line whose leading space was trimmed
    if old_path is not None or new_path is not None:
        files.append((old_path, new_path, hunks))
    return [
        (None if (o or "").strip() == "/dev/null" else _strip_prefix(o or ""),
         None if (n or "").strip() == "/dev/null" else _strip_prefix(n or ""),
         h)
        for o, n, h in files
    ]


def _find_block(lines: List[str], block: List[str], start_hint: int) -> int:
    """Index where `block` occurs in `lines` (exact, then ignoring trailing whitespace), nearest the hint."""
    if not block:
        return min(max(start_hint, 0), len(lines))
    for normalize in (lambda s: s, lambda s: s.rstrip()):
        target = [normalize(b) for b in block]
        hits = [
            i for i in range(len(lines) - len(block) + 1)
            if [normalize(x) for x in lines[i:i + len(block)]] == target
        ]
        if hits:
            return min(hits, key=lambda i: abs(i - start_hint))
    return -1


def apply_diff_to_text(text: str, hunks: List[List[str]]) -> str:
    """Apply hunks to file content; raises ValueError when a hunk's context is not found."""
    lines = text.splitlines()
    trailing_newline = text.endswith("\n")
    offset_hint = 0
    for n, hunk in enumerate(hunks, 1):
        old_block = [l[1:] for l in hunk if l[:1] in (" ", "-")]
        new_block = [l[1:] for l in hunk if l[:1] in (" ", "+")]
        at = _find_block(lines, old_block, offset_hint)
        if at < 0:
            raise ValueError(f"hunk {n} does not match the current file")
        lines[at:at + len(old_block)] = new_block
        offset_hint = at + len(new_block)
    return "\n".join(lines) + ("\n" if trailing_newline or not lines else "")


def apply_diff_to_dir(root: str, diff_text: str) -> Tuple[bool, str, Dict[str, str]]:
    """Apply a unified diff under `root`. Returns (ok, message, {path: new_content}); writes only if all apply."""
    files = parse_diff(diff_text)
    if not files or not any(h for _, _, h in files):
        return False, "patch contains no hunks", {}
    updated: Dict[str, str] = {}
    for old_path, new_path, hunks in files:
        rel = new_path or old_path
        if not rel or os.path.isabs(rel) or ".." in rel.replace("\\", "/").split("/"):
            return False, f"refusing to patch path outside the sandbox: {rel!r}", {}
        full = os.path.join(root, rel)
        current = ""
        if old_path is not None:
            if not os.path.exists(full):
                return False, f"{rel}: file not found", {}
            with open(full, encoding="utf-8") as f:
                current = f.read()
        try:
            updated[rel] = apply_diff_to_text(current, hunks)
        except ValueError as e:
            return False, f"{rel}: {e}", {}
    for rel, content in updated.items():
        full = os.path.join(root, rel)
        os.makedirs(os.path.dirname(full) or root, exist_ok=True)
        with open(full, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)
    return True, f"applied to {', '.join(sorted(updated))}", updated
