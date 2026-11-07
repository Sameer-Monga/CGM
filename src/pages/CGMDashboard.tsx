import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const API = "http://127.0.0.1:5000";

type GlucoseReading = {
  time: string;
  glucose: number;
  carb_input: number | null;
  bolus_volume_delivered: number | null;
  basal_rate: number | null;
};

type HistoryResponse = {
  participant_id: string;
  count: number;
  readings: GlucoseReading[];
  mode: string;
  available_history_fields?: string[];
};

// Keep missing values as null; do not silently convert them to zero.
function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function displayHistoricalValue(value: number | null, decimals = 2): string {
  return value === null ? "Not recorded" : value.toFixed(decimals);
}

type ModelPrediction = {
  predicted_glucose_30m: number;
  unit: string;
  status: string;
};

type PredictionResponse = {
  random_forest: ModelPrediction;
  lstm: ModelPrediction & { input_time?: string };
  forecast_horizon_minutes: number;
  participant_id: string;
  mode: string;
  clinical_warning: string;
};

type BolusEventResponse = {
  participant_id: string;
  event_probability: number;
  event_probability_percent: number;
  selected_threshold: number;
  predicted_class: number;
  classification: string;
  lookback_minutes: number;
  forecast_window_minutes: number;
  input_time: string;
  mode: string;
  clinical_warning: string;
};


type ChartPoint = {
  time: number;
  glucose: number | null;
  randomForest: number | null;
  lstm: number | null;
};

