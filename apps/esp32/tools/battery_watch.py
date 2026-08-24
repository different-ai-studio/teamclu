#!/usr/bin/env python3
"""Capture and summarise the device's BATT telemetry.

    ./tools/battery_watch.py --port /dev/cu.usbmodem1101 --out run-idle.csv
    ./tools/battery_watch.py --summarise run-idle.csv

WHAT THIS CAN AND CANNOT TELL YOU

The M5PM1 has no current sense and no coulomb counter, so there is no way to
read milliamps. All this does is watch the pack voltage fall and fit a slope.
That yields a *relative* cost between states, which is enough to choose a sleep
policy — it is not an absolute mA figure. For that, put a USB power meter
inline.

Because a Li-ion discharge curve is nearly flat through the middle of its
range, a short run measures noise. To get a usable number:

  * hold ONE state for 30-60 minutes
  * start runs from a comparable state of charge, ideally around 80% down to
    60%, where the curve is steepest and closest to linear
  * unplug USB — while charging, the voltage is pinned and the slope is
    meaningless (rows with charging=1 are excluded from the fit)

The reported mAh/h is a *derived estimate*: it converts the voltage slope using
the same naive linear 3300-4200 mV = 0-100% mapping the firmware uses, over a
450 mAh pack. Treat it as an order of magnitude for comparing states, not as a
measurement.
"""
import argparse
import csv
import sys
import time
from collections import defaultdict

PACK_MAH = 450.0
MV_EMPTY = 3300.0
MV_FULL = 4200.0

FIELDS = ["ms", "mv", "pct", "charging", "state"]


def capture(port: str, baud: int, out_path: str) -> int:
    try:
        import serial  # type: ignore
    except ImportError:
        print("error: pyserial not installed (pip install pyserial)", file=sys.stderr)
        return 1

    try:
        ser = serial.Serial(port, baud, timeout=1)
    except Exception as exc:  # noqa: BLE001
        print(f"error: cannot open {port}: {exc}", file=sys.stderr)
        return 1

    print(f"capturing from {port} -> {out_path}   (ctrl-c to stop)")
    rows = 0
    with open(out_path, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(FIELDS)
        try:
            while True:
                raw = ser.readline()
                if not raw:
                    continue
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("BATT,"):
                    continue
                parts = line.split(",")[1:]
                if len(parts) != len(FIELDS) or parts[0] == "ms":
                    continue  # header echo
                writer.writerow(parts)
                fh.flush()
                rows += 1
                print(f"\r{rows} samples  last={line[5:]}   ", end="", flush=True)
        except KeyboardInterrupt:
            print(f"\nstopped, {rows} samples -> {out_path}")
        finally:
            ser.close()
    return 0


def _slope_mv_per_hour(samples):
    """Least-squares slope over (hours, mv). Returns None if degenerate."""
    n = len(samples)
    if n < 3:
        return None
    span_h = (samples[-1][0] - samples[0][0]) / 3_600_000.0
    if span_h <= 0:
        return None
    xs = [(ms - samples[0][0]) / 3_600_000.0 for ms, _ in samples]
    ys = [float(mv) for _, mv in samples]
    mx = sum(xs) / n
    my = sum(ys) / n
    denom = sum((x - mx) ** 2 for x in xs)
    if denom == 0:
        return None
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / denom
    return slope, span_h


def summarise(path: str) -> int:
    by_state = defaultdict(list)
    skipped_charging = 0
    with open(path, newline="") as fh:
        for row in csv.DictReader(fh):
            try:
                if int(row["charging"]):
                    skipped_charging += 1
                    continue
                by_state[row["state"]].append((int(row["ms"]), int(row["mv"])))
            except (ValueError, KeyError):
                continue

    if not by_state:
        print("no usable rows (all charging, or empty file)", file=sys.stderr)
        return 1

    mv_per_pct = (MV_FULL - MV_EMPTY) / 100.0
    print(f"{'state':<10} {'samples':>8} {'span':>8} {'mV/h':>9} {'~mAh/h':>9}  note")
    print("-" * 62)
    for state, samples in sorted(by_state.items()):
        samples.sort()
        res = _slope_mv_per_hour(samples)
        if res is None:
            print(f"{state:<10} {len(samples):>8} {'-':>8} {'-':>9} {'-':>9}  too few/short")
            continue
        slope, span_h = res
        drain_mv_h = -slope  # falling voltage is positive drain
        mah_h = drain_mv_h / mv_per_pct / 100.0 * PACK_MAH
        note = ""
        if span_h < 0.5:
            note = "SHORT RUN - noise, not signal"
        elif drain_mv_h <= 0:
            note = "voltage rose - charging? recovering?"
        print(f"{state:<10} {len(samples):>8} {span_h:>7.2f}h {drain_mv_h:>8.1f} {mah_h:>9.1f}  {note}")

    if skipped_charging:
        print(f"\n({skipped_charging} rows skipped: charging)")
    print("\nmAh/h is derived from the voltage slope via a naive linear SoC map.")
    print("Use it to rank states against each other, not as an absolute figure.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", help="serial port, e.g. /dev/cu.usbmodem1101")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--out", default=f"batt-{int(time.time())}.csv")
    ap.add_argument("--summarise", metavar="CSV", help="summarise an existing capture instead")
    args = ap.parse_args()

    if args.summarise:
        return summarise(args.summarise)
    if not args.port:
        ap.error("need --port to capture, or --summarise CSV")
    return capture(args.port, args.baud, args.out)


if __name__ == "__main__":
    sys.exit(main())
