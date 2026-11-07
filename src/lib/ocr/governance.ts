import { ExtractedData, GovtOrg, GovtOrgResponse } from "./types";

/**
 * Searches the Care governance organization API to resolve
 * state/district/local_body/ward names into a geo_organization UUID.
 * Walks the hierarchy: state → district → local body → ward.
 */
export async function resolveGeoOrganization(
  data: ExtractedData,
): Promise<{ id: string; levels: GovtOrg[] } | null> {
  const levels = [data.state, data.district, data.local_body, data.ward].filter(
    Boolean,
  ) as string[];

  if (levels.length === 0) return null;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const token = localStorage.getItem("care_access_token");
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let parentId = "";
  const resolvedLevels: GovtOrg[] = [];

  for (const levelName of levels) {
    const params = new URLSearchParams({
      org_type: "govt",
      parent: parentId,
      name: levelName,
      offset: "0",
      limit: "12",
    });

    try {
      const url = new URL(
        `/api/v1/organization/?${params.toString()}`,
        window.CARE_API_URL,
      );
      const res = await fetch(url.toString(), { headers });
      if (!res.ok) break;

      const json: GovtOrgResponse = await res.json();
      const match =
        json.results.find(
          (org) => org.name.toLowerCase() === levelName.toLowerCase(),
        ) ?? json.results[0];

      if (!match) break;

      resolvedLevels.push(match);
      parentId = match.id;

      if (!match.has_children) break;
    } catch {
      break;
    }
  }

  if (resolvedLevels.length === 0) return null;

  const deepest = resolvedLevels[resolvedLevels.length - 1];
  return { id: deepest.id, levels: resolvedLevels };
}
