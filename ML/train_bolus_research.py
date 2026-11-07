
from pathlib import Path
import json
import joblib
import numpy as np
import pandas as pd

from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline

from sklearn.metrics import (
    accuracy_score,
    precision_score,
    recall_score,
    f1_score,
    average_precision_score,
    confusion_matrix,
    precision_recall_curve,
)

# ==================================================
# CONFIGURATION
# ==================================================

BASE_DIR = Path(__file__).resolve().parent

DATA_FILE = BASE_DIR / "data" / "combined_glucose.csv"
MODEL_DIR = BASE_DIR / "models"

MODEL_FILE = MODEL_DIR / "bolus_event_research.joblib"
REPORT_FILE = BASE_DIR / "bolus_research_summary.json"
PARTICIPANT_REPORT = BASE_DIR / "participant_analysis.csv"

INTERVAL_MINUTES = 5
HORIZON_ROWS = 6
LOOKBACK_ROWS = 6

TRAIN_RATIO = 0.70
VALIDATION_RATIO = 0.15

FEATURE_FIELDS = [
    "glucose",
    "carb_input",
    "basal_rate",
    "bolus_volume_delivered",
]

RANDOM_STATE = 42


# ==================================================
# LOAD DATA
# ==================================================

if not DATA_FILE.exists():
    raise FileNotFoundError(f"Dataset not found: {DATA_FILE}")

df = pd.read_csv(DATA_FILE)

required = [
    "time",
    "participant_id",
    *FEATURE_FIELDS,
]

missing = [c for c in required if c not in df.columns]

if missing:
    raise ValueError(f"Missing columns: {missing}")

df["time"] = pd.to_datetime(
    df["time"],
    errors="coerce"
)

for col in FEATURE_FIELDS:
    df[col] = pd.to_numeric(
        df[col],
        errors="coerce"
    )

df = df.dropna(
    subset=["time", "participant_id"]
).copy()

df["participant_id"] = (
    df["participant_id"].astype(str)
)

df = df.sort_values(
    ["participant_id", "time"]
).reset_index(drop=True)

negative_source_values = int(
    (df["bolus_volume_delivered"] < 0).sum()
)

print("========== SOURCE DATA ==========")
print("Total records:", len(df))
print("Participants:", df["participant_id"].nunique())
print("Negative source bolus values:", negative_source_values)


# ==================================================
# PARTICIPANT SOURCE SUMMARY
# ==================================================

source_summary = []

for participant_id, group in df.groupby("participant_id"):

    bolus = group["bolus_volume_delivered"]

    source_summary.append({
        "participant_id": str(participant_id),
        "total_records": int(len(group)),
        "positive_bolus_records": int(
            (bolus > 0).sum()
        ),
        "zero_bolus_records": int(
            (bolus == 0).sum()
        ),
        "negative_bolus_records": int(
            (bolus < 0).sum()
        ),
        "missing_bolus_records": int(
            bolus.isna().sum()
        ),
    })

source_summary_df = pd.DataFrame(source_summary)


# ==================================================
# FEATURE GENERATION
# ==================================================

feature_names = []

for field in FEATURE_FIELDS:
    for lag in range(LOOKBACK_ROWS):
        feature_names.append(
            f"{field}_lag_{lag}"
        )

for field in FEATURE_FIELDS:
    feature_names.append(
        f"{field}_change"
    )


def make_features(values):

    # lag_0 = current observation
    flattened = values[::-1].flatten().tolist()

    changes = []

    for column in range(values.shape[1]):

        oldest = values[0, column]
        current = values[-1, column]

        if (
            np.isfinite(oldest)
            and np.isfinite(current)
        ):
            changes.append(current - oldest)
        else:
            changes.append(np.nan)

    return np.asarray(
        flattened + changes,
        dtype=float
    )


# ==================================================
# TEMPORALLY SEPARATED DATASET
# ==================================================

X_train, y_train = [], []
X_val, y_val = [], []
X_test, y_test = [], []

test_participant_ids = []

