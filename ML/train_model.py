
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error
from sklearn.model_selection import GroupShuffleSplit

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "data" / "combined_glucose.csv"
MODEL_DIR = BASE_DIR / "models"
MODEL_DIR.mkdir(parents=True, exist_ok=True)

# Forecast 30 minutes ahead using readings from the previous 30 minutes.
HORIZON = 6
LOOKBACK = 6

df = pd.read_csv(DATA_FILE, parse_dates=["time"])
df = df.sort_values(["participant_id", "time"]).reset_index(drop=True)

# Create lag features and a future target separately for each participant.
feature_columns = []

for lag in range(LOOKBACK + 1):
    column = f"glucose_lag_{lag}"
    df[column] = df.groupby("participant_id")["glucose"].shift(lag)
    feature_columns.append(column)

# Current glucose is lag 0; lag 6 is 30 minutes ago.
df["target_glucose_30m"] = (
    df.groupby("participant_id")["glucose"].shift(-HORIZON)
)

# A target is valid only when the future reading is exactly 30 minutes later.
future_time = df.groupby("participant_id")["time"].shift(-HORIZON)
df["valid_target"] = (
    (future_time - df["time"]).dt.total_seconds() == HORIZON * 5 * 60
)

df = df[df["valid_target"]].dropna(
    subset=feature_columns + ["target_glucose_30m"]
).copy()

# Split whole participants into train and test groups.
splitter = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=42)
train_idx, test_idx = next(
    splitter.split(df[feature_columns], df["target_glucose_30m"],
                   groups=df["participant_id"])
)

train = df.iloc[train_idx].copy()
test = df.iloc[test_idx].copy()

X_train = train[feature_columns]
y_train = train["target_glucose_30m"]
X_test = test[feature_columns]
y_test = test["target_glucose_30m"]

print("Training participants:", sorted(train["participant_id"].unique()))
print("Testing participants:", sorted(test["participant_id"].unique()))
print("Training rows:", len(train))
print("Testing rows:", len(test))

# Baseline: future glucose equals current glucose.
baseline_predictions = X_test["glucose_lag_0"].to_numpy()

# Train a Random Forest model.
model = RandomForestRegressor(
    n_estimators=150,
    min_samples_leaf=5,
    random_state=42,
    n_jobs=-1,
)
model.fit(X_train, y_train)
predictions = model.predict(X_test)

# Evaluate performance separately for each held-out participant.
test_results = test[
    ["participant_id", "target_glucose_30m"]
].copy()

test_results["baseline_prediction"] = baseline_predictions
test_results["model_prediction"] = predictions

print("\nMetrics by held-out participant:")

for participant, group in test_results.groupby("participant_id"):
    actual = group["target_glucose_30m"]

    baseline_mae = mean_absolute_error(
        actual, group["baseline_prediction"]
    )
    model_mae = mean_absolute_error(
        actual, group["model_prediction"]
    )

    print(
        f"{participant}: rows={len(group)}, "
        f"baseline_MAE={baseline_mae:.2f}, "
        f"model_MAE={model_mae:.2f} mg/dL"
    )


def report_metrics(name, actual, predicted):
    mae = mean_absolute_error(actual, predicted)
    rmse = np.sqrt(mean_squared_error(actual, predicted))
    print(f"{name} MAE:  {mae:.2f} mg/dL")
    print(f"{name} RMSE: {rmse:.2f} mg/dL")

print("\nTest results:")
report_metrics("Baseline", y_test, baseline_predictions)
report_metrics("Random Forest", y_test, predictions)

# Save the trained model and the expected feature order.
import joblib

joblib.dump(
    {
        "model": model,
        "feature_columns": feature_columns,
        "horizon_minutes": 30,
        "lookback_minutes": 30,
    },
    MODEL_DIR / "glucose_forecast.joblib",
)

print("\nModel saved to:", MODEL_DIR / "glucose_forecast.joblib")
