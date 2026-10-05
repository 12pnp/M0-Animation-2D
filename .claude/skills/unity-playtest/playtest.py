#!/usr/bin/env python3
"""Drive the open M0-Animation-2D Editor through the `unity command` CLI (the com.unity.pipeline bridge).

  compile   refresh, wait for the compile to finish, report `error CS` lines from Logs/Editor.log
  test      run Test Runner tests (PlayMode or EditMode) by assembly or test name; 0 tests is a failure
  eval      one C# snippet in the Editor
  log       grep Logs/Editor.log

Trimmed from M1-Creator's playtest.py: this project has no FishNet, no boot scene and no MPPM scenario, so the
single / mppm / coop runs and test players are not here.

Exit codes: 0 pass, 1 fail, 2 could not check (Editor unreachable, busy, or setup missing). 2 is never a pass.
See SKILL.md next to this file.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
LOG = ROOT / "Logs" / "Editor.log"

PASS, FAIL, UNCHECKED = 0, 1, 2


class Unreachable(Exception):
    """The CLI or the Editor did not answer; nothing was checked."""


class SnippetError(Exception):
    """The C# snippet did not compile or threw."""


# ─── CLI plumbing ────────────────────────────────────────────────────────────────────────────────────────


def _run_cli(name, args, project, timeout):
    cmd = ["unity", "command", name, "--project-path", str(project), "--format", "json", "--timeout", str(timeout)]
    if args:
        cmd += ["--", *args]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 30)
    except FileNotFoundError:
        raise Unreachable("the `unity` CLI is not on PATH")
    except subprocess.TimeoutExpired:
        raise Unreachable(f"`unity command {name}` did not answer within {timeout + 30} s")
    out = proc.stdout.strip()
    start = out.find("{")
    if start < 0:
        raise Unreachable((proc.stderr or out or "no output from the CLI").strip()[:300])
    try:
        return json.loads(out[start:], strict=False)
    except json.JSONDecodeError:
        raise Unreachable("unreadable CLI output: " + out[:300])


def call(name, args=(), project=ROOT, timeout=60, retries=6):
    """One CLI command. Retries what a domain reload or a busy Editor causes; a snippet error is final."""
    last = ""
    for _ in range(retries):
        try:
            doc = _run_cli(name, list(args), project, timeout)
        except Unreachable as e:
            last = str(e)
            time.sleep(2)
            continue
        if doc.get("success"):
            return doc.get("data") or {}
        last = "; ".join(e.get("message", "") for e in doc.get("errors", [])) or "failed"
        if last.startswith("Compilation Failed") or last.startswith("Runtime Error"):
            raise SnippetError(last)
        if last.startswith("Not a Unity project"):
            break
        time.sleep(2)
    raise Unreachable(f"`unity command {name}`: {last}")