for participant_id, group in df.groupby("participant_id"):

    group = group.reset_index(drop=True)

    n = len(group)

    train_end = int(n * TRAIN_RATIO)

    validation_end = int(
        n * (TRAIN_RATIO + VALIDATION_RATIO)
    )

    times = group["time"].to_numpy(
        dtype="datetime64[ns]"
    )

    values = group[FEATURE_FIELDS].to_numpy(
        dtype=float
    )

    bolus = group[
        "bolus_volume_delivered"
    ].to_numpy(dtype=float)

    for i in range(
        LOOKBACK_ROWS - 1,
        n - HORIZON_ROWS
    ):

        window_start = i - LOOKBACK_ROWS + 1

        window_end = i + HORIZON_ROWS

        window_times = times[
            window_start:window_end + 1
        ]

        differences = np.diff(window_times)

        # Require continuous five-minute observations.
        if not np.all(
            differences == np.timedelta64(
                INTERVAL_MINUTES, "m"
            )
        ):
            continue

        historical_values = values[
            window_start:i + 1
        ]

        features = make_features(
            historical_values
        )

        # Six future observations.
        future_bolus = bolus[
            i + 1:i + HORIZON_ROWS + 1
        ]

        # Exclude uncertain future targets.
        if not np.isfinite(future_bolus).all():
            continue

        if np.any(future_bolus < 0):
            continue

        label = int(
            np.any(future_bolus > 0)
        )

        # Chronological partitioning.
        if i + HORIZON_ROWS < train_end:

            X_train.append(features)
            y_train.append(label)

        elif (
            i >= train_end
            and i + HORIZON_ROWS < validation_end
        ):

            X_val.append(features)
            y_val.append(label)

        elif i >= validation_end:

            X_test.append(features)
            y_test.append(label)

            test_participant_ids.append(
                participant_id
            )


# Convert arrays.
X_train = np.asarray(X_train, dtype=float)
y_train = np.asarray(y_train, dtype=int)

X_val = np.asarray(X_val, dtype=float)
y_val = np.asarray(y_val, dtype=int)

X_test = np.asarray(X_test, dtype=float)
y_test = np.asarray(y_test, dtype=int)

test_participant_ids = np.asarray(
    test_participant_ids
)


# ==================================================
# DATA SUMMARY
# ==================================================

print("\n========== SAMPLE SUMMARY ==========")

for name, X, y in [
    ("Training", X_train, y_train),
    ("Validation", X_val, y_val),
    ("Testing", X_test, y_test),
]:

    percentage = (
        float(y.mean() * 100)
        if len(y)
        else 0
    )

    print(f"{name} samples:", len(X))
    print(f"{name} positive events:", int(y.sum()))
    print(
        f"{name} event percentage:",
        round(percentage, 3)
    )

if min(
    len(X_train),
    len(X_val),
    len(X_test)
) == 0:

    raise ValueError(
        "One of the data partitions is empty."
    )

if len(np.unique(y_train)) < 2:
    raise ValueError(
        "Training data contains only one class."
    )

if len(np.unique(y_val)) < 2:
    raise ValueError(
        "Validation data contains only one class."
    )

if len(np.unique(y_test)) < 2:
    raise ValueError(
        "Test data contains only one class."
    )


# ==================================================
# TRAINING PIPELINE
# ==================================================

model = Pipeline([
    (
        "imputer",
        SimpleImputer(strategy="median")
    ),
    (
        "classifier",
        RandomForestClassifier(
            n_estimators=250,
            max_depth=16,
            min_samples_leaf=5,
            class_weight="balanced_subsample",
            random_state=RANDOM_STATE,
            n_jobs=-1,
        )
    )
])

print(
    "\nTraining retrospective research classifier..."
)

model.fit(
    X_train,
    y_train
)


# ==================================================
# VALIDATION THRESHOLD SELECTION
# ==================================================

val_probabilities = model.predict_proba(
    X_val
)[:, 1]

precision_values, recall_values, thresholds = (
    precision_recall_curve(
        y_val,
        val_probabilities
    )
)

