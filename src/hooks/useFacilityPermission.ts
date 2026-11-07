import { resolveFacilityIdFromPath } from "@/lib/facility";
import { apiRoutes, HttpMethod, query } from "@/lib/request";
import { useQuery } from "@tanstack/react-query";

interface FacilityPermissions {
  permissions: string[];
}

const facilityApi = apiRoutes({
  get: {
    path: "/api/v1/facility/{facilityId}/",
    method: HttpMethod.GET,
    TResponse: {} as FacilityPermissions,
  },
});

/**
 * Whether the current user holds `permission` on the facility resolved from
 * the URL (see `resolveFacilityIdFromPath`) — the same object-level
 * `permissions` list CARE's own facility-nav uses, fetched directly since
 * this plugin has no access to care_fe's `PermissionContext`.
 */
export function useHasFacilityPermission(permission: string) {
  const facilityId = resolveFacilityIdFromPath();

  const { data, isLoading } = useQuery({
    queryKey: ["facility-permissions", facilityId],
    queryFn: query(facilityApi.get, {
      pathParams: { facilityId: facilityId ?? "" },
    }),
    enabled: !!facilityId,
    staleTime: 1000 * 60 * 5,
  });

  return {
    hasPermission: Boolean(data?.permissions?.includes(permission)),
    isLoading: !!facilityId && isLoading,
  };
}
