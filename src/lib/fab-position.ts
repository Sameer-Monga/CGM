/**
 * Persisted position of the floating AI Vision widget (see
 * `useDraggableFab`). Keyed per-user because a shared device/kiosk can be
 * used by more than one CARE user — without this, one user's dragged
 * position would leak into the next person's session on the same browser.
 */
const FAB_POSITION_STORAGE_PREFIX = "care_ai_vision_fab_offset";

/** Dispatched (on `window`) whenever the position is reset from elsewhere,
 *  so any currently-mounted widget snaps back immediately without a reload. */
export const FAB_POSITION_RESET_EVENT = "care-ai-vision-fab-position-reset";

export function fabPositionStorageKey(userId: string | null): string {
  return userId
    ? `${FAB_POSITION_STORAGE_PREFIX}:${userId}`
    : FAB_POSITION_STORAGE_PREFIX;
}

export function loadStoredFabOffset(key: string): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { x: 0, y: 0 };
    const parsed = JSON.parse(raw);
    if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
      return parsed;
    }
  } catch {
    // ignore malformed/unavailable storage
  }
  return { x: 0, y: 0 };
}