if len(thresholds) == 0:
    raise ValueError(
        "Unable to select classification threshold."
    )

f1_values = (
    2 * precision_values[:-1] * recall_values[:-1]
    / (
        precision_values[:-1]
        + recall_values[:-1]
        + 1e-10
    )
)

best_index = int(
    np.argmax(f1_values)
)

best_threshold = float(
    thresholds[best_index]
)

validation_f1 = float(
    f1_values[best_index]
)

print("\n========== VALIDATION ==========")
print(
    "Selected threshold:",
    round(best_threshold, 4)
)
print(
    "Validation F1:",
    round(validation_f1, 4)
)


# ==================================================
# FINAL TEST EVALUATION
# ==================================================

test_probabilities = model.predict_proba(
    X_test
)[:, 1]

test_predictions = (
    test_probabilities >= best_threshold
).astype(int)

accuracy = accuracy_score(
    y_test,
    test_predictions
)

precision = precision_score(
    y_test,
    test_predictions,
    zero_division=0
)

recall = recall_score(
    y_test,
    test_predictions,
    zero_division=0
)

f1 = f1_score(
    y_test,
    test_predictions,
    zero_division=0
)

average_precision = average_precision_score(
    y_test,
    test_probabilities
)

matrix = confusion_matrix(
    y_test,
    test_predictions,
    labels=[0, 1]
).tolist()

baseline_predictions = np.zeros_like(y_test)

baseline_accuracy = accuracy_score(
    y_test,
    baseline_predictions
)

print("\n========== FINAL TEST RESULTS ==========")

print("Accuracy:", round(float(accuracy), 4))
print("Precision:", round(float(precision), 4))
print("Recall:", round(float(recall), 4))
print("F1 Score:", round(float(f1), 4))

print(
    "Average Precision:",
    round(float(average_precision), 4)
)

print("Confusion Matrix:", matrix)

print(
    "No-event baseline accuracy:",
    round(float(baseline_accuracy), 4)
)


# ==================================================
# PARTICIPANT-WISE TEST ANALYSIS
# ==================================================

participant_results = []

for participant_id in np.unique(
    test_participant_ids
):

    mask = (
        test_participant_ids == participant_id
    )

    actual = y_test[mask]

    predicted = test_predictions[mask]

    true_positive = int(
        ((actual == 1) & (predicted == 1)).sum()
    )

    false_positive = int(
        ((actual == 0) & (predicted == 1)).sum()
    )

    false_negative = int(
        ((actual == 1) & (predicted == 0)).sum()
    )

    participant_results.append({

        "participant_id": str(participant_id),

        "test_samples": int(mask.sum()),

        "positive_windows": int(actual.sum()),

        "event_percentage": float(
            actual.mean() * 100
        ),

        "predicted_positive": int(
            predicted.sum()
        ),

        "true_positives": true_positive,

        "false_positives": false_positive,

        "false_negatives": false_negative,

        "precision": float(
            precision_score(
                actual,
                predicted,
                zero_division=0
            )
        ),

        "recall": float(
            recall_score(
                actual,
                predicted,
                zero_division=0
            )
        ),

        "f1_score": float(
            f1_score(
                actual,
                predicted,
                zero_division=0
            )
        ),

        "average_precision": (
            float(
                average_precision_score(
                    actual,
                    test_probabilities[mask]
                )
            )
            if len(np.unique(actual)) > 1
            else None
        )
    })


participant_df = pd.DataFrame(
    participant_results
)

participant_df[
    "positive_window_contribution"
] = (
    participant_df["positive_windows"]
    / max(int(y_test.sum()), 1)
    * 100
)

participant_df = participant_df.sort_values(
    "positive_windows",
    ascending=False
).reset_index(drop=True)

participant_df.to_csv(
    PARTICIPANT_REPORT,
    index=False
)

print(
    "\n========== PARTICIPANT-WISE TEST ANALYSIS =========="
)

print(
    participant_df.to_string(
        index=False,
        float_format=lambda x: f"{x:.4f}"
    )
)


