import { UserBase } from "@/lib/types/common";
import { authUserAtom } from "@/state/user-atom";
import { useAtomValue } from "jotai";

const FALLBACK_USER: UserBase = {
  id: "anonymous",
  first_name: "",
  username: "anonymous",
  email: "",
  last_name: "",
  last_login: "",
  profile_picture_url: "",
  phone_number: "",
  mfa_enabled: false,
};

/**
 * Returns the current authenticated user.
 * Falls back to a stub so components don't crash if atom isn't hydrated yet.
 */
export default function useAuthUser(): UserBase {
  const user = useAtomValue(authUserAtom);
  return user ?? FALLBACK_USER;
}