def ev(code, project=ROOT, budget_ms=None, timeout=60):
    """Evaluate a C# statement body (fully-qualified names, no usings, ends in `return <string>;`)."""
    if budget_ms:
        fd, path = tempfile.mkstemp(suffix=".cs", prefix="unity-playtest-")
        with os.fdopen(fd, "w") as f:
            f.write(code)
        try:
            data = call("eval_file", [path, str(budget_ms)], project, timeout=max(timeout, budget_ms // 1000 + 30))
        finally:
            os.unlink(path)
    else:
        data = call("eval", [code], project, timeout)
    res = data.get("result")
    if isinstance(res, dict):
        if res.get("success") is False:
            raise SnippetError(json.dumps(res.get("diagnostics")))
        res = res.get("result")
    return "" if res is None else str(res)


def safe_ev(code, project=ROOT):
    try:
        return ev(code, project)
    except (Unreachable, SnippetError):
        return None


def wait_for(fn, timeout, interval=1.0):
    deadline = time.time() + timeout
    while True:
        value = fn()
        if value:
            return value
        if time.time() > deadline:
            return None
        time.sleep(interval)


def console_status():
    data = call("console_status")
    r = data.get("result")
    return json.loads(r, strict=False) if isinstance(r, str) else (r or {})


BRIDGE_TIMEOUT = "Failed to handle /api/exec request: Main thread operation timed out"


def console_since(since, level=None, tail=500):
    args = ["--since", str(since), "--tail", str(tail)]
    if level:
        args += ["--level", level]
    r = call("console", args).get("result")
    r = json.loads(r, strict=False) if isinstance(r, str) else (r or {})
    return r.get("entries", [])


def clean(message):
    return re.sub(r"<color=[^>]*>|</color>", "", str(message or "")).split("\n")[0].strip()


def print_entries(title, entries, limit=12):
    counts = {}
    for e in entries:
        m = clean(e.get("message"))
        counts[m] = counts.get(m, 0) + 1
    print(f"{title}: {len(entries)}")
    for m, n in list(counts.items())[:limit]:
        print(f"    {n}x {m[:220]}")


def line_count(path):
    try:
        with open(path, "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0


def read_lines_from(path, start):
    try:
        lines = Path(path).read_text(errors="ignore").splitlines()
    except OSError:
        return []
    return lines[start:] if start <= len(lines) else lines


# ─── C# snippets ─────────────────────────────────────────────────────────────────────────────────────────
# Eval compiles each snippet on its own: fully-qualified names, no usings, and a warning fails it.

IS_PLAYING = "return UnityEditor.EditorApplication.isPlaying.ToString();"
BUSY = "return (UnityEditor.EditorApplication.isCompiling || UnityEditor.EditorApplication.isUpdating).ToString();"
REFRESH = 'UnityEditor.AssetDatabase.Refresh(UnityEditor.ImportAssetOptions.ForceSynchronousImport); return "ok";'


# ─── Shared steps ────────────────────────────────────────────────────────────────────────────────────────


def is_playing(project=ROOT):
    return safe_ev(IS_PLAYING, project) == "True"


# ─── Commands ────────────────────────────────────────────────────────────────────────────────────────────


def cmd_compile(a):
    mark = line_count(LOG)
    try:
        ev(REFRESH, budget_ms=60000, timeout=90)
    except (Unreachable, SnippetError) as e:
        # A refresh can outlast the eval's main-thread budget and still land; the wait below decides.
        print(f"refresh: {str(e)[:160]} (continuing)")
    time.sleep(2)
    settled, deadline = 0, time.time() + a.timeout
    while settled < 3:
        if time.time() > deadline:
            print(f"UNCHECKED: the Editor was still compiling or importing after {a.timeout} s")
            return UNCHECKED
        busy = safe_ev(BUSY)
        settled = settled + 1 if busy == "False" else 0
        time.sleep(2)
    try:
        failed = bool(console_status().get("groundTruth", {}).get("compilationFailed"))
    except Unreachable as e:
        print(f"UNCHECKED: {e}")
        return UNCHECKED
    new = read_lines_from(LOG, mark)
    errors = sorted({l.strip() for l in new if re.search(r"error CS\d+", l)})
    # UAC* are Unity's own analyzers (deprecated APIs, serialization rules); they matter as much as CS warnings.
    warnings = sorted({l.strip() for l in new if re.search(r"^(Assets|Packages)/.*warning (?:CS|UAC)\d+", l)})
    print(f"compilationFailed={failed}  new error CS lines={len(errors)}  project warnings={len(warnings)}")
    for l in errors[:20]:
        print(f"    {l[:240]}")
    for l in warnings[:10]:
        print(f"    {l[:240]}")
    if failed or errors:
        print("FAIL")
        return FAIL
    print("PASS")
    return PASS


def cmd_test(a):
    a.timeout = a.timeout or 900
    if is_playing():
        print("UNCHECKED: the Editor is in play mode; stop it first")
        return UNCHECKED
    target, kind = (a.assembly, "assembly") if a.assembly else (a.test, "testname")
    args = ["--mode", a.mode, "--filter", target, "--filter_type", kind]
    try:
        if a.mode == "EditMode":
            # EditMode answers in the same call.
            r = call("run_tests", args, timeout=a.timeout).get("result")
            r = json.loads(r, strict=False) if isinstance(r, str) else (r or {})
        else:
            call("run_tests", args + ["--async_tests"], timeout=120)
            # The status file still holds the previous run until this one starts: see it running first.
            wait_for(lambda: _test_status().get("status") == "running", 30, 1)
            deadline = time.time() + a.timeout
            while True:
                r = _test_status()
                if r.get("status") != "running":
                    break
                if time.time() > deadline:
                    print(f"UNCHECKED: tests still running after {a.timeout} s")
                    return UNCHECKED
                time.sleep(5)
    except Unreachable as e:
        print(f"UNCHECKED: {e}")
        return UNCHECKED
    summary = _lower_keys(r.get("summary") or r.get("Summary") or {})
    results = r.get("results") or r.get("Results") or []
    total, failed = summary.get("total", 0), summary.get("failed", 0)
    print(f"{a.mode} {kind} {target}: {r.get('status', 'done')}  total={total} passed={summary.get('passed', 0)} "
          f"failed={failed} skipped={summary.get('skipped', 0)} inconclusive={summary.get('inconclusive', 0)}")
    for t in results:
        status = t.get("Status") or t.get("Result") or t.get("status")
        if status not in ("Passed", "Skipped"):
            message = (t.get("Message") or t.get("message") or "").replace("\n", " ").strip()
            print(f"    {status}: {t.get('FullName') or t.get('Name')} | {message[:300]}")
    if total == 0:
        print("FAIL: 0 tests ran. An all-platforms test assembly lists under PlayMode, not EditMode.")
        return FAIL
    if failed:
        print("FAIL")
        return FAIL
    print("PASS")
    return PASS


def _test_status():
    r = call("test_status").get("result")
    return json.loads(r, strict=False) if isinstance(r, str) else (r or {})


def _lower_keys(d):
    return {str(k).lower(): v for k, v in d.items()}


def cmd_eval(a):
    code = Path(a.code[1:]).read_text() if a.code.startswith("@") else a.code
    try:
        print(ev(code, budget_ms=a.budget))
    except SnippetError as e:
        print(f"FAIL: {e}")
        return FAIL
    except Unreachable as e:
        print(f"UNCHECKED: {e}")
        return UNCHECKED
    return PASS


def cmd_log(a):
    hits = [clean(l) for l in read_lines_from(LOG, 0) if re.search(a.pattern, l)]
    for l in hits[-a.last:]:
        print(l[:300])
    print(f"({len(hits)} matching lines in {LOG})")
    return PASS


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("compile", help="refresh, wait for the compile, report errors")
    p.add_argument("--timeout", type=int, default=600)
    p.set_defaults(fn=cmd_compile)

    p = sub.add_parser("test", help="run tests by assembly or test name")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--assembly")
    g.add_argument("--test", help="a fully-qualified test or fixture name")
    p.add_argument("--mode", choices=["PlayMode", "EditMode"], default="PlayMode")
    p.add_argument("--timeout", type=int, default=None, help="seconds (default 900)")
    p.set_defaults(fn=cmd_test)

    p = sub.add_parser("eval", help="evaluate a C# snippet (or @file) in the Editor")
    p.add_argument("code")
    p.add_argument("--budget", type=int, default=None, help="main-thread budget in ms (uses eval_file)")
    p.set_defaults(fn=cmd_eval)

    p = sub.add_parser("log", help="grep Logs/Editor.log")
    p.add_argument("pattern")
    p.add_argument("--last", type=int, default=20)
    p.set_defaults(fn=cmd_log)

    a = ap.parse_args()
    sys.exit(a.fn(a))


if __name__ == "__main__":
    main()
