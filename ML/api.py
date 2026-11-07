
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import tensorflow as tf
from flask import Flask, jsonify, request
from flask_cors import CORS


# ==================================================
# PATHS AND CONFIGURATION
# ==================================================

BASE_DIR = Path(__file__).resolve().parent

RF_MODEL_PATH = BASE_DIR / "models" / "glucose_forecast.joblib"
LSTM_MODEL_PATH = BASE_DIR / "models" / "glucose_lstm.keras"
SCALER_PATH = BASE_DIR / "models" / "lstm_scaler.joblib"
BOLUS_MODEL_PATH = BASE_DIR / "models" / "bolus_event_research.joblib"

DATA_PATH = BASE_DIR / "data" / "combined_glucose.csv"
LSTM_DATA_PATH = BASE_DIR / "data" / "lstm_glucose.csv"

FEATURES = [
    "glucose",
    "carb_input",
    "bolus_volume_delivered",
    "basal_rate",
]

HISTORY_FIELDS = [
    "carb_input",
    "bolus_volume_delivered",
    "basal_rate",
]

BOLUS_FEATURE_FIELDS = [
    "glucose",
    "carb_input",
    "basal_rate",
    "bolus_volume_delivered",
]

WINDOW = 36
HORIZON_ROWS = 6
GAP_MINUTES = 5

BOLUS_LOOKBACK_ROWS = 6
BOLUS_HORIZON_MINUTES = 30


# ==================================================
# LOAD EXISTING GLUCOSE MODELS
# ==================================================

for path in [
    RF_MODEL_PATH,
    LSTM_MODEL_PATH,
    SCALER_PATH,
    DATA_PATH,
    LSTM_DATA_PATH,
]:
    if not path.exists():
        raise FileNotFoundError(f"Required file not found: {path}")

rf_bundle = joblib.load(RF_MODEL_PATH)
rf_model = rf_bundle["model"]
rf_feature_columns = list(rf_bundle["feature_columns"])

if int(rf_bundle["horizon_minutes"]) != 30:
    raise ValueError("Random Forest model must predict 30 minutes ahead.")

lstm_model = tf.keras.models.load_model(
    LSTM_MODEL_PATH,
    compile=False,
)

scaler = joblib.load(SCALER_PATH)

if len(rf_feature_columns) != 7:
    raise ValueError("Random Forest model must have seven glucose lag features.")

if getattr(scaler, "n_features_in_", len(FEATURES)) != len(FEATURES):
    raise ValueError("LSTM scaler does not match the four expected features.")


# ==================================================
# LOAD BOLUS RESEARCH CLASSIFIER
# ==================================================

bolus_model = None
bolus_threshold = None
bolus_model_metadata = {}

if BOLUS_MODEL_PATH.exists():
    bolus_bundle = joblib.load(BOLUS_MODEL_PATH)

    bolus_model = bolus_bundle["model"]
    bolus_threshold = float(bolus_bundle["threshold"])
    bolus_model_metadata = bolus_bundle

    if int(bolus_bundle.get("horizon_minutes", 0)) != BOLUS_HORIZON_MINUTES:
        raise ValueError("Bolus classifier must predict a 30-minute window.")

    print("Bolus research classifier loaded.")
    print("Bolus threshold:", bolus_threshold)
else:
    print("WARNING: Bolus research classifier file not found.")
    print("Expected:", BOLUS_MODEL_PATH)


# ==================================================
# FLASK APP
# ==================================================

app = Flask(__name__)
CORS(app)


# ==================================================
# SHARED HELPERS
# ==================================================

def read_csv_checked(path):
    """Read a dataset and validate required columns."""
    df = pd.read_csv(path)

    required = {"time", "glucose", "participant_id"}

    if not required.issubset(df.columns):
        raise ValueError(
            f"{path.name} must contain: {sorted(required)}"
        )

    df["time"] = pd.to_datetime(df["time"], errors="coerce")
    df["glucose"] = pd.to_numeric(df["glucose"], errors="coerce")
    df["participant_id"] = df["participant_id"].astype(str)

    for column in HISTORY_FIELDS:
        if column in df.columns:
            df[column] = pd.to_numeric(df[column], errors="coerce")

    return df


def json_number(value):
    """Return a finite float, or None for missing/invalid values."""
    if pd.isna(value):
        return None

    number = float(value)
    return number if np.isfinite(number) else None


