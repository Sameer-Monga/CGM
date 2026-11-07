import {
  Camera,
  CheckCircle2,
  ChevronDown,
  FileText,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useAiVisionEnabled } from "@/hooks/useAiVisionEnabled";
import useAuthUser from "@/hooks/useAuthUser";
import { useDraggableFab } from "@/hooks/useDraggableFab";
import { useTranslation } from "@/hooks/useTranslation";
import {
  ExtractedData,
  extractDataFromImage,
  highlightField,
  normalizeBloodGroup,
  normalizeIsoDate,
  normalizePhone,
  normalizePincode,
  resolveGeoOrganization,
} from "@/lib/ocr";

type Status = "idle" | "processing" | "filling" | "success" | "error";

const FIELD_FILL_DELAY_MS = 350;

interface FormLike {
  setValue: (
    field: string,
    value: string | number | boolean,
    options?: { shouldValidate?: boolean; shouldDirty?: boolean },
  ) => void;
  clearErrors?: (name?: string | string[]) => void;
}

interface FillStep {
  field: string;
  apply: () => void;
}

export default function OCRFormFill({
  form,
  facilityId,
  patientId,
}: {
  form: FormLike;
  facilityId?: string;
  patientId?: string;
  submitForm?: () => void;
  __meta?: {
    [key: string]: unknown;
  };
}) {
  const { t } = useTranslation();
  const user = useAuthUser();
  const { enabled } = useAiVisionEnabled();

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [filledCount, setFilledCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [transcriptMinimized, setTranscriptMinimized] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastFileRef = useRef<File | null>(null);
  const fillTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const fabDrag = useDraggableFab(user.id ?? null);
  const fabDragStyle = {
    transform: `translate3d(${fabDrag.offset.x}px, ${fabDrag.offset.y}px, 0)`,
    touchAction: "none",
    cursor: fabDrag.isDragging ? "grabbing" : undefined,
  } as const;

  const clearFillTimeouts = () => {
    fillTimeoutsRef.current.forEach(clearTimeout);
    fillTimeoutsRef.current = [];
  };
  useEffect(() => clearFillTimeouts, []);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  const setField = useCallback(
    (field: string, value: string | number | boolean) => {
      form.setValue(field, value, { shouldValidate: false, shouldDirty: true });
    },
    [form],
  );

  const buildFillSteps = useCallback(
    async (data: ExtractedData): Promise<FillStep[]> => {
      const steps: FillStep[] = [];

      if (data.name) {
        steps.push({
          field: "name",
          apply: () => setField("name", data.name!),
        });
      }

      const phone = normalizePhone(data.phone_number);
      if (phone) {
        steps.push({
          field: "phone_number",
          apply: () => setField("phone_number", phone),
        });
      }

      const emergencyPhone = normalizePhone(data.emergency_phone_number);
      if (emergencyPhone) {
        steps.push({
          field: "emergency_phone_number",
          apply: () => setField("emergency_phone_number", emergencyPhone),
        });
      }

      if (
        data.gender &&
        ["male", "female", "transgender", "non_binary"].includes(data.gender)
      ) {
        steps.push({
          field: "gender",
          apply: () => setField("gender", data.gender!),
        });
      }

      const dob = normalizeIsoDate(data.date_of_birth);
      if (dob) {
        steps.push({
          field: "date_of_birth",
          apply: () => {
            setField("date_of_birth", dob);
            setField("age_or_dob", "dob");
          },
        });
      } else if (data.age) {
        steps.push({
          field: "age",
          apply: () => {
            setField("age", Number(data.age));
            setField("age_or_dob", "age");
          },
        });
      }

      const bloodGroup = normalizeBloodGroup(data.blood_group);
      if (bloodGroup) {
        steps.push({
          field: "blood_group",
          apply: () => setField("blood_group", bloodGroup),
        });
      }

      if (data.address) {
        steps.push({
          field: "address",
          apply: () => setField("address", data.address!),
        });
      }

      const sameAddress =
        data.permanent_address &&
        data.address &&
        data.permanent_address.trim() === data.address.trim();

      if (data.permanent_address && !sameAddress) {
        steps.push({
          field: "permanent_address",
          apply: () => {
            setField("permanent_address", data.permanent_address!);
            setField("permanent_address_same_as_address", false);
          },
        });
      } else if (data.permanent_address || data.address) {
        steps.push({
          field: "permanent_address",
          apply: () => {
            setField(
              "permanent_address",
              (data.address ?? data.permanent_address)!,
            );
            setField("permanent_address_same_as_address", true);
          },
        });
      }

      const pincode = normalizePincode(data.pincode);
      if (pincode) {
        steps.push({
          field: "pincode",
          apply: () => setField("pincode", pincode),
        });
      }

      // Resolve governance hierarchy (state → district → local body → ward)
      if (data.state || data.district || data.local_body || data.ward) {
        try {
          const geoResult = await resolveGeoOrganization(data);
          if (geoResult) {
            steps.push({
              field: "geo_organization",
              apply: () => {
                setField("geo_organization", geoResult.id);
                setField(
                  "_selected_levels",
                  geoResult.levels as unknown as string,
                );
              },
            });
          }
        } catch {
          // Governance resolution failed silently — user can select manually
        }
      }

      return steps;
    },
    [setField],
  );

  const runFillAnimation = useCallback(
    (steps: FillStep[]) => {
      clearFillTimeouts();
      setFilledCount(0);
      setTotalCount(steps.length);

      if (steps.length === 0) {
        form.clearErrors?.();
        setStatus("success");
        return;
      }

      setStatus("filling");
      steps.forEach((step, index) => {
        const timeoutId = setTimeout(() => {
          step.apply();
          requestAnimationFrame(() => highlightField(step.field));
          setFilledCount(index + 1);
          if (index === steps.length - 1) {
            form.clearErrors?.();
            setStatus("success");
          }
        }, index * FIELD_FILL_DELAY_MS);
        fillTimeoutsRef.current.push(timeoutId);
      });
    },
    [form],
  );

  const processImage = useCallback(
    async (file: File) => {
      lastFileRef.current = file;
      clearFillTimeouts();
      setStatus("processing");
      setError("");
      setFilledCount(0);
      setTotalCount(0);
      setTranscript("");
      setTranscriptMinimized(false);
      setPreview(
        file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      );

      try {
        const data = await extractDataFromImage(
          file,
          facilityId,
          setTranscript,
        );
        const steps = await buildFillSteps(data);
        runFillAnimation(steps);
      } catch (e: unknown) {
        const message =
          e instanceof Error ? e.message : "Failed to process image";
        setError(message);
        setStatus("error");
      }
    },
    [buildFillSteps, runFillAnimation, facilityId],
  );

  const handleFile = useCallback(
    (file?: File) => {
      if (!file) return;
      if (!file.type.startsWith("image/") && file.type !== "application/pdf") {
        setError(t("upload_image_error"));
        setStatus("error");
        return;
      }
      processImage(file);
    },
    [processImage, t],
  );

  const reset = () => {
    clearFillTimeouts();
    setStatus("idle");
    setError("");
    setFilledCount(0);
    setTotalCount(0);
    setTranscript("");
    setTranscriptMinimized(false);
    setPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  if (patientId) return null;

  if (!enabled) {
    return null;
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.pdf,application/pdf"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          handleFile(e.target.files?.[0]);
          if (fileInputRef.current) fileInputRef.current.value = "";
        }}
      />

      {createPortal(
        <div className="care-ai-vision-container">
          <div
            ref={fabDrag.containerRef}
            className="ocr-pop-in fixed right-4 bottom-4 z-50 flex flex-col items-end gap-3 sm:right-6 sm:bottom-6"
            style={fabDragStyle}
            onPointerDown={fabDrag.onPointerDown}
            onClickCapture={fabDrag.onClickCapture}
            onDoubleClick={fabDrag.resetPosition}
          >
            <LongPressIndicator progress={fabDrag.longPressProgress} />

            {status === "processing" && transcript && !transcriptMinimized && (
              <div className="w-72 overflow-hidden rounded-2xl border border-gray-100 bg-white/95 shadow-xl backdrop-blur">
                <div className="flex items-center justify-between border-b border-gray-100 bg-linear-to-r from-blue-100 to-transparent px-3 py-2.5">
                  <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wide text-gray-500 uppercase">
                    <FileText className="h-3 w-3" />
                    {t("transcript")}
                  </span>
                  <button
                    onClick={() => setTranscriptMinimized(true)}
                    className="rounded-md p-0.5 text-gray-400 hover:bg-gray-100"
                    title={t("minimize_transcript")}
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="max-h-28 overflow-y-auto px-3 py-2.5 text-xs leading-relaxed whitespace-pre-line text-gray-600">
                  {transcript}
                </p>
              </div>
            )}

            {status === "idle" && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="group relative flex items-center gap-2 overflow-hidden rounded-full py-3 pr-5 pl-4 text-white shadow-lg transition-all bg-linear-to-br from-blue-500 via-blue-600 to-blue-700 shadow-blue-600/25 hover:shadow-xl hover:shadow-blue-600/35 hover:brightness-110 active:scale-95"
                title={t("scan_registration_form")}
              >
                <span className="ocr-spin-slow pointer-events-none absolute -inset-16 scale-150 rounded-full bg-[conic-gradient(from_0deg,transparent,rgba(255,255,255,0.35),transparent)] opacity-60" />
                <Camera className="relative h-5 w-5" />
                <span className="relative text-sm font-semibold">
                  {t("ai_vision")}
                </span>
                <Sparkles className="relative h-4 w-4 opacity-80" />
              </button>
            )}

            {(status === "processing" || status === "filling") && (
              <div className="flex flex-col items-center gap-2">
                <p className="ocr-shimmer-text text-xs font-medium">
                  {status === "processing"
                    ? t("extracting_details")
                    : t("filling_fields", { count: totalCount })}
                </p>
                <AiOrb preview={preview} />
                {status === "processing" &&
                  transcript &&
                  transcriptMinimized && (
                    <button
                      onClick={() => setTranscriptMinimized(false)}
                      className="flex items-center gap-1 text-[10px] font-medium text-blue-600 hover:text-blue-800"
                    >
                      <FileText className="h-2.5 w-2.5" />
                      {t("show_transcript")}
                    </button>
                  )}
              </div>
            )}

            {status === "success" && (
              <div className="flex items-center gap-2 rounded-full border border-blue-100 bg-white py-2 pr-2 pl-3 shadow-xl">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-white">
                  <CheckCircle2 className="h-4 w-4" />
                </span>
                <span className="text-sm font-semibold whitespace-nowrap text-blue-800">
                  {t("extracted_fields", { count: filledCount })}
                </span>
                <button
                  onClick={reset}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100"
                  title={t("done")}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            {status === "error" && (
              <div className="flex items-center gap-2 rounded-full border border-red-100 bg-white py-2 pr-2 pl-3 shadow-xl">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-red-500" />
                <span className="text-sm font-medium whitespace-nowrap text-red-800">
                  {error}
                </span>
                <button
                  onClick={() => {
                    if (lastFileRef.current) processImage(lastFileRef.current);
                    else reset();
                  }}
                  className="rounded-full px-3 py-1 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-100"
                >
                  {t("try_again")}
                </button>
                <button
                  onClick={reset}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function LongPressIndicator({ progress }: { progress: number }) {
  const { t } = useTranslation();
  if (progress <= 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <div className="absolute top-0 bottom-0 right-0.5 -left-0.5 overflow-hidden rounded-3xl ring-2 ring-blue-500">
        <div
          className="absolute inset-y-0 left-0 bg-blue-600/30"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      <span className="absolute top-full bg-transparent left-1/2 mt-1 -translate-x-1/2 truncate px-2 py-0.5 text-[10px] text-gray-500 italic sm:text-xs">
        {t("resetting_position")}
      </span>
    </div>
  );
}

function AiOrb({ preview }: { preview: string | null }) {
  return (
    <div className="relative flex h-20 w-20 items-center justify-center">
      <span className="ocr-glow absolute h-14 w-14 rounded-full bg-blue-400/40 blur-xl" />

      <svg
        className="ocr-spin-slow absolute inset-0 h-full w-full"
        viewBox="0 0 80 80"
        fill="none"
      >
        <defs>
          <linearGradient
            id="ocr-arc-outer"
            gradientUnits="userSpaceOnUse"
            x1="4"
            y1="40"
            x2="76"
            y2="40"
          >
            <stop offset="0%" stopColor="#60a5fa" stopOpacity="0" />
            <stop offset="100%" stopColor="#2563eb" stopOpacity="0.9" />
          </linearGradient>
        </defs>
        <circle
          cx="40"
          cy="40"
          r="36"
          stroke="url(#ocr-arc-outer)"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray="158 68"
        />
      </svg>

      <svg
        className="absolute inset-2 h-[calc(100%-1rem)] w-[calc(100%-1rem)]"
        style={{ animation: "ocr-spin 2.6s linear infinite reverse" }}
        viewBox="0 0 64 64"
        fill="none"
      >
        <defs>
          <linearGradient
            id="ocr-arc-inner"
            gradientUnits="userSpaceOnUse"
            x1="4"
            y1="32"
            x2="60"
            y2="32"
          >
            <stop offset="0%" stopColor="#93c5fd" stopOpacity="0" />
            <stop offset="100%" stopColor="#93c5fd" stopOpacity="0.85" />
          </linearGradient>
        </defs>
        <circle
          cx="32"
          cy="32"
          r="28"
          stroke="url(#ocr-arc-inner)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray="110 66"
        />
      </svg>

      <div className="relative z-10 flex h-14 w-14 items-center justify-center overflow-hidden rounded-full">
        {preview ? (
          <img
            src={preview}
            alt=""
            className="size-12 rounded-full object-cover"
          />
        ) : (
          <>
            <span className="ocr-orb absolute h-8 w-8 rounded-full bg-blue-400/50 blur-md" />
            <Camera className="ocr-star-blink relative h-5 w-5 text-white drop-shadow-[0_0_6px_#2563eb]" />
          </>
        )}
      </div>
    </div>
  );
}
