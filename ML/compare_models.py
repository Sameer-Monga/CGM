
from pathlib import Path
import warnings

import joblib
import numpy as np
import pandas as pd
import tensorflow as tf

from sklearn.metrics import mean_absolute_error, mean_squared_error


# ==================================================
# Paths and settings
# ==================================================
ROOT = Path(__file__).resolve().parent

DATA_PATH = ROOT / "data" / "lstm_glucose.csv"
RF_PATH = ROOT / "models" / "glucose_forecast.joblib"
LSTM_PATH = ROOT / "models" / "glucose_lstm.keras"
SCALER_PATH = ROOT / "models" / "lstm_scaler.joblib"

PREDICTIONS_PATH = ROOT / "models" / "rf_vs_lstm_predictions.csv"
METRICS_PATH = ROOT / "models" / "rf_vs_lstm_metrics.csv"

WINDOW = 36
HORIZON = 6
GAP_MINUTES = 5
BATCH_SIZE = 256

TRAIN_FRACTION = 0.60
VAL_FRACTION = 0.20

FEATURES = [
    "glucose",
    "carb_input",
    "bolus_volume_delivered",
    "basal_rate",
]

RF_BATCH_SIZE = 8192


# ==================================================
# Validate files
# ==================================================
for path in [DATA_PATH, RF_PATH, LSTM_PATH, SCALER_PATH]:
    if not path.exists():
        raise FileNotFoundError(f"Required file not found: {path}")

print("Loading dataset...", flush=True)

df = pd.read_csv(DATA_PATH, parse_dates=["time"])

required = ["time", "participant_id"] + FEATURES
missing = [col for col in required if col not in df.columns]

if missing:
    raise ValueError(f"Missing dataset columns: {missing}")

df = df.dropna(subset=required).copy()
df = df.sort_values(
    ["participant_id", "time"]
).reset_index(drop=True)

if df.empty:
    raise ValueError("No valid dataset rows remain.")

print(f"Dataset rows: {len(df):,}", flush=True)


# ==================================================
# Load Random Forest model
# ==================================================
print("Loading Random Forest model...", flush=True)

rf_bundle = joblib.load(RF_PATH)

if not isinstance(rf_bundle, dict):
    raise ValueError("RF model file must contain a model bundle.")

required_keys = [
    "model",
    "feature_columns",
    "horizon_minutes",
    "lookback_minutes",
]

missing_keys = [key for key in required_keys if key not in rf_bundle]

if missing_keys:
    raise ValueError(f"Missing RF bundle keys: {missing_keys}")

rf_model = rf_bundle["model"]
rf_feature_columns = list(rf_bundle["feature_columns"])

rf_horizon = int(rf_bundle["horizon_minutes"])
rf_lookback = int(rf_bundle["lookback_minutes"])

expected_rf_features = [
    f"glucose_lag_{i}" for i in range(7)
]

if rf_feature_columns != expected_rf_features:
    raise ValueError(
        f"Unexpected RF features: {rf_feature_columns}"
    )

if rf_horizon != 30 or rf_lookback != 30:
    raise ValueError(
        f"Expected RF horizon/lookback of 30 minutes; "
        f"found {rf_horizon}/{rf_lookback}."
    )


# ==================================================
# Load LSTM model and scaler
# ==================================================
print("Loading LSTM model and scaler...", flush=True)

lstm_model = tf.keras.models.load_model(
    LSTM_PATH,
    compile=False
)

scaler = joblib.load(SCALER_PATH)

if getattr(scaler, "n_features_in_", len(FEATURES)) != len(FEATURES):
    raise ValueError(
        "The saved scaler does not match the four LSTM features."
    )

print(f"RF horizon: {rf_horizon} minutes", flush=True)
print(f"RF lookback: {rf_lookback} minutes", flush=True)
print(f"LSTM input window: {WINDOW * GAP_MINUTES} minutes", flush=True)
print("Models loaded successfully.", flush=True)


# ==================================================
# Identify continuous five-minute segments
# ==================================================
df["gap"] = (
    df.groupby("participant_id")["time"]
    .diff()
    .dt.total_seconds()
    .div(60)
)

df["segment"] = (
    df["gap"].ne(GAP_MINUTES)
    .groupby(df["participant_id"])
    .cumsum()
)


# ==================================================
# Collect evaluation samples
# No predictions are made inside this loop.
# ==================================================
metadata = []
rf_input_rows = []
lstm_raw_inputs = []

groups = df.groupby(
    ["participant_id", "segment"],
    sort=False
)

print("Preparing evaluation samples...", flush=True)

for group_number, ((participant, segment), group) in enumerate(groups, start=1):
    group = group.sort_values("time").reset_index(drop=True)
    n = len(group)

    if n < WINDOW + HORIZON + 10:
        continue

    val_end = int(n * (TRAIN_FRACTION + VAL_FRACTION))
    start_min = max(val_end, WINDOW + HORIZON - 1)

    if start_min >= n:
        continue

    values = group[FEATURES].to_numpy(dtype=np.float32)
    glucose = group["glucose"].to_numpy(dtype=np.float32)
    times = group["time"].to_numpy()

    for target_idx in range(start_min, n):
        # The latest input is 30 minutes before the target.
        input_end = target_idx - HORIZON + 1
        input_start = input_end - WINDOW

        if input_start < 0 or input_end <= 0:
            continue

        x_lstm = values[input_start:input_end]

        if x_lstm.shape != (WINDOW, len(FEATURES)):
            continue

        # Seven glucose readings, newest to oldest.
        rf_end = input_end
        rf_start = rf_end - len(rf_feature_columns)

        if rf_start < 0:
            continue

        rf_readings = glucose[rf_start:rf_end][::-1]

        if len(rf_readings) != len(rf_feature_columns):
            continue

        rf_input_rows.append(rf_readings)
        lstm_raw_inputs.append(x_lstm)

        metadata.append({
            "participant_id": participant,
            "time": times[target_idx],
            "actual_glucose": float(glucose[target_idx]),
        })

    if group_number % 500 == 0:
        print(
            f"Processed {group_number:,} segments...",
            flush=True
        )