def get_lstm_window(participant_id):
    """Get the latest 36 continuous five-minute rows for the LSTM."""
    df = read_csv_checked(LSTM_DATA_PATH)

    missing_features = [
        column for column in FEATURES if column not in df.columns
    ]

    if missing_features:
        raise ValueError(
            f"LSTM dataset is missing features: {missing_features}"
        )

    df = df[df["participant_id"] == str(participant_id)].copy()
    df = df.dropna(subset=["time"] + FEATURES)
    df = df.sort_values("time")

    if df.empty:
        raise ValueError(
            f"No LSTM data found for participant {participant_id}."
        )

    gap = df["time"].diff().dt.total_seconds().div(60)
    segment_id = gap.ne(GAP_MINUTES).cumsum()
    df = df[segment_id == segment_id.iloc[-1]].copy()

    if len(df) < WINDOW:
        raise ValueError(
            f"LSTM needs {WINDOW} continuous readings "
            f"({WINDOW * GAP_MINUTES} minutes); "
            f"only {len(df)} are available."
        )

    window = df[FEATURES].tail(WINDOW).to_numpy(dtype=np.float32)

    if window.shape != (WINDOW, len(FEATURES)):
        raise ValueError("Unexpected LSTM input shape.")

    if not np.isfinite(window).all():
        raise ValueError("LSTM input contains invalid numeric values.")

    return window, df["time"].iloc[-1]


def get_bolus_window(participant_id):
    """
    Get six continuous historical rows for the bolus classifier.
    Missing feature values are retained for the model's trained imputer.
    """
    df = read_csv_checked(DATA_PATH)

    missing_features = [
        column
        for column in BOLUS_FEATURE_FIELDS
        if column not in df.columns
    ]

    if missing_features:
        raise ValueError(
            f"Dataset is missing bolus classifier features: {missing_features}"
        )

    df = df[df["participant_id"] == str(participant_id)].copy()
    df = df.dropna(subset=["time"])
    df = df.sort_values("time")

    if len(df) < BOLUS_LOOKBACK_ROWS:
        raise ValueError(
            f"Bolus classifier needs {BOLUS_LOOKBACK_ROWS} historical readings."
        )

    # Find the latest continuous five-minute segment.
    gap = df["time"].diff().dt.total_seconds().div(60)
    segment_id = gap.ne(GAP_MINUTES).cumsum()
    latest_segment = df[segment_id == segment_id.iloc[-1]].copy()

    if len(latest_segment) < BOLUS_LOOKBACK_ROWS:
        raise ValueError(
            "Six continuous five-minute readings are not available "
            "for this participant."
        )

    latest = latest_segment.tail(BOLUS_LOOKBACK_ROWS)

    values = latest[BOLUS_FEATURE_FIELDS].to_numpy(dtype=float)

    if values.shape != (BOLUS_LOOKBACK_ROWS, len(BOLUS_FEATURE_FIELDS)):
        raise ValueError("Unexpected bolus classifier input shape.")

    # IMPORTANT:
    # Reproduce the exact training transformation:
    # values[::-1].flatten() followed by current-minus-oldest changes.
    flattened = values[::-1].flatten().tolist()

    changes = []

    for column in range(values.shape[1]):
        oldest = values[0, column]
        current = values[-1, column]

        if np.isfinite(oldest) and np.isfinite(current):
            changes.append(float(current - oldest))
        else:
            changes.append(np.nan)

    features = np.asarray(
        flattened + changes,
        dtype=float
    ).reshape(1, -1)

    if features.shape[1] != 28:
        raise ValueError(
            f"Expected 28 bolus classifier features; got {features.shape[1]}."
        )

    return features, latest["time"].iloc[-1]


# ==================================================
# HEALTH
# ==================================================

@app.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "rf_model_loaded": True,
        "lstm_model_loaded": True,
        "bolus_model_loaded": bolus_model is not None,
        "forecast_horizon_minutes": 30,
        "mode": "research_demo",
    })


# ==================================================
# GLUCOSE PREDICTION
# ==================================================

