
from pathlib import Path
import pandas as pd

# Paths
DATA_DIR = (
    Path.home()
    / "Downloads"
    / "HUPA-UCM Diabetes Dataset"
    / "Preprocessed"
)

OUTPUT_FILE = Path(__file__).parent / "data" / "lstm_glucose.csv"

# Features required by the research paper
REQUIRED_COLUMNS = [
    "time",
    "glucose",
    "carb_input",
    "bolus_volume_delivered",
    "basal_rate",
]

all_data = []
files = sorted(DATA_DIR.glob("*.csv"))

if not files:
    raise FileNotFoundError(f"No participant CSV files found in {DATA_DIR}")

for file in files:
    df = pd.read_csv(file, sep=";")

    missing_columns = set(REQUIRED_COLUMNS) - set(df.columns)
    if missing_columns:
        print(f"Skipping {file.name}: missing {sorted(missing_columns)}")
        continue

    df = df[REQUIRED_COLUMNS].copy()
    df["participant_id"] = file.stem
    df["time"] = pd.to_datetime(df["time"], errors="coerce")

    for column in REQUIRED_COLUMNS[1:]:
        df[column] = pd.to_numeric(df[column], errors="coerce")

    # Remove invalid rows and sort chronologically
    df = df.dropna(subset=REQUIRED_COLUMNS)
    df = df.sort_values("time")

    # Keep only valid, positive glucose measurements
    df = df[df["glucose"] > 0]

    all_data.append(df)

if not all_data:
    raise ValueError("No usable participant data found.")

combined = pd.concat(all_data, ignore_index=True)
combined = combined.sort_values(
    ["participant_id", "time"]
).reset_index(drop=True)

OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
combined.to_csv(OUTPUT_FILE, index=False)

print(f"Participants: {combined['participant_id'].nunique()}")
print(f"Total rows: {len(combined):,}")
print(f"Output: {OUTPUT_FILE}")
print("\nColumns:")
print(combined.columns.tolist())
print("\nMissing values:")
print(combined.isnull().sum())
print("\nRows per participant:")
print(combined.groupby("participant_id").size().to_string())
