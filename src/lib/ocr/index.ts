export {
  extractDataFromImage,
  extractLabResults,
  buildLabFieldSpecs,
} from "./care-ai";
export type { LabFieldKeyMap, LabFieldTarget } from "./care-ai";
export { resolveGeoOrganization } from "./governance";
export {
  BLOOD_GROUP_MAP,
  clearLabObservationMarks,
  highlightField,
  highlightLabObservation,
  normalizeBloodGroup,
  normalizeIsoDate,
  normalizePhone,
  normalizePincode,
  persistLabObservationMark,
} from "./utils";
export type { FillMark, FillMarkLabels } from "./utils";
export type { ExtractedData, GovtOrg } from "./types";
