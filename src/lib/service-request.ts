import { getHeaders } from "@/lib/request";

export interface DiagnosticReportContext {
  patientId: string;
  patientName: string;
  reportId: string;
  testName: string;
}

/**
 * care_fe's DiagnosticReportOverride plugin slot only passes observationDefinitions
 * and value-change handlers, not patient/report identifiers. Since the plugin renders
 * on the /facility/:facilityId/service_requests/:serviceRequestId route, parse those
 * ids from the URL and fetch the rest (patient, latest diagnostic report) directly.
 */
export async function resolveDiagnosticReportContext(): Promise<DiagnosticReportContext | null> {
  const match = window.location.pathname.match(
    /\/facility\/([^/]+)\/service_requests\/([^/]+)/,
  );
  if (!match) return null;
  const [, facilityId, serviceRequestId] = match;

  const url = new URL(
    `/api/v1/facility/${facilityId}/service_request/${serviceRequestId}/`,
    window.CARE_API_URL,
  );
  const res = await fetch(url.toString(), { headers: getHeaders() });
  if (!res.ok) return null;

  const data = await res.json();
  const patient = data?.encounter?.patient;
  const report = data?.diagnostic_reports?.[0];
  if (!patient?.id || !report?.id) return null;

  return {
    patientId: patient.id,
    patientName: patient.name ?? "",
    reportId: report.id,
    testName: report.code?.display || report.code?.code || "Lab Report",
  };
}
