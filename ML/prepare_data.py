
from pathlib import Path
import pandas as pd

# Folder containing the preprocessed participant CSV files
DATA_DIR = Path(
    r"C:\Users\monga\Downloads\HUPA-UCM Diabetes Dataset\Preprocessed"
)

OUTPUT_DIR = Path(__file__).resolve().parent / "data"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

frames = []

for file_path in sorted(DATA_DIR.glob("*.csv")):
    # These CSV files use semicolons, not commas
    df = pd.read_csv(file_path, sep=";")

    # Identify the participant for later evaluation
    df["participant_id"] = file_path.stem

    # Parse timestamps and numeric columns
    df["time"] = pd.to_datetime(df["time"], errors="coerce")

    numeric_columns = [
        "glucose",
        "calories",
        "heart_rate",
        "steps",
        "basal_rate",
        "bolus_volume_delivered",
        "carb_input",
    ]

    for column in numeric_columns:
        df[column] = pd.to_numeric(df[column], errors="coerce")

    # Remove invalid timestamps and rows without glucose readings
    df = df.dropna(subset=["time", "glucose"])

    # Keep records in chronological order
    df = df.sort_values("time").reset_index(drop=True)

    frames.append(df)

combined = pd.concat(frames, ignore_index=True)

# Save the combined data for inspection
output_file = OUTPUT_DIR / "combined_glucose.csv"
combined.to_csv(output_file, index=False)

print("Participants:", combined["participant_id"].nunique())
print("Total rows:", len(combined))
print("Missing glucose:", combined["glucose"].isna().sum())
print("Saved to:", output_file)

print("\nRows per participant:")
print(combined.groupby("participant_id").size().to_string())

print("\nFirst five combined rows:")
print(combined.head().to_string(index=False))

# Check timestamp intervals within each participant
print("\nTimestamp interval summary (minutes):")

intervals = (
    combined.sort_values(["participant_id", "time"])
    .groupby("participant_id")["time"]
    .diff()
    .dt.total_seconds()
    .div(60)
    .dropna()
)

print(intervals.describe())
print("\nMost common intervals:")
print(intervals.value_counts().head(10).to_string())

print("\nIntervals that are not exactly 5 minutes:", (intervals != 5).sum())

