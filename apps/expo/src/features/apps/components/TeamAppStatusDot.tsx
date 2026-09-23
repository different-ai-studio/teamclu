import { StatusDot } from "../../../ui/atoms/StatusDot";
import { colors } from "../../../ui/theme";
import { teamAppStatusDot, type TeamAppStatusKind } from "../team-app-types";

/** Port of iOS `TeamAppStatusDot`: only a live app breathes. */
export function TeamAppStatusDot({ kind }: { kind: TeamAppStatusKind }) {
  const dot = teamAppStatusDot(kind);
  return (
    <StatusDot
      breathing={dot.breathing}
      color={dot.basalt ? colors.basalt : undefined}
      kind={dot.kind}
    />
  );
}
