import { FILLY_BASE_URL } from "@/lib/filly-be";
import { readPluginConfig } from "@/lib/plugin-config";
import { getHeaders } from "@/lib/request";

/**
 * Talks directly to Medispeak for the document/OCR pipeline — the browser
 * never holds the account secret. A session + scoped token are minted by
 * care_filly (the only routes that hold `MEDISPEAK_API_KEY`); the image
 * upload, commit and result polling go straight to Medispeak using that
 * short-lived, session-scoped token, mirroring care_filly_fe's ASR flow but
 * for a `modality: "document"` session with a typed "form" output — this
 * gets Medispeak's schema-constrained structured extraction instead of
 * hoping a freeform prompt makes the model emit valid embedded JSON.
 */

export interface MedispeakSessionHandle {
  sessionId: string;
  medispeakSessionId: string;
  token: string;
}

/** A Medispeak `outputs: [{type: "form", fields}]` field definition. */
export interface MedispeakFieldSpec {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "single_select" | "multi_select";
  enum?: string[];
  description?: string;
}

interface CreateParams {
  facilityId?: string | null;
  fields: MedispeakFieldSpec[];
}

class MedispeakAuthError extends Error {}

/** A Medispeak error envelope's `code`, e.g. `"document_upload_failed"`. */
export class MedispeakApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * The Medispeak API root. Resolved at call time, in order:
 *
 *   1. `MEDISPEAK_API_URL` in this plugin's config, set when it is
 *      registered in CARE — changing it needs no rebuild.
 *   2. `REACT_MEDISPEAK_API_URL`, baked in at build time. Local dev only.
 *
 * Never cache this at module scope: care_fe publishes the plugin config
 * from an effect after the configs load, so an import-time read is empty.
 */
function requireMedispeakBase(): string {
  const configured =
    readPluginConfig("MEDISPEAK_API_URL") ??
    readPluginConfig("REACT_MEDISPEAK_API_URL") ??
    (import.meta.env.REACT_MEDISPEAK_API_URL || "").toString();

  const baseUrl = configured.trim().replace(/\/$/, "");
  if (!baseUrl) {
    throw new Error(
      'Medispeak API URL is not configured. Set "MEDISPEAK_API_URL" in this ' +
        "plugin's config in CARE (Admin → plugins), or REACT_MEDISPEAK_API_URL " +
        "in .env for local development (requires a rebuild).",
    );
  }
  return baseUrl;
}

function requireFillyBase(): string {
  if (!FILLY_BASE_URL) {
    throw new Error(
      "No filly backend configured — window.CARE_API_URL is not set (plugin must run inside CARE).",
    );
  }
  return FILLY_BASE_URL;
}

async function parseError(response: Response): Promise<never> {
  const data = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  throw new MedispeakApiError(
    data.error?.message ?? `Request failed with status ${response.status}`,
    data.error?.code,
  );
}

/** Create a document-modality Medispeak session + scoped token via care_filly. */
export async function createMedispeakDocumentSession(
  params: CreateParams,
): Promise<MedispeakSessionHandle> {
  const response = await fetch(`${requireFillyBase()}/medispeak/sessions`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      facility_id: params.facilityId,
      modality: "document",
      fields: params.fields,
    }),
  });
  if (!response.ok) return parseError(response);
  const data = await response.json();
  return {
    sessionId: data.session_id,
    medispeakSessionId: data.medispeak_session_id,
    token: data.token,
  };
}

async function refreshToken(sessionId: string): Promise<string> {
  const response = await fetch(
    `${requireFillyBase()}/medispeak/sessions/${sessionId}/token`,
    { method: "POST", headers: getHeaders() },
  );
  if (!response.ok) return parseError(response);
  const data = await response.json();
  return data.token;
}

async function medispeakFetch(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(`${requireMedispeakBase()}${path}`, {
    ...init,
    headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) throw new MedispeakAuthError("token expired");
  if (!response.ok) return parseError(response);
  return response;
}

/** Retries once with a freshly-minted token if the current one has expired. */
async function withTokenRefresh<T>(
  handle: MedispeakSessionHandle,
  call: (token: string) => Promise<T>,
): Promise<T> {
  try {
    return await call(handle.token);
  } catch (err) {
    if (!(err instanceof MedispeakAuthError)) throw err;
    handle.token = await refreshToken(handle.sessionId);
    return call(handle.token);
  }
}

/** Upload one image/PDF to a document-modality session. */
export async function uploadMedispeakDocument(
  handle: MedispeakSessionHandle,
  file: File,
): Promise<void> {
  await withTokenRefresh(handle, async (token) => {
    const form = new FormData();
    form.append("document", file, file.name);
    await medispeakFetch(
      `/scribe_sessions/${handle.medispeakSessionId}/documents`,
      token,
      { method: "POST", body: form },
    );
  });
}

/** Mark the session's documents complete and kick off OCR + structuring. */
export async function commitMedispeakSession(
  handle: MedispeakSessionHandle,
): Promise<void> {
  await withTokenRefresh(handle, async (token) => {
    await medispeakFetch(
      `/scribe_sessions/${handle.medispeakSessionId}/commit`,
      token,
      { method: "POST" },
    );
  });
}

const TERMINAL_STATUSES = new Set(["completed", "partial", "failed"]);

/**
 * Poll until the session reaches a terminal status, then return the
 * already-structured "form" output result, keyed exactly by the `key`s
 * given in `fields`.
 */
export async function pollMedispeakFormResult(
  handle: MedispeakSessionHandle,
  {
    intervalMs = 750,
    maxAttempts = 160,
    onTranscript,
  }: {
    intervalMs?: number;
    maxAttempts?: number;
    /** Called with the document's raw OCR'd text as soon as it's available,
     * usually before the structured "form" output finishes. */
    onTranscript?: (text: string) => void;
  } = {},
): Promise<Record<string, unknown>> {
  let lastTranscript = "";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const payload = await withTokenRefresh(handle, async (token) => {
      const response = await medispeakFetch(
        `/scribe_sessions/${handle.medispeakSessionId}`,
        token,
      );
      return response.json();
    });

    const transcriptText = (payload.transcript as { text?: string } | null)
      ?.text;
    if (transcriptText && transcriptText !== lastTranscript) {
      lastTranscript = transcriptText;
      onTranscript?.(transcriptText);
    }

    if (TERMINAL_STATUSES.has(payload.status)) {
      const outputs = (payload.outputs as Array<Record<string, unknown>>) || [];
      const formOutput = outputs.find((o) => o.type === "form");
      if (!formOutput || formOutput.status === "failure") {
        // The public JSON key is "errors" (mapped from the model's
        // result_errors column — see ScribeSessionSerializer).
        const errors = outputs.flatMap(
          (o) => (o.errors as { message?: string }[] | undefined) || [],
        );
        throw new MedispeakApiError(
          errors[0]?.message ?? "Medispeak returned no extraction result",
        );
      }
      return (formOutput.result as Record<string, unknown>) || {};
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Medispeak session timed out waiting for a result");
}

/** Runs one or more images/PDFs through the document/OCR pipeline. */
export async function runMedispeakOcr(
  files: File | File[],
  params: CreateParams,
  options?: { onTranscript?: (text: string) => void },
): Promise<Record<string, unknown>> {
  const documents = Array.isArray(files) ? files : [files];
  if (!documents.length) {
    throw new Error("No documents to upload");
  }
  const handle = await createMedispeakDocumentSession(params);
  for (const file of documents) {
    await uploadMedispeakDocument(handle, file);
  }
  await commitMedispeakSession(handle);
  return pollMedispeakFormResult(handle, options);
}
