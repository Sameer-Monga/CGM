const BLOOD_GROUP_BY_NOTATION: Record<string, string> = {
  "A+": "A_positive",
  "A-": "A_negative",
  "B+": "B_positive",
  "B-": "B_negative",
  "AB+": "AB_positive",
  "AB-": "AB_negative",
  "O+": "O_positive",
  "O-": "O_negative",
};

export function normalizeBloodGroup(value?: string): string | undefined {
  if (!value) return undefined;
  const compact = value.trim().replace(/\s+/g, "");
  const fromNotation = BLOOD_GROUP_BY_NOTATION[compact.toUpperCase()];
  if (fromNotation) return fromNotation;

  const named = compact.match(/^(AB|A|B|O)_(positive|negative)$/i);
  if (named) return `${named[1].toUpperCase()}_${named[2].toLowerCase()}`;

  if (compact.toLowerCase() === "unknown" || compact.toUpperCase() === "UNK") {
    return "unknown";
  }
  return undefined;
}

export const BLOOD_GROUP_MAP = BLOOD_GROUP_BY_NOTATION;

export function normalizePhone(phone?: string): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/[^+\d]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+91${digits}`;
  return `+91${digits}`;
}

export function normalizeIsoDate(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return undefined;
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, "0");
  const d = String(parsed.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function normalizePincode(value?: string | number): number | undefined {
  if (value == null || value === "") return undefined;
  const digits = String(value).replace(/\D/g, "");
  if (!digits) return undefined;
  return Number(digits);
}

const HIGHLIGHT_CLASS = "ocr-field-highlight";
const AUTOFILLED_CLASS = "ocr-autofilled";
const CHECK_CLASS = "ocr-check-this";
const WRAPPER_CLASS = "ocr-fill-wrap";
const BADGE_CLASS = "ocr-fill-badge";

export type FillMark = "autofilled" | "check_this";

export interface FillMarkLabels {
  autofilled: string;
  checkThis: string;
}

type LabHighlightDef = {
  id: string;
  title?: string;
  code?: { code?: string; display?: string };
  component?: { code: { code: string; display?: string } }[];
};

type MarkedLabField = {
  definition: LabHighlightDef;
  kind: "value" | "unit";
  componentCode?: string;
  mark: FillMark;
  labels: FillMarkLabels;
};

const markedLabFields = new Map<string, MarkedLabField>();
const boundInputs = new WeakSet<HTMLElement>();
let markObserver: MutationObserver | null = null;
let reapplyRaf = 0;

export function highlightElement(el: HTMLElement | null | undefined): void {
  if (!el) return;

  el.classList.remove(HIGHLIGHT_CLASS);
  void el.offsetWidth;
  el.classList.add(HIGHLIGHT_CLASS);
  el.scrollIntoView({ behavior: "smooth", block: "center" });

  setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), 1200);
}

const FIELD_FALLBACK_RESOLVERS: Record<string, () => HTMLElement | null> = {
  date_of_birth: () => {
    const year = document.querySelector<HTMLElement>(
      'input[placeholder="YYYY"]',
    );
    return year?.parentElement?.parentElement ?? year;
  },
};

function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1) return false;
  const style = getComputedStyle(el);
  return (
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    parseFloat(style.opacity) !== 0
  );
}

export function highlightField(field: string): void {
  const named = [
    ...document.querySelectorAll<HTMLElement>(`[name="${CSS.escape(field)}"]`),
  ];
  let target = named.find(isVisible) ?? null;

  if (!target && named.length) {
    const hidden =
      named.find((el) => (el as HTMLInputElement).checked) ?? named[0];
    target =
      hidden.parentElement?.querySelector<HTMLElement>(
        '[role="combobox"], [role="radio"]',
      ) ?? null;
  }

  if (!target) {
    const resolver = FIELD_FALLBACK_RESOLVERS[field];
    if (resolver) target = resolver();
  }

  highlightElement(target);
}

function labFieldKey(
  definition: LabHighlightDef,
  kind: "value" | "unit",
  componentCode?: string,
): string {
  return `${definition.id}::${kind}::${componentCode ?? ""}`;
}

export function findLabObservationElement(
  definition: LabHighlightDef,
  kind: "value" | "unit",
  componentCode?: string,
): HTMLElement | null {
  const heading =
    definition.title || definition.code?.display || definition.code?.code;
  if (!heading) return null;

  const headingLabel = [...document.querySelectorAll("label")].find(
    (label) => label.textContent?.trim() === heading,
  );
  const card = headingLabel?.closest(".rounded-lg") as HTMLElement | null;
  if (!card) return null;

  let scope: ParentNode = card;
  if (componentCode) {
    const componentIndex =
      definition.component?.findIndex((c) => c.code.code === componentCode) ??
      -1;
    const comp =
      componentIndex >= 0 ? definition.component?.[componentIndex] : undefined;
    const name = comp?.code.display || comp?.code.code || componentCode;

    const candidates = [...card.querySelectorAll("label")].filter(
      (label) => label !== headingLabel,
    );
    const compLabel =
      candidates.find(
        (label) =>
          label.textContent?.trim() === `${componentIndex + 1}. ${name}`,
      ) ?? candidates.find((label) => (label.textContent || "").includes(name));
    if (compLabel?.parentElement) scope = compLabel.parentElement;
  }

  return kind === "unit"
    ? scope.querySelector<HTMLElement>('[role="combobox"]')
    : scope.querySelector<HTMLElement>("input");
}

export function highlightLabObservation(
  definition: LabHighlightDef,
  kind: "value" | "unit",
  componentCode?: string,
): void {
  highlightElement(findLabObservationElement(definition, kind, componentCode));
}

function undecorate(el: HTMLElement): void {
  el.classList.remove(AUTOFILLED_CLASS, CHECK_CLASS);
  const parent = el.parentElement;
  if (!parent) return;
  parent.querySelectorAll(`:scope > .${BADGE_CLASS}`).forEach((badge) => {
    badge.remove();
  });
  if (!parent.querySelector(`.${AUTOFILLED_CLASS}, .${CHECK_CLASS}`)) {
    parent.classList.remove(WRAPPER_CLASS);
  }
}

function decorate(
  el: HTMLElement,
  mark: FillMark,
  labels: FillMarkLabels,
): void {
  const markClass = mark === "check_this" ? CHECK_CLASS : AUTOFILLED_CLASS;
  if (!el.classList.contains(markClass)) {
    el.classList.remove(AUTOFILLED_CLASS, CHECK_CLASS);
    el.classList.add(markClass);
  }

  const parent = el.parentElement;
  if (!parent) return;
  parent.classList.add(WRAPPER_CLASS);
  if (getComputedStyle(parent).position === "static") {
    parent.style.position = "relative";
  }

  let badge = parent.querySelector<HTMLElement>(`:scope > .${BADGE_CLASS}`);
  if (!badge) {
    badge = document.createElement("span");
    badge.className = BADGE_CLASS;
    badge.setAttribute("aria-hidden", "true");
    parent.appendChild(badge);
  }
  badge.dataset.ocrMark = mark;
  badge.textContent =
    mark === "check_this" ? labels.checkThis : labels.autofilled;

  const inputRect = el.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  badge.style.top = `${inputRect.top - parentRect.top + inputRect.height / 2}px`;
  badge.style.right = `${parentRect.right - inputRect.right + 8}px`;
}

function onMarkedInput(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  for (const [key, entry] of markedLabFields) {
    const el = findLabObservationElement(
      entry.definition,
      entry.kind,
      entry.componentCode,
    );
    if (el !== target) continue;
    markedLabFields.delete(key);
    undecorate(el);
    if (!markedLabFields.size) stopMarkObserver();
    break;
  }
}

function bindEditListener(el: HTMLElement): void {
  if (boundInputs.has(el)) return;
  boundInputs.add(el);
  el.addEventListener("input", onMarkedInput);
  el.addEventListener("change", onMarkedInput);
}

function reapplyLabMarks(): void {
  for (const entry of markedLabFields.values()) {
    const el = findLabObservationElement(
      entry.definition,
      entry.kind,
      entry.componentCode,
    );
    if (!el) continue;
    decorate(el, entry.mark, entry.labels);
    bindEditListener(el);
  }
}

function scheduleReapplyLabMarks(): void {
  if (reapplyRaf) return;
  reapplyRaf = requestAnimationFrame(() => {
    reapplyRaf = 0;
    reapplyLabMarks();
  });
}

function ensureMarkObserver(): void {
  if (markObserver || typeof MutationObserver === "undefined") return;
  const root =
    document.querySelector(".care-ai-vision-container")?.parentElement ??
    document.body;
  markObserver = new MutationObserver(() => scheduleReapplyLabMarks());
  markObserver.observe(root, { childList: true, subtree: true });
}

function stopMarkObserver(): void {
  markObserver?.disconnect();
  markObserver = null;
}

export function persistLabObservationMark(
  definition: LabHighlightDef,
  kind: "value" | "unit",
  mark: FillMark,
  labels: FillMarkLabels,
  componentCode?: string,
): void {
  markedLabFields.set(labFieldKey(definition, kind, componentCode), {
    definition,
    kind,
    componentCode,
    mark,
    labels,
  });
  ensureMarkObserver();
  const el = findLabObservationElement(definition, kind, componentCode);
  if (!el) return;
  decorate(el, mark, labels);
  bindEditListener(el);
  el.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function clearLabObservationMarks(): void {
  const elements = [
    ...document.querySelectorAll<HTMLElement>(
      `.${AUTOFILLED_CLASS}, .${CHECK_CLASS}`,
    ),
  ];
  markedLabFields.clear();
  stopMarkObserver();
  elements.forEach(undecorate);
  document
    .querySelectorAll(`.${BADGE_CLASS}`)
    .forEach((badge) => badge.remove());
  document.querySelectorAll(`.${WRAPPER_CLASS}`).forEach((wrap) => {
    wrap.classList.remove(WRAPPER_CLASS);
  });
}
