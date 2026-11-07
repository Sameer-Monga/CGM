import {
  AlertCircle,
  Camera,
  FileText,
  Plus,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { MatrixSpinner } from "@/components/ui/matrix-spinner";
import { PixelSpinner } from "@/components/ui/pixel-spinner";

import { useAiVisionEnabled } from "@/hooks/useAiVisionEnabled";
import { useTranslation } from "@/hooks/useTranslation";
import { resolveFacilityIdFromPath } from "@/lib/facility";
import {
  combineFilesForReportUpload,
  uploadDiagnosticReportFile,
} from "@/lib/files";
import {
  clearLabObservationMarks,
  extractLabResults,
  highlightLabObservation,
  persistLabObservationMark,
  type FillMark,
} from "@/lib/ocr";
import { readLowConfidenceThreshold } from "@/lib/plugin-config";
import { resolveDiagnosticReportContext } from "@/lib/service-request";

type Status = "idle" | "processing" | "filling" | "success" | "error";

const FIELD_FILL_DELAY_MS = 350;
const EXTRACTION_MESSAGE_KEYS = [
  "extracting_information",
  "autofilling_fields",
  "verifying_details",
  "almost_done",
] as const;

interface ObservationDefinition {
  id: string;
  title?: string;
  code?: { code: string; display?: string };
  component?: { code: { code: string; display?: string } }[];
  permitted_unit?: {
    code: string;
    display?: string;
    system?: string;
  } | null;
  permitted_data_type?: string;
}

interface ExtractedResult {
  definitionId: string;
  values: {
    value: string;
    unit?: string;
    componentCode?: string;
    confidence?: number;
  }[];
}

function asExtractedField(raw: unknown): {
  value: string;
  confidence?: number;
} {
  if (raw == null) return { value: "" };
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const nested = obj.value ?? obj.text ?? "";
    const conf = obj.confidence ?? obj.score;
    const confidence =
      typeof conf === "number"
        ? conf
        : typeof conf === "string" && conf.trim()
          ? Number(conf)
          : undefined;
    return {
      value: nested == null ? "" : String(nested),
      confidence:
        typeof confidence === "number" && Number.isFinite(confidence)
          ? confidence > 1 && confidence <= 100
            ? confidence / 100
            : confidence
          : undefined,
    };
  }
  return { value: String(raw) };
}

interface FillStep {
  apply: () => void;
  highlight: () => void;
}

interface QueuedFile {
  file: File;
  url: string | null;
}

function isLabFile(file: File): boolean {
  return (
    file.type.startsWith("image/") ||
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  );
}

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function mapResults(
  result: Record<string, unknown>,
  definitions: ObservationDefinition[],
): ExtractedResult[] {
  const results: ExtractedResult[] = [];

  for (const def of definitions) {
    if (def.component?.length) {
      const values = def.component
        .map((comp) => {
          const prefix = `${def.id}__${comp.code.code}`;
          const field = asExtractedField(result[`${prefix}__value`]);
          if (!field.value) return null;
          const unit = asExtractedField(result[`${prefix}__unit`]).value;
          return {
            value: field.value,
            unit: unit || undefined,
            componentCode: comp.code.code,
            confidence: field.confidence,
          };
        })
        .filter(Boolean) as ExtractedResult["values"];

      if (values.length) results.push({ definitionId: def.id, values });
      continue;
    }

    const field = asExtractedField(result[`${def.id}__value`]);
    if (!field.value) continue;
    const unit = asExtractedField(result[`${def.id}__unit`]).value;
    results.push({
      definitionId: def.id,
      values: [
        {
          value: field.value,
          unit: unit || undefined,
          confidence: field.confidence,
        },
      ],
    });
  }

  return results;
}

