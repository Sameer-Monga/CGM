import { MedispeakFieldSpec, runMedispeakOcr } from "./medispeak";
import { ExtractedData } from "./types";

const REGISTRATION_FORM_FIELDS: MedispeakFieldSpec[] = [
  { key: "name", label: "Patient full name", type: "string" },
  {
    key: "phone_number",
    label: "Phone number",
    type: "string",
    description: 'With country code, e.g. "+911234567890"',
  },
  {
    key: "emergency_phone_number",
    label: "Emergency contact phone number",
    type: "string",
    description: "With country code",
  },
  {
    key: "gender",
    label: "Gender",
    type: "single_select",
    enum: ["male", "female", "transgender", "non_binary"],
  },
  {
    key: "date_of_birth",
    label: "Date of birth",
    type: "string",
    description:
      'Full date in "YYYY-MM-DD" format, only if a full date is visible',
  },
  {
    key: "age",
    label: "Age in years",
    type: "number",
    description: "Only if just an age is written, not a full date of birth",
  },
  {
    key: "blood_group",
    label: "Blood group",
    type: "string",
    description: 'e.g. "A+", "B-", "O+", "AB+"',
  },
  { key: "address", label: "Current address", type: "string" },
  { key: "permanent_address", label: "Permanent address", type: "string" },
  { key: "pincode", label: "PIN/ZIP code", type: "number" },
  { key: "state", label: "State", type: "string" },
  { key: "district", label: "District", type: "string" },
  {
    key: "local_body",
    label: "Local body / municipality / panchayat",
    type: "string",
  },
  { key: "ward", label: "Ward name or number", type: "string" },
];

export async function extractDataFromImage(
  imageFile: File,
  facilityId?: string | null,
  onTranscript?: (text: string) => void,
): Promise<ExtractedData> {
  const result = await runMedispeakOcr(
    imageFile,
    { facilityId, fields: REGISTRATION_FORM_FIELDS },
    { onTranscript },
  );
  return result as ExtractedData;
}

interface LabDefinitionLike {
  id: string;
  title?: string;
  code?: { code: string; display?: string };
  component?: { code: { code: string; display?: string } }[];
  permitted_unit?: { code: string; display?: string; system?: string } | null;
}

export interface LabFieldTarget {
  definitionId: string;
  kind: "value" | "unit";
  componentCode?: string;
}

export type LabFieldKeyMap = Record<string, LabFieldTarget>;

function slugCode(code?: string): string {
  return (code ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function definitionAliases(definitions: LabDefinitionLike[]): string[] {
  const used = new Set<string>();
  return definitions.map((d, i) => {
    const preferred = slugCode(d.code?.code);
    let alias = preferred && !used.has(preferred) ? preferred : `f${i}`;
    if (used.has(alias)) {
      let n = i;
      while (used.has(`f${n}`)) n += 1;
      alias = `f${n}`;
    }
    used.add(alias);
    return alias;
  });
}

function uniqueComponentSlug(
  code: string,
  index: number,
  used: Set<string>,
): string {
  const preferred = slugCode(code);
  let alias = preferred && !used.has(preferred) ? preferred : `c${index}`;
  if (used.has(alias)) {
    let n = index;
    while (used.has(`c${n}`)) n += 1;
    alias = `c${n}`;
  }
  used.add(alias);
  return alias;
}

function canonicalLabKey(target: LabFieldTarget): string {
  const prefix = target.componentCode
    ? `${target.definitionId}__${target.componentCode}`
    : target.definitionId;
  return `${prefix}__${target.kind}`;
}

/** Medispeak form fields are typed; we ask for 0–1, but models sometimes emit 0–100. */
function parseConfidence(raw: unknown): number | undefined {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim()
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(n)) return undefined;
  const unit = n > 1 && n <= 100 ? n / 100 : n;
  return Math.min(1, Math.max(0, unit));
}

function remapLabResult(
  result: Record<string, unknown>,
  keyMap: LabFieldKeyMap,
): Record<string, unknown> {
  const remapped: Record<string, unknown> = {};
  for (const [shortKey, value] of Object.entries(result)) {
    const target = keyMap[shortKey];
    if (!target) continue;
    remapped[canonicalLabKey(target)] = value;
  }
  for (const [shortKey, target] of Object.entries(keyMap)) {
    if (target.kind !== "value") continue;
    const confidence = parseConfidence(result[`${shortKey}c`]);
    if (confidence == null) continue;
    const canon = canonicalLabKey(target);
    remapped[canon] = { value: remapped[canon], confidence };
  }
  return remapped;
}

export function buildLabFieldSpecs(definitions: LabDefinitionLike[]): {
  specs: MedispeakFieldSpec[];
  keyMap: LabFieldKeyMap;
} {
  const specs: MedispeakFieldSpec[] = [];
  const keyMap: LabFieldKeyMap = {};
  const aliases = definitionAliases(definitions);

  const addPair = (
    alias: string,
    target: Omit<LabFieldTarget, "kind">,
    labelBase: string,
    description?: string,
  ) => {
    const valueKey = `${alias}_v`;
    const unitKey = `${alias}_u`;
    keyMap[valueKey] = { ...target, kind: "value" };
    keyMap[unitKey] = { ...target, kind: "unit" };
    specs.push({
      key: valueKey,
      label: `${labelBase} value`,
      type: "string",
      description,
    });
    specs.push({
      key: `${valueKey}c`,
      label: `${labelBase} value confidence`,
      type: "number",
      description:
        "How sure you are of this extracted value, from 0 (illegible or guessed) to 1 (clearly readable). Always set when the value is filled.",
    });
    specs.push({
      key: unitKey,
      label: `${labelBase} unit`,
      type: "string",
    });
  };

  definitions.forEach((d, i) => {
    const alias = aliases[i];
    const name = d.title || d.code?.display || d.code?.code || `field ${i}`;
    if (d.component?.length) {
      const usedComps = new Set<string>();
      d.component.forEach((c, j) => {
        const compSlug = uniqueComponentSlug(c.code.code, j, usedComps);
        const compName = c.code.display || c.code.code;
        addPair(
          `${alias}_${compSlug}`,
          { definitionId: d.id, componentCode: c.code.code },
          `${name} - ${compName}`,
        );
      });
      return;
    }
    addPair(
      alias,
      { definitionId: d.id },
      name,
      d.permitted_unit
        ? `Numeric or text result; expected unit: ${d.permitted_unit.code}`
        : undefined,
    );
  });

  return { specs, keyMap };
}

export async function extractLabResults(
  files: File | File[],
  definitions: LabDefinitionLike[],
  facilityId?: string | null,
): Promise<Record<string, unknown>> {
  const { specs, keyMap } = buildLabFieldSpecs(definitions);
  const result = await runMedispeakOcr(files, {
    facilityId,
    fields: specs,
  });
  return remapLabResult(result, keyMap);
}
