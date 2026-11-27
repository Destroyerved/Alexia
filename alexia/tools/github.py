"""GitHub integration tool using httpx REST client.

Implements FR-B5, FR-D5, Section 8.2:
- Dynamically reads GITHUB_TOKEN and GITHUB_REPO at call time.
- Creates branch ref + commits patched file via GitHub Git Data / Contents API before opening a Pull Request.
- Supports merging Pull Requests via GitHub REST API (`merge_github_pr`).
- Supports clean local simulation mode when GITHUB_TOKEN is not configured.
"""

from __future__ import annotations

import base64
import logging
import os
from typing import Any, Dict, Optional

from alexia.core.config import allow_simulated_actions
from alexia.core.redact import redact

logger = logging.getLogger("alexia.github")


def _github_token() -> str:
    return (os.getenv("GITHUB_TOKEN") or "").strip()


def _github_repo(override: Optional[str] = None) -> str:
    return (override or os.getenv("GITHUB_REPO") or "Sam-bot-dev/Alexia").strip()


def is_live_github_configured() -> bool:
    """Return True if a genuine GitHub token is present."""
    tok = _github_token()
    return bool(tok and not tok.startswith("ghp_your_github") and tok != "changeme")


def _headers(token: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "Alexia-Guardian-Bot",
    }


def _try_create_branch_and_commit(
    client_mod: Any,
    target_repo: str,
    headers: Dict[str, str],
    base: str,
    branch: str,
    title: str,
    patch: str,
) -> bool:
    """Create `branch` off `base` and commit patched content if applicable."""
    base_ref = client_mod.get(
        f"https://api.github.com/repos/{target_repo}/git/ref/heads/{base}",
        headers=headers,
        timeout=15.0,
    )
    if base_ref.status_code != 200:
        return False
    base_sha = base_ref.json().get("object", {}).get("sha")
    if not base_sha:
        return False

    ref_resp = client_mod.post(
        f"https://api.github.com/repos/{target_repo}/git/refs",
        headers=headers,
        json={"ref": f"refs/heads/{branch}", "sha": base_sha},
        timeout=15.0,
    )
    if ref_resp.status_code not in (200, 201, 422):  # 422 = branch already exists
        return False

    # Commit patch artifact onto the branch so GitHub recognizes a commit difference vs base
    patch_path = f".alexia/patches/{branch.replace('/', '_')}.diff"
    existing = client_mod.get(
        f"https://api.github.com/repos/{target_repo}/contents/{patch_path}",
        params={"ref": branch},
        headers=headers,
        timeout=15.0,
    )
    payload: Dict[str, Any] = {
        "message": title,
        "content": base64.b64encode(patch.encode("utf-8")).decode("ascii"),
        "branch": branch,
    }
    if existing.status_code == 200 and existing.json().get("sha"):
        payload["sha"] = existing.json()["sha"]
    put_resp = client_mod.put(
        f"https://api.github.com/repos/{target_repo}/contents/{patch_path}",
        headers=headers,
        json=payload,
        timeout=15.0,
    )
    return put_resp.status_code in (200, 201)


def open_github_pr(
    title: str,
    branch: str,
    body: str,
    patch: str,
    base: str = "main",
    repo: Optional[str] = None,
) -> Dict[str, Any]:
    """Open a Pull Request on the target repository with redacted body and diff."""
    target_repo = _github_repo(repo)
    safe_body = str(redact(body))
    safe_patch = str(redact(patch))

    if is_live_github_configured():
        try:
            import httpx

            headers = _headers(_github_token())
            _try_create_branch_and_commit(httpx, target_repo, headers, base, branch, title, safe_patch)
            url = f"https://api.github.com/repos/{target_repo}/pulls"
            data = {
                "title": title,
                "head": branch,
                "base": base,
                "body": (
                    f"{safe_body}\n\n### Automated Patch\n```diff\n{safe_patch}\n```\n\n"
                    "*Created autonomously by Alexia DevSecOps Guardian on NVIDIA Nemotron.*"
                ),
            }
            resp = httpx.post(url, headers=headers, json=data, timeout=20.0)
            if resp.status_code in (200, 201):
                pr_data = resp.json()
                logger.info(f"Opened real GitHub PR #{pr_data.get('number')} on {target_repo}")
                return {
                    "number": pr_data.get("number"),
                    "html_url": pr_data.get("html_url"),
                    "title": pr_data.get("title"),
                    "state": pr_data.get("state"),
                    "branch": branch,
                    "base": base,
                    "mode": "live",
                }
            if not allow_simulated_actions():
                raise RuntimeError(f"GitHub PR creation failed ({resp.status_code}): {resp.text[:240]}")
            logger.warning(f"GitHub API returned {resp.status_code}: {resp.text[:200]}. Falling back to simulation.")
        except Exception as e:
            if not allow_simulated_actions():
                raise
            logger.warning(f"GitHub API request failed: {e}. Falling back to simulation.")

    simulated_pr_number = 142
    simulated_url = f"https://github.com/{target_repo}/pull/{simulated_pr_number}"
    logger.info(f"Simulated PR #{simulated_pr_number} created on {target_repo}")

    return {
        "number": simulated_pr_number,
        "html_url": simulated_url,
        "title": title,
        "state": "open",
        "branch": branch,
        "base": base,
        "body": safe_body,
        "patch": safe_patch,
        "mode": "simulated",
    }


def merge_github_pr(
    pr_number: int,
    commit_title: str = "",
    repo: Optional[str] = None,
) -> Dict[str, Any]:
    """Merge an approved Pull Request via GitHub REST API (or sandbox simulation)."""
    target_repo = _github_repo(repo)
    if is_live_github_configured():
        try:
            import httpx

            headers = _headers(_github_token())
            url = f"https://api.github.com/repos/{target_repo}/pulls/{pr_number}/merge"
            payload: Dict[str, Any] = {"merge_method": "squash"}
            if commit_title:
                payload["commit_title"] = commit_title
            resp = httpx.put(url, headers=headers, json=payload, timeout=20.0)
            if resp.status_code in (200, 201):
                data = resp.json()
                return {
                    "merged": bool(data.get("merged", True)),
                    "sha": data.get("sha"),
                    "pr_number": pr_number,
                    "mode": "live",
                }
            if not allow_simulated_actions():
                raise RuntimeError(f"GitHub PR merge failed ({resp.status_code}): {resp.text[:240]}")
            logger.warning(f"GitHub merge returned {resp.status_code}: {resp.text[:200]}. Falling back to simulation.")
        except Exception as e:
            if not allow_simulated_actions():
                raise
            logger.warning(f"GitHub merge request failed: {e}. Falling back to simulation.")

    return {
        "merged": True,
        "sha": f"merged-pr-{pr_number}",
        "pr_number": pr_number,
        "mode": "simulated",
    }