if not metadata:
    raise RuntimeError(
        "No evaluation samples generated. Check segment lengths and timestamps."
    )

sample_count = len(metadata)

print(f"Evaluation samples: {sample_count:,}", flush=True)


# ==================================================
# Random Forest: batch predictions
# ==================================================
print("Preparing Random Forest inputs...", flush=True)

rf_input_df = pd.DataFrame(
    np.asarray(rf_input_rows, dtype=np.float32),
    columns=rf_feature_columns
)

del rf_input_rows

print("Predicting with Random Forest in batches...", flush=True)

rf_predictions = np.empty(sample_count, dtype=np.float32)

for start in range(0, sample_count, RF_BATCH_SIZE):
    end = min(start + RF_BATCH_SIZE, sample_count)

    batch_df = rf_input_df.iloc[start:end]
    rf_predictions[start:end] = rf_model.predict(batch_df)

    if end == sample_count or end % (RF_BATCH_SIZE * 5) == 0:
        print(
            f"Random Forest: {end:,}/{sample_count:,}",
            flush=True
        )

del rf_input_df


# ==================================================
# LSTM: scale and predict in batches
# ==================================================
print("Scaling LSTM inputs...", flush=True)

lstm_raw_inputs = np.stack(lstm_raw_inputs, axis=0)

lstm_2d = lstm_raw_inputs.reshape(-1, len(FEATURES))
lstm_scaled_2d = scaler.transform(lstm_2d).astype(np.float32)

lstm_inputs = lstm_scaled_2d.reshape(
    sample_count,
    WINDOW,
    len(FEATURES)
)

del lstm_raw_inputs, lstm_2d, lstm_scaled_2d

print("Predicting with LSTM in batches...", flush=True)

lstm_predictions = lstm_model.predict(
    lstm_inputs,
    batch_size=BATCH_SIZE,
    verbose=1
).reshape(-1)

del lstm_inputs

if len(rf_predictions) != sample_count:
    raise RuntimeError("RF prediction count mismatch.")

if len(lstm_predictions) != sample_count:
    raise RuntimeError("LSTM prediction count mismatch.")


# ==================================================
# Save predictions
# ==================================================
out = pd.DataFrame(metadata)

out["time"] = pd.to_datetime(out["time"])
out["rf_prediction"] = rf_predictions
out["lstm_prediction"] = lstm_predictions

numeric_cols = [
    "actual_glucose",
    "rf_prediction",
    "lstm_prediction",
]

if out[numeric_cols].isna().any().any():
    raise RuntimeError("Missing values found in evaluation predictions.")

out.to_csv(PREDICTIONS_PATH, index=False)

print(f"Saved predictions: {PREDICTIONS_PATH}", flush=True)


# ==================================================
# Calculate evaluation metrics
# ==================================================
def calculate_metrics(actual, predicted):
    actual = np.asarray(actual, dtype=np.float64)
    predicted = np.asarray(predicted, dtype=np.float64)

    return {
        "MAE_mg_dL": mean_absolute_error(actual, predicted),
        "RMSE_mg_dL": np.sqrt(
            mean_squared_error(actual, predicted)
        ),
        "samples": len(actual),
    }


summary = []

for model_name, pred_col in [
    ("Random Forest", "rf_prediction"),
    ("LSTM", "lstm_prediction"),
]:
    pooled = calculate_metrics(
        out["actual_glucose"],
        out[pred_col]
    )

    per_participant = []

    for participant, part in out.groupby("participant_id"):
        per_participant.append(
            calculate_metrics(
                part["actual_glucose"],
                part[pred_col]
            )
        )

    summary.append({
        "model": model_name,
        "pooled_MAE": pooled["MAE_mg_dL"],
        "pooled_RMSE": pooled["RMSE_mg_dL"],
        "mean_participant_MAE": np.mean(
            [m["MAE_mg_dL"] for m in per_participant]
        ),
        "mean_participant_RMSE": np.mean(
            [m["RMSE_mg_dL"] for m in per_participant]
        ),
        "samples": pooled["samples"],
        "participants": out["participant_id"].nunique(),
    })

summary_df = pd.DataFrame(summary)
summary_df.to_csv(METRICS_PATH, index=False)


# ==================================================
# Display results
# ==================================================
print("\n" + "=" * 65)
print("RANDOM FOREST VS LSTM - 30-MINUTE GLUCOSE FORECAST")
print("=" * 65)
print(summary_df.round(3).to_string(index=False))

best_mae = summary_df.loc[
    summary_df["pooled_MAE"].idxmin(), "model"
]

best_rmse = summary_df.loc[
    summary_df["pooled_RMSE"].idxmin(), "model"
]

print(f"\nLowest pooled MAE: {best_mae}")
print(f"Lowest pooled RMSE: {best_rmse}")

print(f"\nSaved predictions: {PREDICTIONS_PATH}")
print(f"Saved metrics: {METRICS_PATH}")