@app.post("/predict")
def predict():
    payload = request.get_json(silent=True) or {}

    readings = payload.get("glucose_readings")
    participant_id = str(payload.get("participant_id", "HUPA0001P"))

    if not isinstance(readings, list) or len(readings) != 7:
        return jsonify({
            "error": "Provide exactly 7 glucose readings, newest first."
        }), 400

    try:
        values = [float(value) for value in readings]
    except (TypeError, ValueError):
        return jsonify({
            "error": "Glucose readings must be numeric."
        }), 400

    if not np.isfinite(values).all():
        return jsonify({
            "error": "Glucose readings must be finite."
        }), 400

    try:
        rf_features = {
            f"glucose_lag_{lag}": values[lag]
            for lag in range(7)
        }

        rf_input = pd.DataFrame(
            [[rf_features[name] for name in rf_feature_columns]],
            columns=rf_feature_columns,
        )

        rf_prediction = float(rf_model.predict(rf_input)[0])

        raw_window, lstm_input_time = get_lstm_window(participant_id)

        scaled_window = scaler.transform(
            raw_window.reshape(-1, len(FEATURES))
        ).astype(np.float32)

        lstm_input = scaled_window.reshape(1, WINDOW, len(FEATURES))

        lstm_prediction = float(
            np.asarray(
                lstm_model.predict(lstm_input, verbose=0)
            ).reshape(-1)[0]
        )

        if not np.isfinite(rf_prediction) or not np.isfinite(lstm_prediction):
            raise ValueError("One of the models returned an invalid prediction.")

        return jsonify({
            "random_forest": {
                "predicted_glucose_30m": round(rf_prediction, 1),
                "unit": "mg/dL",
                "status": "connected",
            },
            "lstm": {
                "predicted_glucose_30m": round(lstm_prediction, 1),
                "unit": "mg/dL",
                "status": "connected",
                "input_time": pd.Timestamp(lstm_input_time).isoformat(),
            },
            "forecast_horizon_minutes": 30,
            "participant_id": participant_id,
            "mode": "research_demo",
            "clinical_warning": (
                "Research prototype only; not for treatment or insulin dosing."
            ),
        })

    except (ValueError, FileNotFoundError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception:
        app.logger.exception("Prediction failed")
        return jsonify({
            "error": "Prediction failed. Check the Flask terminal for details."
        }), 500


# ==================================================
# BOLUS EVENT RESEARCH PREDICTION
# ==================================================

@app.post("/bolus-event")
def bolus_event():
    """
    Estimate the probability of the historical research label:
    any positive recorded bolus in the next six five-minute rows.

    This is not an insulin dose prediction or treatment recommendation.
    """
    if bolus_model is None or bolus_threshold is None:
        return jsonify({
            "error": (
                "Bolus research model is not loaded. "
                "Check ML/models/bolus_event_research.joblib."
            )
        }), 503

    payload = request.get_json(silent=True) or {}
    participant_id = str(
        payload.get("participant_id", "HUPA0001P")
    )

    try:
        features, input_time = get_bolus_window(participant_id)

        probabilities = bolus_model.predict_proba(features)

        # Find the probability corresponding to class 1.
        classes = list(bolus_model.classes_)
        positive_class_index = classes.index(1)

        probability = float(
            probabilities[0][positive_class_index]
        )

        if not np.isfinite(probability):
            raise ValueError("Classifier returned an invalid probability.")

        prediction = int(probability >= bolus_threshold)

        return jsonify({
            "participant_id": participant_id,
            "event_probability": round(probability, 4),
            "event_probability_percent": round(probability * 100, 2),
            "selected_threshold": round(bolus_threshold, 4),
            "predicted_class": prediction,
            "classification": (
                "Research event signal detected"
                if prediction == 1
                else "No research event signal detected"
            ),
            "lookback_readings": BOLUS_LOOKBACK_ROWS,
            "lookback_minutes": (
                (BOLUS_LOOKBACK_ROWS - 1) * GAP_MINUTES
            ),
            "forecast_window_minutes": BOLUS_HORIZON_MINUTES,
            "input_time": pd.Timestamp(input_time).isoformat(),
            "mode": "retrospective_historical_research",
            "clinical_warning": (
                "Experimental retrospective classifier only. "
                "Not a live event detector, insulin dose predictor, "
                "or clinical decision tool."
            ),
        })

    except (ValueError, FileNotFoundError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception:
        app.logger.exception("Bolus event prediction failed")
        return jsonify({
            "error": (
                "Bolus event prediction failed. "
                "Check the Flask terminal for details."
            )
        }), 500


# ==================================================
# PARTICIPANTS
# ==================================================

@app.get("/participants")
def participants():
    try:
        df = read_csv_checked(DATA_PATH)
        ids = sorted(
            df["participant_id"].dropna().unique().tolist()
        )

        return jsonify({
            "participants": ids,
            "count": len(ids),
            "mode": "historical_research_data",
        })

    except Exception as exc:
        app.logger.exception("Could not load participants")
        return jsonify({"error": str(exc)}), 500


# ==================================================
# HISTORICAL DATA
# ==================================================

@app.get("/history")
def history():
    try:
        participant_id = request.args.get(
            "participant_id",
            "HUPA0001P"
        )

        limit = min(
            max(int(request.args.get("limit", "100")), 1),
            500,
        )

        df = read_csv_checked(DATA_PATH)

        df = df[
            df["participant_id"] == str(participant_id)
        ].copy()

        df = (
            df.dropna(subset=["time", "glucose"])
            .sort_values("time")
            .tail(limit)
        )

        if df.empty:
            return jsonify({
                "error": f"No historical readings for {participant_id}."
            }), 404

        readings = []

        for _, row in df.iterrows():
            reading = {
                "time": row["time"].isoformat(),
                "glucose": json_number(row["glucose"]),
            }

            for column in HISTORY_FIELDS:
                reading[column] = (
                    json_number(row[column])
                    if column in df.columns
                    else None
                )

            readings.append(reading)

        available_fields = [
            column
            for column in HISTORY_FIELDS
            if column in df.columns
        ]

        return jsonify({
            "participant_id": participant_id,
            "count": len(readings),
            "readings": readings,
            "available_history_fields": available_fields,
            "mode": "historical_research_data",
        })

    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception:
        app.logger.exception("Could not load history")
        return jsonify({
            "error": "Could not load history. Check the Flask terminal."
        }), 500


# ==================================================
# RUN
# ==================================================

if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=5000,
        debug=False
    )
