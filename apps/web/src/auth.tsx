import { type Me, me, type Role } from "@gem/shared/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ApiClientError, api } from "./api/client.ts";

export const ME_KEY = ["auth", "me"] as const;

/** The signed-in user, or null. */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async (): Promise<Me | null> => {
      try {
        return (await api.call(me)).user;
      } catch (e) {
        if (e instanceof ApiClientError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 30_000,
  });
}

export function useSetMe() {
  const qc = useQueryClient();
  return (user: Me | null) => {
    qc.setQueryData(ME_KEY, user);
    if (user === null) qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
  };
}

const RANK: Record<Role, number> = { student: 0, proctor: 1, admin: 2 };
export const atLeast = (user: Me | null | undefined, role: Role) => !!user && RANK[user.role] >= RANK[role];

/** Pages for a role: sign-in first, then a polite refusal for lower roles (the API enforces it anyway). */
export function RequireRole({ minRole, children }: { minRole: Role; children: (user: Me) => ReactNode }) {
  const { t } = useTranslation();
  const { data: user, isPending } = useMe();
  if (isPending) return <p>{t("common:loading")}</p>;
  if (!user) return <Navigate to="/sign-in" />;
  if (!atLeast(user, minRole)) {
    return (
      <>
        <h1>{t("common:forbidden.title")}</h1>
        <p>{t("common:forbidden.body")}</p>
      </>
    );
  }
  return <>{children(user)}</>;
}
