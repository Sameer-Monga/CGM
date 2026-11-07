

from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import tensorflow as tf

from sklearn.preprocessing import StandardScaler
from sklearn.metrics import mean_absolute_error, mean_squared_error

# Reproducibility
np.random.seed(42)
tf.random.set_seed(42)

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "data" / "lstm_glucose.csv"
MODEL_DIR = BASE_DIR / "models"
MODEL_DIR.mkdir(parents=True, exist_ok=True)

FEATURES = [
    "glucose",
    "carb_input",
    "bolus_volume_delivered",
    "basal_rate",
]

WINDOW = 36       # 180 minutes of history
HORIZON = 6       # Predict 30 minutes ahead
EPOCHS = 20
BATCH_SIZE = 32

# Load and validate data
df = pd.read_csv(DATA_FILE, parse_dates=["time"])
required = FEATURES + ["time", "participant_id"]

missing = set(required) - set(df.columns)
if missing:
    raise ValueError(f"Missing columns: {sorted(missing)}")

for col in FEATURES:
    df[col] = pd.to_numeric(df[col], errors="coerce")

df = df.dropna(subset=required)
df = df.sort_values(["participant_id", "time"]).reset_index(drop=True)

# Split each participant chronologically.
# Break sequences at missing or non-5-minute intervals.
segments = []

for participant_id, group in df.groupby("participant_id", sort=True):
    group = group.sort_values("time").reset_index(drop=True)

    gap_minutes = group["time"].diff().dt.total_seconds() / 60
    segment_id = gap_minutes.ne(5).cumsum()

    for _, segment in group.groupby(segment_id, sort=True):
        segment = segment.reset_index(drop=True)

        if len(segment) < WINDOW + HORIZON + 1:
            continue

        n = len(segment)
        train_end = int(n * 0.60)
        val_end = int(n * 0.80)

        segments.append({
            "participant_id": participant_id,
            "data": segment,
            "train_end": train_end,
            "val_end": val_end,
        })

if not segments:
    raise ValueError("No continuous segments are long enough for training.")

# Fit one scaler using training portions only.
scaler_train_parts = [
    item["data"].loc[:item["train_end"] - 1, FEATURES].to_numpy(
        dtype=np.float64
    )
    for item in segments
    if item["train_end"] > 0
]

scaler = StandardScaler()
scaler.fit(np.concatenate(scaler_train_parts, axis=0))

X_train, y_train = [], []
X_val, y_val = [], []
X_test, y_test = [], []
test_ids = []

# Create sequences without crossing participants, gaps, or split boundaries.
for item in segments:
    segment = item["data"]
    participant_id = item["participant_id"]
    train_end = item["train_end"]
    val_end = item["val_end"]

    values = segment[FEATURES].to_numpy(dtype=np.float32)
    glucose = segment["glucose"].to_numpy(dtype=np.float32)
    scaled = scaler.transform(values).astype(np.float32)

    n = len(segment)

    for start in range(n - WINDOW - HORIZON + 1):
        input_end = start + WINDOW
        target_index = input_end + HORIZON - 1

        # Training: input and target both inside training period.
        if target_index < train_end:
            X_train.append(scaled[start:input_end])
            y_train.append(glucose[target_index])

        # Validation: input and target both inside validation period.
        elif start >= train_end and target_index < val_end:
            X_val.append(scaled[start:input_end])
            y_val.append(glucose[target_index])

        # Testing: input and target both inside test period.
        elif start >= val_end:
            X_test.append(scaled[start:input_end])
            y_test.append(glucose[target_index])
            test_ids.append(participant_id)

if not X_train or not X_val or not X_test:
    raise ValueError("Insufficient sequences for train/validation/test.")

X_train = np.asarray(X_train, dtype=np.float32)
y_train = np.asarray(y_train, dtype=np.float32)
X_val = np.asarray(X_val, dtype=np.float32)
y_val = np.asarray(y_val, dtype=np.float32)
X_test = np.asarray(X_test, dtype=np.float32)
y_test = np.asarray(y_test, dtype=np.float32)
test_ids = np.asarray(test_ids)

print("Forecast horizon:", HORIZON * 5, "minutes")
print("Training sequences:", len(X_train))
print("Validation sequences:", len(X_val))
print("Test sequences:", len(X_test))
print("Input shape:", X_train.shape)
print("Test participants:", len(np.unique(test_ids)))

# LSTM model
model = tf.keras.Sequential([
    tf.keras.layers.Input(shape=(WINDOW, len(FEATURES))),
    tf.keras.layers.LSTM(50),
    tf.keras.layers.Dense(32, activation="relu"),
    tf.keras.layers.Dense(1),
])

model.compile(
    optimizer=tf.keras.optimizers.Adam(learning_rate=0.001),
    loss="mse",
    metrics=["mae"],
)

callbacks = [
    tf.keras.callbacks.EarlyStopping(
        monitor="val_loss",
        patience=4,
        restore_best_weights=True,
    )
]

model.fit(
    X_train,
    y_train,
    validation_data=(X_val, y_val),
    epochs=EPOCHS,
    batch_size=BATCH_SIZE,
    callbacks=callbacks,
    verbose=1,
)

# Evaluate pooled test predictions
predictions = model.predict(X_test, batch_size=BATCH_SIZE).ravel()

mae = mean_absolute_error(y_test, predictions)
rmse = np.sqrt(mean_squared_error(y_test, predictions))

print(f"\nOverall test results ({HORIZON * 5}-minute forecast)")
print(f"MAE:  {mae:.2f} mg/dL")
print(f"RMSE: {rmse:.2f} mg/dL")

# Report metrics per participant to reveal uneven performance.
print("\nParticipant-wise test results:")
participant_results = []

for participant_id in np.unique(test_ids):
    mask = test_ids == participant_id
    p_mae = mean_absolute_error(y_test[mask], predictions[mask])
    p_rmse = np.sqrt(mean_squared_error(y_test[mask], predictions[mask]))

    participant_results.append({
        "participant_id": participant_id,
        "test_sequences": int(mask.sum()),
        "MAE": p_mae,
        "RMSE": p_rmse,
    })

results_df = pd.DataFrame(participant_results)
print(results_df.to_string(index=False, formatters={
    "MAE": "{:.2f}".format,
    "RMSE": "{:.2f}".format,
}))

print("\nMean participant MAE:", round(results_df["MAE"].mean(), 2))
print("Mean participant RMSE:", round(results_df["RMSE"].mean(), 2))

# Save model and the exact scaler used for training.
model.save(MODEL_DIR / "glucose_lstm.keras")
joblib.dump(scaler, MODEL_DIR / "lstm_scaler.joblib")
results_df.to_csv(MODEL_DIR / "lstm_participant_metrics.csv", index=False)

print("\nSaved LSTM model:", MODEL_DIR / "glucose_lstm.keras")
print("Saved scaler:", MODEL_DIR / "lstm_scaler.joblib")
print("Saved participant metrics:", MODEL_DIR / "lstm_participant_metrics.csv")
