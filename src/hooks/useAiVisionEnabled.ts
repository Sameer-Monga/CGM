import useAuthUser from "@/hooks/useAuthUser";
import {
  aiVisionEnabledAtomFor,
  fetchAiVisionPreference,
  preferencesSyncedForAtom,
  setAiVisionPreference,
} from "@/state/ai-vision-store";
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo } from "react";

/**
 * User-level AI Vision toggle. localStorage is only a cache — a new device
 * has no cache, so we always hydrate from the server preference.
 */
export function useAiVisionEnabled() {
  const user = useAuthUser();
  const userKey = user.id ?? user.username;
  const enabledAtom = useMemo(() => aiVisionEnabledAtomFor(userKey), [userKey]);
  const [enabled, setEnabled] = useAtom(enabledAtom);
  const [syncedFor, setSyncedFor] = useAtom(preferencesSyncedForAtom);

  useEffect(() => {
    if (syncedFor === userKey) return;
    let cancelled = false;
    fetchAiVisionPreference().then((serverValue) => {
      if (cancelled) return;
      setEnabled(serverValue);
      setSyncedFor(userKey);
    });
    return () => {
      cancelled = true;
    };
  }, [userKey, syncedFor, setEnabled, setSyncedFor]);

  const setEnabledPreference = useCallback(
    (checked: boolean) => {
      setEnabled(checked);
      setAiVisionPreference(checked);
    },
    [setEnabled],
  );

  return { enabled, setEnabled: setEnabledPreference };
}
