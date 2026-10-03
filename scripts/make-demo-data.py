"""Generates public/demo-data.csv: a deterministic demo file in the same schema as
Monastic Media's sample, with one creative per edge case the brief mentions."""
import csv, random
from datetime import date, timedelta

random.seed(7)
START, DAYS = date(2026, 9, 1), 28

# ad_id, name, format, daily impressions, ctr(day) -> float or None (paused)
def steady(c): return lambda d: c
def decay(a, b): return lambda d: a + (b - a) * d / (DAYS - 1)
def creatives():
    return [
        ("DEMO-01", "Demo 01 (video, problem-first hook)", "video", 9000, steady(0.025)),
        ("DEMO-02", "Demo 02 (video, testimonial) - fatiguing", "video", 9500, decay(0.022, 0.010)),
        ("DEMO-03", "Demo 03 (static, offer) - paused mid-month", "static", 7000,
            lambda d: None if 9 <= d <= 13 else 0.014),
        ("DEMO-04", "Demo 04 (video, unboxing) - launched late", "video", 8000,
            lambda d: None if d < 19 else 0.02),
        ("DEMO-05", "Demo 05 (carousel, bestsellers) - low volume", "carousel", 500, decay(0.02, 0.008)),
        ("DEMO-06", "Demo 06 (video, founder story) - dipped then recovered", "video", 9000,
            lambda d: 0.012 if 10 <= d <= 18 else 0.02),
        ("DEMO-07", "Demo 07 (static, new launch) - paused last week", "static", 6000,
            lambda d: None if d >= 21 else decay(0.018, 0.009)(d)),
        ("DEMO-08", "Demo 08 (static, before-after) - just over threshold", "static", 7000,
            lambda d: 0.018 if d < 14 else 0.012),
        ("DEMO-09", "Demo 09 (carousel, reviews) - mild decline", "carousel", 6500,
            lambda d: 0.016 if d < 14 else 0.0125),
        ("DEMO-10", "Demo 10 (video, festive) - late launch, now fatigued", "video", 8500,
            lambda d: None if d < 4 else (0.024 if d < 14 else 0.013)),
    ]

with open("public/demo-data.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["date", "ad_id", "creative_name", "format", "impressions", "clicks", "spend_inr"])
    for d in range(DAYS):
        for ad_id, name, fmt, base_impr, ctr_fn in creatives():
            c = ctr_fn(d)
            if c is None:
                continue  # paused: no row at all, like a real export
            impr = int(base_impr * random.uniform(0.9, 1.1))
            clicks = round(impr * c * random.uniform(0.95, 1.05))
            spend = round(impr * random.uniform(0.15, 0.19), 2)
            w.writerow([(START + timedelta(days=d)).isoformat(), ad_id, name, fmt, impr, clicks, spend])
