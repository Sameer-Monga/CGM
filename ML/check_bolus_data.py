
import pandas as pd
from pathlib import Path

file_path = Path(__file__).resolve().parent / "data" / "combined_glucose.csv"
df = pd.read_csv(file_path)

df["bolus_volume_delivered"] = pd.to_numeric(
    df["bolus_volume_delivered"], errors="coerce"
)

total = len(df)
positive = (df["bolus_volume_delivered"] > 0).sum()
zero = (df["bolus_volume_delivered"] == 0).sum()
negative = (df["bolus_volume_delivered"] < 0).sum()

print("\n========== BOLUS DISTRIBUTION ==========")
print("Total:", total)
print("Positive:", positive, f"({positive/total*100:.2f}%)")
print("Zero:", zero, f"({zero/total*100:.2f}%)")
print("Negative:", negative, f"({negative/total*100:.2f}%)")

print("\n========== PARTICIPANT DISTRIBUTION ==========")

summary = df.groupby("participant_id").agg(
    total_records=("bolus_volume_delivered", "count"),
    positive_events=(
        "bolus_volume_delivered",
        lambda x: (x > 0).sum()
    ),
    zero_events=(
        "bolus_volume_delivered",
        lambda x: (x == 0).sum()
    ),
    negative_events=(
        "bolus_volume_delivered",
        lambda x: (x < 0).sum()
    )
)

summary["event_percentage"] = (
    summary["positive_events"] / summary["total_records"] * 100
)

print(summary.to_string())

print("\n========== TOP PARTICIPANT ==========")
print(summary.sort_values(
    "positive_events", ascending=False
).head(5).to_string())
