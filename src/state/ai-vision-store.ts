import { getHeaders } from "@/lib/request";
import { atom } from "jotai";
import { atomWithStorage, createJSONStorage } from "jotai/utils";

const STORAGE_KEY_PREFIX = "care_ai_vision.enabled";
const PREFERENCE_KEY = "care_ai_vision";
const PREFERENCE_VERSION = "1.0";

/**
 * Local atom backed by localStorage — used as a per-device cache.
 * `useAiVisionEnabled` hydrates this from the server so a new device
 * still respects the user-level preference.
 */
export function aiVisionEnabledAtomFor(userId: string) {
  return atomWithStorage<boolean>(
    `${STORAGE_KEY_PREFIX}.${userId}`,
    false,
    createJSONStorage(() => localStorage),
  );
}

/** Fetch the AI Vision preference from the server (via getcurrentuser). */
export async function fetchAiVisionPreference(): Promise<boolean> {
  try {
    const res = await fetch(
      new URL("/api/v1/users/getcurrentuser/", window.CARE_API_URL).toString(),
      { headers: getHeaders() },
    );
    if (!res.ok) return false;
    const data = await res.json();
    return data?.preferences?.[PREFERENCE_KEY]?.enabled === true;
  } catch {
    return false;
  }
}

/** Persist the AI Vision preference to the server. */
export async function setAiVisionPreference(enabled: boolean): Promise<void> {
  await fetch(
    new URL("/api/v1/users/set_preferences/", window.CARE_API_URL).toString(),
    {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        preference: PREFERENCE_KEY,
        version: PREFERENCE_VERSION,
        value: { enabled },
      }),
    },
  );
}

/** User key whose server preference has already been hydrated this session. */
export const preferencesSyncedForAtom = atom<string | null>(null);