export default function DiagnosticReportOCR({
  observationDefinitions,
  handleComponentValueChange,
  handleValueChange,
  handleUnitChange,
  disabled,
}: {
  observationDefinitions: ObservationDefinition[];
  handleComponentValueChange: (
    definitionId: string,
    index: number,
    componentCode: string,
    value: string,
    unit: string,
  ) => void;
  handleValueChange: (
    definitionId: string,
    index: number,
    value: string,
  ) => void;
  handleUnitChange: (definitionId: string, index: number, unit: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { enabled } = useAiVisionEnabled();

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [queued, setQueued] = useState<QueuedFile[]>([]);
  const [preview, setPreview] = useState<QueuedFile | null>(null);
  const [filledValueCount, setFilledValueCount] = useState(0);
  const [lowConfidenceCount, setLowConfidenceCount] = useState(0);
  const [keepDocs, setKeepDocs] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fillTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const queuedRef = useRef(queued);
  queuedRef.current = queued;
  const keepDocsRef = useRef(keepDocs);
  keepDocsRef.current = keepDocs;

  const clearFillTimeouts = () => {
    fillTimeoutsRef.current.forEach(clearTimeout);
    fillTimeoutsRef.current = [];
  };

  useEffect(() => clearFillTimeouts, []);

  useEffect(() => {
    return () => {
      queuedRef.current.forEach((item) => {
        if (item.url) URL.revokeObjectURL(item.url);
      });
      clearLabObservationMarks();
    };
  }, []);

  const revokeAll = (items: QueuedFile[]) => {
    items.forEach((item) => {
      if (item.url) URL.revokeObjectURL(item.url);
    });
  };

  const buildFillSteps = useCallback(
    (mapped: ExtractedResult[]): FillStep[] => {
      const steps: FillStep[] = [];
      const byId = new Map(
        observationDefinitions.map((d) => [d.id, d] as const),
      );
      const labels = {
        autofilled: t("auto_filled"),
        checkThis: t("check_this"),
      };

      for (const result of mapped) {
        const def = byId.get(result.definitionId);
        for (const val of result.values) {
          const mark: FillMark =
            val.confidence != null &&
            val.confidence < readLowConfidenceThreshold()
              ? "check_this"
              : "autofilled";
          if (val.componentCode) {
            steps.push({
              apply: () =>
                handleComponentValueChange(
                  result.definitionId,
                  0,
                  val.componentCode!,
                  val.value,
                  val.unit || "",
                ),
              highlight: () => {
                if (!def) return;
                highlightLabObservation(def, "value", val.componentCode);
                persistLabObservationMark(
                  def,
                  "value",
                  mark,
                  labels,
                  val.componentCode,
                );
              },
            });
            continue;
          }
          steps.push({
            apply: () => handleValueChange(result.definitionId, 0, val.value),
            highlight: () => {
              if (!def) return;
              highlightLabObservation(def, "value");
              persistLabObservationMark(def, "value", mark, labels);
            },
          });
          if (val.unit) {
            steps.push({
              apply: () => handleUnitChange(result.definitionId, 0, val.unit!),
              highlight: () => def && highlightLabObservation(def, "unit"),
            });
          }
        }
      }
      return steps;
    },
    [
      observationDefinitions,
      handleComponentValueChange,
      handleValueChange,
      handleUnitChange,
      t,
    ],
  );

  const runFillAnimation = useCallback((steps: FillStep[]) => {
    clearFillTimeouts();

    if (steps.length === 0) {
      setStatus("success");
      return;
    }

    setStatus("filling");
    steps.forEach((step, index) => {
      const timeoutId = setTimeout(() => {
        step.apply();
        requestAnimationFrame(() => step.highlight());
        if (index === steps.length - 1) setStatus("success");
      }, index * FIELD_FILL_DELAY_MS);
      fillTimeoutsRef.current.push(timeoutId);
    });
  }, []);

  const appendFiles = useCallback(
    (files: File[]) => {
      const accepted = files.filter(isLabFile);
      if (!accepted.length) {
        setError(t("upload_image_error"));
        setStatus("error");
        return;
      }

      setError("");
      setStatus("idle");
      setQueued((prev) => {
        const existing = new Set(prev.map((item) => fileKey(item.file)));
        const next = [...prev];
        for (const file of accepted) {
          if (existing.has(fileKey(file))) continue;
          existing.add(fileKey(file));
          next.push({
            file,
            url: URL.createObjectURL(file),
          });
        }
        return next;
      });
    },
    [t],
  );

  const removeAt = useCallback((index: number) => {
    setPreview(null);
    setQueued((prev) => {
      const item = prev[index];
      if (item?.url) URL.revokeObjectURL(item.url);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const extract = useCallback(async () => {
    const files = queuedRef.current.map((item) => item.file);
    if (!files.length) return;

    clearFillTimeouts();
    clearLabObservationMarks();
    setStatus("processing");
    setError("");
    setFilledValueCount(0);
    setLowConfidenceCount(0);

    try {
      const labResults = await extractLabResults(
        files,
        observationDefinitions,
        resolveFacilityIdFromPath(),
      );
      const mapped = mapResults(labResults, observationDefinitions);
      setFilledValueCount(
        mapped.reduce((n, item) => n + item.values.length, 0),
      );
      setLowConfidenceCount(
        mapped.reduce(
          (n, item) =>
            n +
            item.values.filter(
              (val) =>
                val.confidence != null &&
                val.confidence < readLowConfidenceThreshold(),
            ).length,
          0,
        ),
      );
      runFillAnimation(buildFillSteps(mapped));

      if (keepDocsRef.current) {
        void (async () => {
          try {
            const context = await resolveDiagnosticReportContext();
            if (!context) return;
            const displayName = `${context.patientName} - ${context.testName}`;
            const file = await combineFilesForReportUpload(files, displayName);
            await uploadDiagnosticReportFile(
              file,
              context.reportId,
              displayName,
            );
            await queryClient.invalidateQueries({
              queryKey: ["files", "diagnostic_report", context.reportId],
            });
          } catch (err) {
            console.error("Failed to attach scanned file to report", err);
          }
        })();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("extraction_failed"));
      setStatus("error");
    }
  }, [
    observationDefinitions,
    t,
    buildFillSteps,
    runFillAnimation,
    queryClient,
  ]);

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    if (files.length) appendFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (cameraInputRef.current) cameraInputRef.current.value = "";
  };

  const reset = useCallback(() => {
    clearFillTimeouts();
    clearLabObservationMarks();
    revokeAll(queuedRef.current);
    setQueued([]);
    setPreview(null);
    setStatus("idle");
    setError("");
    setFilledValueCount(0);
    setLowConfidenceCount(0);
    setKeepDocs(true);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (cameraInputRef.current) cameraInputRef.current.value = "";
  }, []);

  if (disabled || !enabled) return null;

  const staging = status === "idle" || status === "error";
  const busy = status === "processing" || status === "filling";
  const noValuesFilled = filledValueCount === 0;

  return (
    <div className="care-ai-vision-container">
      <div className="w-full space-y-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.pdf,application/pdf"
          multiple
          className="hidden"
          onChange={onInputChange}
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="hidden"
          onChange={onInputChange}
        />

        {staging && queued.length === 0 && (
          <div className="flex flex-col gap-3 rounded-lg border border-blue-200 bg-blue-50/70 px-4 py-3 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-blue-900">
                {t("autofill_from")}
              </p>
              <p className="text-sm text-gray-800">
                {t("autofill_from_description")}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="white"
                size="sm"
                className="gap-2 md:hidden"
                onClick={() => cameraInputRef.current?.click()}
              >
                <Camera className="h-4 w-4" />
                {t("take_photo")}
              </Button>
              <Button
                type="button"
                variant="white"
                size="sm"
                className="gap-2"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="h-4 w-4" />
                {t("upload_files")}
              </Button>
            </div>
          </div>
        )}

        {staging && queued.length > 0 && (
          <div className="space-y-4 rounded-lg border border-blue-200 bg-blue-50/70 p-4">
            <div>
              <p className="text-sm font-semibold text-blue-900">
                {t("docs_ready_to_autofill", { count: queued.length })}
              </p>
              <p className="text-sm text-gray-800">
                {t("docs_ready_to_autofill_description")}
              </p>
            </div>

            {status === "error" && (
              <div className="flex items-center gap-2 text-sm text-red-600">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {queued.map((item, i) => (
                <div
                  key={fileKey(item.file)}
                  className="flex overflow-hidden rounded-md border border-gray-300 bg-white"
                >
                  <button
                    type="button"
                    className="block"
                    onClick={() => {
                      if (!item.url) return;
                      if (item.file.type.startsWith("image/")) {
                        setPreview(item);
                      } else {
                        window.open(item.url, "_blank", "noopener");
                      }
                    }}
                  >
                    {item.file.type.startsWith("image/") && item.url ? (
                      <img
                        src={item.url}
                        alt=""
                        className="size-10 object-cover hover:opacity-80"
                      />
                    ) : (
                      <span className="flex size-10 items-center justify-center text-blue-600">
                        <FileText className="h-5 w-5" />
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    className="flex items-center border-l border-gray-200 px-2 text-gray-500 hover:bg-gray-50 hover:text-gray-800"
                    title={t("remove_page")}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <Button
                type="button"
                variant="white"
                size="sm"
                className="h-10 gap-2 md:hidden"
                onClick={() => cameraInputRef.current?.click()}
              >
                <Camera className="h-4 w-4" />
                {t("take_photo")}
              </Button>
              <Button
                type="button"
                variant="white"
                size="sm"
                className="h-10 gap-2"
                onClick={() => fileInputRef.current?.click()}
              >
                <Plus className="h-4 w-4" />
                {t("add_files")}
              </Button>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-800">
                <input
                  type="checkbox"
                  checked={keepDocs}
                  onChange={(e) => setKeepDocs(e.target.checked)}
                  className="size-4 rounded border-primary-500 bg-gray-200 checked:bg-primary-700 focus:ring-primary-800"
                />
                {t("keep_docs_with_report")}
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="white" size="sm" onClick={reset}>
                  {t("discard")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="bg-green-800 text-white hover:bg-green-900"
                  onClick={extract}
                >
                  <Sparkles className="h-4 w-4" />
                  {t("autofill_from_n_docs", { count: queued.length })}
                </Button>
              </div>
            </div>
          </div>
        )}

        {staging && queued.length === 0 && status === "error" && (
          <div className="flex items-center gap-2 text-sm text-red-600">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {busy && <ExtractionLoader status={status} />}

        {status === "success" && (
          <div
            className={
              noValuesFilled
                ? "flex flex-col gap-3 rounded-lg border border-red-600 bg-red-50 px-4 py-3 md:flex-row md:items-center md:justify-between"
                : "flex flex-col gap-3 rounded-lg border border-green-600 bg-green-50 px-4 py-3 md:flex-row md:items-center md:justify-between"
            }
          >
            <div className="flex min-w-0 items-center gap-2">
              <MatrixSpinner
                name={noValuesFilled ? "grid-tilt" : "spin-check"}
                size="20"
                className={
                  noValuesFilled
                    ? "shrink-0 text-red-800"
                    : "shrink-0 text-green-900"
                }
              />
              <div>
                <p
                  className={
                    noValuesFilled
                      ? "text-sm font-medium text-red-800"
                      : "text-sm font-medium text-green-900"
                  }
                >
                  {t("values_filled_from_pages", {
                    count: filledValueCount,
                    pages: queued.length,
                  })}
                </p>
                {noValuesFilled ? (
                  <p className="text-sm text-red-700">
                    {t("no_values_extracted")}
                  </p>
                ) : (
                  lowConfidenceCount > 0 && (
                    <p className="text-sm text-green-800">
                      {t("low_confidence_values", {
                        count: lowConfidenceCount,
                      })}
                    </p>
                  )
                )}
              </div>
            </div>
            <ButtonGroup className="md:hidden" aria-label={t("add_files")}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => cameraInputRef.current?.click()}
              >
                <Camera />
                {t("add_photo")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                <Plus />
                {t("add_files")}
              </Button>
            </ButtonGroup>
            <ButtonGroup className="hidden md:flex" aria-label={t("add_files")}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                <Plus />
                {t("add_files")}
              </Button>
            </ButtonGroup>
          </div>
        )}
      </div>
      {preview?.url &&
        createPortal(
          <div className="care-ai-vision-container">
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
              onClick={() => setPreview(null)}
            >
              <button
                type="button"
                className="absolute top-4 right-4 rounded-full bg-white/90 p-1.5 text-gray-800"
                onClick={() => setPreview(null)}
              >
                <X className="h-5 w-5" />
              </button>
              <img
                src={preview.url}
                alt=""
                className="max-h-[85vh] max-w-full rounded object-contain"
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function useExtractionMessage(status: Status) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (status === "processing") {
      setIndex(0);
      const id = window.setInterval(() => {
        setIndex((current) => (current === 0 ? 2 : 0));
      }, 2400);
      return () => window.clearInterval(id);
    }
    if (status === "filling") {
      setIndex(1);
      const id = window.setInterval(() => {
        setIndex((current) => Math.min(current + 1, 3));
      }, 1400);
      return () => window.clearInterval(id);
    }
    setIndex(0);
  }, [status]);

  return EXTRACTION_MESSAGE_KEYS[index];
}

function ExtractionLoader({ status }: { status: Status }) {
  const { t } = useTranslation();
  const messageKey = useExtractionMessage(status);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50/70 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="flex items-center gap-2 text-sm text-blue-500">
          <PixelSpinner
            name="braille"
            size="19"
            className="shrink-0 text-blue-800"
          />
          <span className="font-semibold text-blue-900">{t(messageKey)}</span>
        </div>
        <p className="text-sm text-blue-900 italic">
          {t("please_wait_while_we_fill")}
        </p>
      </div>
    </div>
  );
}
