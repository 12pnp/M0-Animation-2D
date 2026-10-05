#!/usr/bin/env python3
"""Strict-float parity gate for BoneBurst (Doc/Review/BoneBurst-ImprovePlan.md, I2).

Runs Packages/com.module.ta-creator-boneburst/Tools~/ParityHarness/run.sh twice:
  1. every parity test class: all must pass, and at least one must run;
  2. ParityDriftReport: every compared value must be bit-exact ("0 not bit-exact").
It also requires the harness's own float check ("= 0 (0 = strict float32)"), so a run on a runtime that widens
float arithmetic cannot pass.

Exit codes: 0 PASS, 1 FAIL, 2 UNCHECKED (the harness could not run: no Unity install, project never opened).
No Unity Editor is needed; it takes about 20 s.
"""
import os
import re
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
RUN = os.path.join(ROOT, "Packages", "com.module.ta-creator-boneburst", "Tools~", "ParityHarness", "run.sh")


def run(*args):
    p = subprocess.run([RUN, *args], cwd=ROOT, capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def main():
    problems = []

    code, out = run()
    if code in (2, 3):
        print(out.strip().splitlines()[-1] if out.strip() else "run.sh gave no output")
        print("UNCHECKED" if code == 2 else "FAIL: the harness does not build")
        return 2 if code == 2 else 1
    if "= 0 (0 = strict float32)" not in out:
        problems.append("the runtime did not pass the strict float32 check")
    total = re.search(r"TOTAL: (\d+) of (\d+) passed", out)
    if not total:
        problems.append("no TOTAL line from the harness")
    else:
        passed, ran = int(total.group(1)), int(total.group(2))
        print(f"parity tests: {passed} of {ran} passed")
        if ran == 0:
            problems.append("no test ran (a zero count is a failure)")
        elif passed != ran:
            problems.append(f"{ran - passed} parity test(s) failed")
            problems += [l.strip() for l in out.splitlines() if l.strip().startswith(("FAIL ", "ERROR "))][:10]

    code, out = run("ParityDriftReport")
    drift = re.search(r"([\d,]+) values compared, ([\d,]+) not bit-exact", out)
    if not drift:
        problems.append("no drift report from ParityDriftReport")
    else:
        values, inexact = (int(g.replace(",", "")) for g in drift.groups())
        print(f"drift report: {values:,} values compared, {inexact:,} not bit-exact")
        if values == 0:
            problems.append("the drift report compared nothing")
        elif inexact:
            problems.append(f"{inexact:,} values are not bit-exact on strict float32")
    if code != 0 and drift:
        problems.append("ParityDriftReport failed")

    if problems:
        print("FAIL:\n  " + "\n  ".join(problems))
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
