import { type PracticeKind, practiceStart } from "@gem/shared/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ApiClientError, api } from "../api/client.ts";
import { errorText } from "../ui/controls.tsx";
import { useLive } from "../ui/live.tsx";

export const historyKey = (testId: string) => ["practice", "history", testId] as const;

/** Start a full or retake-missed attempt and open it; conflicts (in progress, archived, …) are announced. */
export function useStartAttempt(testId: string) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { announce } = useLive();
  return useMutation({
    mutationFn: (kind: PracticeKind) => api.call(practiceStart, { body: { testId, kind } }),
    onSuccess: async ({ attempt }) => {
      await qc.invalidateQueries({ queryKey: ["practice"] });
      await navigate({ to: "/practice/attempts/$attemptId", params: { attemptId: attempt.id } });
    },
    onError: async (e) => {
      announce(errorText(t, e));
      if (e instanceof ApiClientError && e.code === "practice_attempt_in_progress") {
        await qc.invalidateQueries({ queryKey: historyKey(testId) });
      }
    },
  });
}
