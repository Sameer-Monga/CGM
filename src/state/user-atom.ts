import { UserBase } from "@/lib/types/common";
import { atomWithStorage, createJSONStorage } from "jotai/utils";

export const authUserAtom = atomWithStorage<UserBase | undefined>(
  "care-auth-user",
  undefined,
  createJSONStorage(() => sessionStorage),
);
