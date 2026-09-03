import * as React from "react";
import { loadSessionWorkspaceLabelsForTeam } from "@/lib/session/session-by-workspace";

/** Local libsql session→workspace labels for list sublines. */
export function useSessionWorkspaceLabels(teamId: string | null | undefined) {
  const [labels, setLabels] = React.useState<Map<string, string>>(() => new Map());

  React.useEffect(() => {
    if (!teamId) {
      setLabels(new Map());
      return;
    }
    let cancelled = false;
    void loadSessionWorkspaceLabelsForTeam(teamId).then((next) => {
      if (!cancelled) setLabels(next);
    });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  return labels;
}