# ==================================================
# COMBINED PARTICIPANT RESEARCH SUMMARY
# ==================================================

participant_source_dict = (
    source_summary_df.to_dict(orient="records")
)

participant_test_dict = []

for record in participant_df.to_dict(orient="records"):

    clean_record = {}

    for key, value in record.items():

        if pd.isna(value):
            clean_record[key] = None
        else:
            clean_record[key] = value

    participant_test_dict.append(clean_record)

source_positive_total = max(
    int(
        source_summary_df[
            "positive_bolus_records"
        ].sum()
    ),
    1
)

source_summary_df[
    "source_positive_contribution"
] = (
    source_summary_df["positive_bolus_records"]
    / source_positive_total
    * 100
)

# Update source summary after calculating contribution.
participant_source_dict = (
    source_summary_df.to_dict(orient="records")
)


# ==================================================
# SAVE MODEL
# ==================================================

MODEL_DIR.mkdir(
    parents=True,
    exist_ok=True
)

joblib.dump(
    {
        "model": model,
        "feature_names": feature_names,
        "threshold": best_threshold,
        "horizon_minutes": (
            HORIZON_ROWS * INTERVAL_MINUTES
        ),
        "lookback_minutes": (
            (LOOKBACK_ROWS - 1) * INTERVAL_MINUTES
        ),
        "mode": "retrospective_historical_research",
    },
    MODEL_FILE
)


# ==================================================
# SAVE RESEARCH REPORT
# ==================================================

summary = {

    "mode": "retrospective_historical_research",

    "task": "historical_bolus_event_classification",

    "forecast_window_minutes": (
        HORIZON_ROWS * INTERVAL_MINUTES
    ),

    "lookback_minutes": (
        (LOOKBACK_ROWS - 1) * INTERVAL_MINUTES
    ),

    "dataset": {
        "total_records": int(len(df)),
        "participants": int(
            df["participant_id"].nunique()
        ),
        "negative_source_bolus_values": (
            negative_source_values
        )
    },

    "samples": {

        "training": {
            "total": int(len(X_train)),
            "positive": int(y_train.sum()),
            "event_percentage": float(
                y_train.mean() * 100
            )
        },

        "validation": {
            "total": int(len(X_val)),
            "positive": int(y_val.sum()),
            "event_percentage": float(
                y_val.mean() * 100
            )
        },

        "testing": {
            "total": int(len(X_test)),
            "positive": int(y_test.sum()),
            "event_percentage": float(
                y_test.mean() * 100
            )
        }
    },

    "validation": {
        "selected_threshold": best_threshold,
        "f1_score": validation_f1
    },

    "metrics": {

        "accuracy": float(accuracy),

        "precision": float(precision),

        "recall": float(recall),

        "f1_score": float(f1),

        "average_precision": float(
            average_precision
        ),

        "confusion_matrix": matrix,

        "no_event_baseline_accuracy": float(
            baseline_accuracy
        )
    },

    "participant_source_analysis": (
        participant_source_dict
    ),

    "participant_test_analysis": (
        participant_test_dict
    ),

    "limitations": [

        "Retrospective research only",

        "Not an insulin dose prediction system",

        "Not for clinical decisions or treatment",

        "Negative future bolus windows were excluded",

        "Chronological participant-wise evaluation",

        "Participants may appear in both training and testing",

        "Adjacent prediction windows can overlap",

        "Positive windows do not represent unique bolus events",

        "Threshold selected using validation data only",

        "Participant-wise metrics may be unstable for rare events"
    ]
}

with open(
    REPORT_FILE,
    "w",
    encoding="utf-8"
) as file:

    json.dump(
        summary,
        file,
        indent=4,
        allow_nan=False
    )


# ==================================================
# FINAL OUTPUT
# ==================================================

print("\n========== SAVED FILES ==========")

print("Model:", MODEL_FILE)

print("Research report:", REPORT_FILE)

print("Participant analysis:", PARTICIPANT_REPORT)

print("\nResearch classifier training completed.")

print(
    "No insulin dose or treatment recommendation was generated."
)
