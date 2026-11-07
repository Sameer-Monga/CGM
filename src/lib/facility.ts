/**
 * Best-effort facility id straight from the URL, for plugin slots that don't
 * receive it as a prop (e.g. `DiagnosticReportOverride`). Mirrors care_fe's
 * own `useCurrentFacility` path-parsing convention (`/facility/:facilityId/...`).
 */
export function resolveFacilityIdFromPath(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const segments = window.location.pathname.split("/");
  return segments[1] === "facility" ? segments[2] || undefined : undefined;
}
