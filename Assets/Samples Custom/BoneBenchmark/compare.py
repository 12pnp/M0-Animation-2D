#!/usr/bin/env python3
"""Compare BoneBenchmark runs: stock spine-unity against BoneBurst.

Reads summary.csv written by BoneBenchmark.cs (one row per configuration and repeat), takes the median of each
configuration's per-run medians across repeats, and prints one table per animation with ratios against Stock.

    python3 Assets/BoneBenchmark/compare.py [summary.csv] [--run RUN_ID] [--metric cpu_main_ms] [--include-editor]

Default summary: the newest macOS persistentDataPath/BoneBenchmark/summary.csv. Editor rows are skipped
unless --include-editor: Editor overhead and job safety checks make them unrepresentative.
"""
import argparse
import csv
import glob
import os
import statistics
import sys

RUNTIMES = ["Stock", "StockThreaded", "BurstCpu", "BurstGpu"]
METRICS = ["frame_ms", "cpu_main_ms", "gpu_ms", "gc_bytes"]


def default_summary():
    # macOS: Application Support/<bundle id>/ (players) or <company>/<product>/ (Editor).
    found = []
    for pattern in ("~/Library/Application Support/*/BoneBenchmark/summary.csv",
                    "~/Library/Application Support/*/*/BoneBenchmark/summary.csv"):
        found += glob.glob(os.path.expanduser(pattern))
    return max(found, key=os.path.getmtime) if found else None


def number(text):
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("summary", nargs="?", default=None)
    parser.add_argument("--run", help="only this run_id (default: the latest run in the file)")
    parser.add_argument("--metric", action="append", help=f"columns to show (default: {', '.join(METRICS)})")
    parser.add_argument("--include-editor", action="store_true")
    args = parser.parse_args()

    path = args.summary or default_summary()
    if not path or not os.path.exists(path):
        sys.exit("no summary.csv found; pass its path")
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
    if not args.include_editor:
        rows = [r for r in rows if r["editor"] != "1"]
    if not rows:
        sys.exit(f"{path}: no player rows (Editor rows need --include-editor)")
    run = args.run or rows[-1]["run_id"]
    rows = [r for r in rows if r["run_id"] == run]
    if not rows:
        sys.exit(f"{path}: no rows for run {run}")

    first = rows[0]
    print(f"run {run}: {first['platform']} {first['graphics']} {first['device']}, {first['cpu_cores']} cores, "
          f"{first['resolution']}, {first.get('backend') or 'Mono'}, development={first['development']}, editor={first['editor']}, "
          f"{first['frames']} frames per run")
    print("median of per-run medians across repeats (p95 in brackets); ratio = value / Stock, lower is better\n")

    metrics = args.metric or METRICS
    groups = {}
    for r in rows:
        groups.setdefault((r["animation"], int(r["count"]), r["runtime"]), []).append(r)

    for animation in sorted({k[0] for k in groups}):
        for metric in metrics:
            print(f"== {animation}: {metric}")
            header = f"{'count':>6} " + "".join(f"{rt:>24}" for rt in RUNTIMES)
            print(header)
            for count in sorted({k[1] for k in groups if k[0] == animation}):
                cells = []
                base = None
                for runtime in RUNTIMES:
                    group = groups.get((animation, count, runtime), [])
                    medians = [v for v in (number(g.get(f"{metric}_median")) for g in group) if v is not None]
                    p95s = [v for v in (number(g.get(f"{metric}_p95")) for g in group) if v is not None]
                    if not medians:
                        cells.append(f"{'-':>24}")
                        continue
                    value = statistics.median(medians)
                    p95 = statistics.median(p95s) if p95s else float("nan")
                    if runtime == "Stock":
                        base = value
                    ratio = f" x{value / base:.2f}" if base and runtime != "Stock" else ""
                    cells.append(f"{value:>10.3f} [{p95:>7.3f}]{ratio:>6}")
                print(f"{count:>6} " + "".join(f"{c:>24}" for c in cells))
            print()


if __name__ == "__main__":
    main()