export default function CGMDashboard() {
  const [period, setPeriod] = useState("3 hours");
  const [rfPrediction, setRfPrediction] = useState<number | null>(null);
  const [lstmPrediction, setLstmPrediction] = useState<number | null>(null);
  const [modelStatus, setModelStatus] = useState("Not tested");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [readings, setReadings] = useState<GlucoseReading[]>([]);
  const [historyStatus, setHistoryStatus] = useState("Loading...");
  const [participants, setParticipants] = useState<string[]>([]);
  const [participantId, setParticipantId] = useState("HUPA0001P");

  const latestGlucose =
    readings.length > 0 ? Number(readings[readings.length - 1].glucose) : null;

  const glucoseTrend =
    readings.length < 2
      ? "Insufficient data"
      : Number(readings[readings.length - 1].glucose) >
          Number(readings[readings.length - 2].glucose)
        ? "↗ Rising"
        : Number(readings[readings.length - 1].glucose) <
            Number(readings[readings.length - 2].glucose)
          ? "↘ Falling"
          : "→ Stable";

const [bolusProbability, setBolusProbability] = useState<number | null>(null);
const [bolusClassification, setBolusClassification] = useState("");
const [bolusStatus, setBolusStatus] = useState("Not tested");
const [bolusLoading, setBolusLoading] = useState(false);
const [bolusError, setBolusError] = useState("");


  async function loadParticipants() {
    try {
      const response = await fetch(`${API}/participants`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Could not load participants.");
      }

      const ids: string[] = data.participants || [];
      setParticipants(ids);

      if (ids.length > 0 && !ids.includes(participantId)) {
        setParticipantId(ids[0]);
      }
    } catch (err) {
      console.error("Could not load participants:", err);
      setError("Could not load participants. Check that Flask is running.");
    }
  }

  async function loadHistory() {
    setHistoryStatus("Loading...");
    setReadings([]);
    setRfPrediction(null);
    setLstmPrediction(null);
    setModelStatus("Not tested");
    setError("");

    try {
      const response = await fetch(
        `${API}/history?participant_id=${encodeURIComponent(participantId)}&limit=500`
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Could not load history.");
      }

      const data = result as HistoryResponse;

      const validReadings = (data.readings || [])
        .filter(
          (reading) =>
            Number.isFinite(new Date(reading.time).getTime()) &&
            Number.isFinite(Number(reading.glucose))
        )
        .map((reading) => ({
          time: reading.time,
          glucose: Number(reading.glucose),
          carb_input: toNullableNumber(reading.carb_input),
          bolus_volume_delivered: toNullableNumber(
            reading.bolus_volume_delivered
          ),
          basal_rate: toNullableNumber(reading.basal_rate),
        }))
        .sort(
          (a, b) =>
            new Date(a.time).getTime() - new Date(b.time).getTime()
        );

      setReadings(validReadings);
      setHistoryStatus(`Loaded ${validReadings.length} historical readings`);

      if (validReadings.length === 0) {
        setError("No valid historical readings were returned for this participant.");
      }
    } catch (err) {
      setHistoryStatus("Unavailable");
      setError(
        err instanceof Error
          ? err.message
          : "Could not load history. Check the Flask API."
      );
    }
  }

  useEffect(() => {
    loadParticipants();
  }, []);

  useEffect(() => {
    if (participants.length > 0 && participants.includes(participantId)) {
      loadHistory();
    }
  }, [participantId, participants]);

  async function runPrediction() {
    if (readings.length < 7) {
      setError("Load at least seven historical readings first.");
      return;
    }

    setLoading(true);
    setError("");
    setModelStatus("Connecting...");

    try {
      const glucoseReadings = readings
        .slice(-7)
        .reverse()
        .map((reading) => reading.glucose);

      const response = await fetch(`${API}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          participant_id: participantId,
          glucose_readings: glucoseReadings,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Prediction request failed.");
      }

      const data = result as PredictionResponse;
      const rf = Number(data.random_forest?.predicted_glucose_30m);
      const lstm = Number(data.lstm?.predicted_glucose_30m);

      if (!Number.isFinite(rf) || !Number.isFinite(lstm)) {
        throw new Error("The API did not return valid predictions for both models.");
      }

      setRfPrediction(Number(rf.toFixed(1)));
      setLstmPrediction(Number(lstm.toFixed(1)));
      setModelStatus("Both models connected");
    } catch (err) {
      setRfPrediction(null);
      setLstmPrediction(null);
      setModelStatus("Unavailable");
      setError(
        err instanceof Error
          ? err.message
          : "Could not reach the prediction API."
      );
    } finally {
      setLoading(false);
    }
  }

async function runBolusPrediction() {
  if (readings.length < 6) {
    setBolusError("At least six historical readings are required.");
    return;
  }

  setBolusLoading(true);
  setBolusError("");
  setBolusStatus("Connecting...");
  setBolusProbability(null);
  setBolusClassification("");

  try {
    const response = await fetch(`${API}/bolus-event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        participant_id: participantId,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result.error || "Bolus research prediction failed."
      );
    }

    const data = result as BolusEventResponse;

    if (!Number.isFinite(data.event_probability_percent)) {
      throw new Error("Invalid probability received from the API.");
    }

    setBolusProbability(data.event_probability_percent);
    setBolusClassification(data.classification);
    setBolusStatus("Research classifier connected");
  } catch (err) {
    setBolusProbability(null);
    setBolusClassification("");
    setBolusStatus("Unavailable");

    setBolusError(
      err instanceof Error
        ? err.message
        : "Could not connect to the bolus research API."
    );
  } finally {
    setBolusLoading(false);
  }
}

  const periodHours =
    period === "1 hour"
      ? 1
      : period === "3 hours"
        ? 3
        : period === "6 hours"
          ? 6
          : period === "12 hours"
            ? 12
            : 24;

  const latestTime =
    readings.length > 0
      ? new Date(readings[readings.length - 1].time).getTime()
      : 0;

  const filteredReadings = readings.filter((reading) => {
    const readingTime = new Date(reading.time).getTime();
    return (
      Number.isFinite(readingTime) &&
      latestTime - readingTime <= periodHours * 60 * 60 * 1000
    );
  });

  const lastReading = filteredReadings[filteredReadings.length - 1];
  const hasPrediction =
    lastReading !== undefined &&
    (rfPrediction !== null || lstmPrediction !== null);

  const chartData: ChartPoint[] = filteredReadings.map((reading, index) => {
    const isLast = index === filteredReadings.length - 1;

    return {
      time: new Date(reading.time).getTime(),
      glucose: reading.glucose,
      // Start each forecast at the last historical glucose point.
      randomForest:
        isLast && rfPrediction !== null ? reading.glucose : null,
      lstm: isLast && lstmPrediction !== null ? reading.glucose : null,
    };
  });

  if (hasPrediction && lastReading) {
    chartData.push({
      time: new Date(lastReading.time).getTime() + 30 * 60 * 1000,
      glucose: null,
      randomForest: rfPrediction,
      lstm: lstmPrediction,
    });
  }

  return (
    <main className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-teal-700">
              CONTINUOUS GLUCOSE MONITORING
            </p>
            <h1 className="mt-2 text-3xl font-bold text-slate-900">
              CGM Dashboard
            </h1>
            <p className="mt-2 text-slate-500">
              Glucose history and dual-model 30-minute forecasting
            </p>
          </div>

          <div className="min-w-52">
            <label
              htmlFor="participant-select"
              className="mb-2 block text-sm font-medium text-slate-700"
            >
              Research participant
            </label>
            <select
              id="participant-select"
              value={participantId}
              onChange={(event) => setParticipantId(event.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white p-2 text-sm"
            >
              {participants.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>
        </header>

        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Research demo only: historical participant data is being used.
          No live sensor is connected. Predictions are experimental and are
          not clinically validated. Do not use them for treatment or insulin
          dosing.
        </div>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-slate-500">
                Latest sample glucose
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-slate-900">
                {latestGlucose === null ? "—" : latestGlucose}
                <span className="text-base font-medium"> mg/dL</span>
              </div>
              <p className="mt-2 text-sm text-slate-500">
                {historyStatus} · {participantId}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-slate-500">
                Historical trend
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-teal-700">
                {glucoseTrend}
              </div>
              <p className="mt-2 text-sm text-slate-500">
                Based on the two latest historical readings
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-slate-500">
                Random Forest · 30 min
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-teal-700">
                {rfPrediction === null ? "—" : rfPrediction}
                <span className="text-base font-medium"> mg/dL</span>
              </div>
              <p className="mt-2 text-sm text-slate-500">
                {rfPrediction === null
                  ? "Run both models to forecast"
                  : "Experimental forecast"}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-slate-500">
                LSTM Neural Network · 30 min
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-violet-700">
                {lstmPrediction === null ? "—" : lstmPrediction}
                <span className="text-base font-medium"> mg/dL</span>
              </div>
              <p className="mt-2 text-sm text-slate-500">
                {lstmPrediction === null
                  ? "Run both models to forecast"
                  : "Experimental forecast"}
              </p>
            </CardContent>
          </Card>
        </section>

        <Card>
          <CardHeader>
            <CardTitle>Generate both forecasts</CardTitle>
            <p className="text-sm text-slate-500">
              Random Forest uses the seven latest glucose readings. LSTM uses
              36 continuous five-minute rows with glucose, carbohydrate,
              bolus-insulin, and basal-insulin features from its dataset.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <button
              onClick={runPrediction}
              disabled={loading || readings.length < 7}
              className="rounded-md bg-teal-700 px-4 py-2 font-medium text-white disabled:opacity-50"
            >
              {loading
                ? "Generating both forecasts..."
                : "Run both 30-minute forecasts"}
            </button>

            <button
              onClick={loadHistory}
              disabled={historyStatus === "Loading..." || loading}
              className="ml-2 rounded-md border border-slate-300 bg-white px-4 py-2 font-medium disabled:opacity-50"
            >
              Reload historical data
            </button>

            <p className="text-sm text-slate-600">
              Model status: <strong>{modelStatus}</strong>
            </p>

            {error && (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}

            {rfPrediction !== null && lstmPrediction !== null && (
              <div className="rounded-md bg-slate-100 p-3 text-sm text-slate-700">
                Random Forest predicts {rfPrediction} mg/dL; LSTM predicts{" "}
                {lstmPrediction} mg/dL after 30 minutes. These are experimental
                research outputs, not medical advice.
              </div>
            )}
          </CardContent>
        </Card>


        <Card>
          <CardHeader>
            
<Card>
  <CardHeader>
    <CardTitle>Bolus Event Prediction — Research Classifier</CardTitle>
    <p className="text-sm text-slate-500">
      Random Forest classification using six historical readings
      to estimate the probability of the historical bolus-event
      label in the following 30-minute window.
    </p>
  </CardHeader>

  <CardContent className="space-y-4">
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      Retrospective research only. This classifier does not
      calculate insulin doses, detect live insulin delivery,
      or recommend treatment.
    </div>

    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="rounded-md bg-slate-100 p-4">
        <p className="text-sm text-slate-500">
          Bolus-event probability
        </p>

        <p className="mt-2 text-3xl font-bold text-teal-700">
          {bolusProbability === null
            ? "—"
            : `${bolusProbability.toFixed(2)}%`}
        </p>

        <p className="mt-1 text-xs text-slate-500">
          Estimated research-classifier probability
        </p>
      </div>

      <div className="rounded-md bg-slate-100 p-4">
        <p className="text-sm text-slate-500">
          Research classification
        </p>

        <p className="mt-2 text-lg font-semibold text-slate-800">
          {bolusClassification || "Not generated"}
        </p>

        <p className="mt-1 text-xs text-slate-500">
          Based on the validation-selected threshold
        </p>
      </div>
    </div>

    <button
      onClick={runBolusPrediction}
      disabled={bolusLoading || readings.length < 6}
      className="rounded-md bg-violet-700 px-4 py-2 font-medium text-white disabled:opacity-50"
    >
      {bolusLoading
        ? "Running classifier..."
        : "Run bolus event classifier"}
    </button>

    <p className="text-sm text-slate-600">
      Model status: <strong>{bolusStatus}</strong>
    </p>

    {bolusError && (
      <p role="alert" className="text-sm text-red-700">
        {bolusError}
      </p>
    )}

    <p className="text-xs text-slate-500">
      Selected participant: {participantId}. The classifier
      uses the latest six continuous five-minute historical
      readings. Its output concerns the next six dataset rows.
      It is not a clinically validated prediction.
    </p>
  </CardContent>
</Card>

            <CardTitle>Insulin Estimation — Research Module</CardTitle>
            <p className="text-sm text-slate-500">
              Research interface for documenting the inputs used by a
              clinician-configured bolus calculator.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <strong>Not for clinical use.</strong> This dashboard uses
              historical research data and experimental glucose predictions.
              It must not calculate, recommend, or deliver insulin doses.
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="rounded-md bg-slate-100 p-3">
                <p className="text-xs text-slate-500">Latest glucose</p>
                <p className="mt-1 text-xl font-semibold text-slate-900">
                  {latestGlucose === null ? "—" : `${latestGlucose.toFixed(1)} mg/dL`}
                </p>
                <p className="text-xs text-slate-500">Latest historical sample</p>
              </div>
              <div className="rounded-md bg-slate-100 p-3">
                <p className="text-xs text-slate-500">Predicted glucose</p>
                <p className="mt-1 text-xl font-semibold text-slate-900">
                  {rfPrediction === null && lstmPrediction === null
                    ? "—"
                    : `RF ${rfPrediction ?? "—"} / LSTM ${lstmPrediction ?? "—"}`}
                </p>
                <p className="text-xs text-slate-500">30-minute forecasts (mg/dL)</p>
              </div>
              <div className="rounded-md bg-slate-100 p-3">
                <p className="text-xs text-slate-500">Carbohydrate intake</p>
                <p className="mt-1 text-xl font-semibold text-slate-900">
                  {displayHistoricalValue(
                    readings.length ? readings[readings.length - 1].carb_input : null
                  )}
                </p>
                <p className="text-xs text-slate-500">Latest recorded dataset value</p>
              </div>
              <div className="rounded-md bg-slate-100 p-3">
                <p className="text-xs text-slate-500">Bolus insulin delivered</p>
                <p className="mt-1 text-xl font-semibold text-slate-900">
                  {displayHistoricalValue(
                    readings.length
                      ? readings[readings.length - 1].bolus_volume_delivered
                      : null
                  )}
                </p>
                <p className="text-xs text-slate-500">Latest recorded dataset value</p>
              </div>
              <div className="rounded-md bg-slate-100 p-3">
                <p className="text-xs text-slate-500">Basal insulin rate</p>
                <p className="mt-1 text-xl font-semibold text-slate-900">
                  {displayHistoricalValue(
                    readings.length ? readings[readings.length - 1].basal_rate : null,
                    4
                  )}
                </p>
                <p className="text-xs text-slate-500">Latest recorded dataset value</p>
              </div>
            </div>

            <div className="rounded-md border border-slate-200 p-4">
              <h3 className="font-semibold text-slate-800">
                Inputs required for a validated bolus-calculator workflow
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                These values must come from an approved clinical protocol or
                the supervising clinician; they are not inferred from this dataset.
              </p>
              <div className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                <p>• Insulin-to-carbohydrate ratio (ICR)</p>
                <p>• Insulin sensitivity factor (ISF)</p>
                <p>• Prescribed target glucose</p>
                <p>• Active insulin / insulin-on-board estimate</p>
                <p>• Carbohydrate amount and meal context</p>
                <p>• Recent basal and bolus delivery history</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-md border border-slate-200 p-3">
                <p className="font-medium text-slate-800">Meal bolus</p>
                <p className="mt-1 text-sm text-slate-500">
                  Status: Awaiting approved ICR, meal data, and clinical review.
                </p>
                <p className="mt-2 text-lg font-semibold text-slate-700">
                  Not calculated
                </p>
              </div>
              <div className="rounded-md border border-slate-200 p-3">
                <p className="font-medium text-slate-800">Correction bolus</p>
                <p className="mt-1 text-sm text-slate-500">
                  Status: Awaiting approved ISF, target glucose, active-insulin
                  method, and clinical review.
                </p>
                <p className="mt-2 text-lg font-semibold text-slate-700">
                  Not calculated
                </p>
              </div>
            </div>
            <p className="text-xs text-slate-500">
              Historical carbohydrate, bolus, and basal values are read directly
              from the /history API response for the selected participant. Missing
              values are shown as “Not recorded”; they are never replaced with zero.
              This section reports historical data only and does not generate
              insulin-dose recommendations.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>Glucose history and model forecasts</CardTitle>
                <p className="mt-1 text-sm text-slate-500">
                  Historical samples and both experimental 30-minute predictions
                </p>
              </div>

              <select
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                value={period}
                onChange={(event) => setPeriod(event.target.value)}
                aria-label="Chart time period"
              >
                <option>1 hour</option>
                <option>3 hours</option>
                <option>6 hours</option>
                <option>12 hours</option>
                <option>24 hours</option>
              </select>
            </div>
          </CardHeader>

          <CardContent>
            {filteredReadings.length === 0 ? (
              <div className="flex h-[350px] items-center justify-center text-sm text-slate-500">
                No historical readings available for this time period.
              </div>
            ) : (
              <div style={{ width: "100%", height: 350, minWidth: 0 }}>
                <ResponsiveContainer width="100%" height={350}>
                  <LineChart
                    data={chartData}
                    margin={{ top: 10, right: 20, left: 10, bottom: 10 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" />

                    <XAxis
                      dataKey="time"
                      type="number"
                      scale="time"
                      domain={["dataMin", "dataMax"]}
                      tick={{ fontSize: 12 }}
                      minTickGap={25}
                      tickFormatter={(value) =>
                        new Date(value).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      }
                    />

                    <YAxis
                      domain={["auto", "auto"]}
                      tick={{ fontSize: 12 }}
                      label={{
                        value: "Glucose (mg/dL)",
                        angle: -90,
                        position: "insideLeft",
                      }}
                    />

                    <Tooltip
                      labelFormatter={(value) =>
                        new Date(Number(value)).toLocaleString([], {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      }
                      formatter={(value, name) => [
                        value === null || value === undefined
                          ? "—"
                          : `${Number(value).toFixed(1)} mg/dL`,
                        name,
                      ]}
                    />

                    <Line
                      type="monotone"
                      dataKey="glucose"
                      name="Historical glucose"
                      stroke="#0d9488"
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />

                    <Line
                      type="monotone"
                      dataKey="randomForest"
                      name="Random Forest forecast"
                      stroke="#2563eb"
                      strokeWidth={3}
                      strokeDasharray="6 4"
                      dot={{ r: 5 }}
                      connectNulls
                      isAnimationActive={false}
                    />

                    <Line
                      type="monotone"
                      dataKey="lstm"
                      name="LSTM forecast"
                      stroke="#8b5cf6"
                      strokeWidth={3}
                      strokeDasharray="3 3"
                      dot={{ r: 5 }}
                      connectNulls
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-5 text-sm text-slate-600">
              <span className="text-teal-700">● Historical glucose</span>
              <span className="text-blue-700">╌ Random Forest</span>
              <span className="text-violet-700">╌ LSTM</span>
              <span>Period: {period}</span>
            </div>

            {!hasPrediction && filteredReadings.length > 0 && (
              <p className="mt-2 text-sm text-slate-500">
                Run both forecasts to display the prediction lines.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
