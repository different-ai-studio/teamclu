import type { StreamingPermissionRequest } from "@/stores/v2-streaming-store";
import type { AcpPermissionDecision } from "@/lib/teamclu/reply-acp-permission";

type StreamingPermissionOption = {
  optionId: string;
  kind: string;
  name: string;
};

/** OpenCode ACP agent default option ids (packages/opencode/src/acp/agent.ts). */
export function defaultOpenCodePermissionOptions(): StreamingPermissionOption[] {
  return [
    { optionId: "once", kind: "allow_once", name: "Allow once" },
    { optionId: "always", kind: "allow_always", name: "Always allow" },
    { optionId: "reject", kind: "reject_once", name: "Reject" },
  ];
}

export function acpOptionIdForDecision(
  decision: AcpPermissionDecision,
  request: Pick<StreamingPermissionRequest, "options">,
): string | undefined {
  if (decision === "deny") return undefined;
  const options = request.options?.length
    ? request.options
    : defaultOpenCodePermissionOptions();
  if (decision === "always") {
    return (
      options.find((o) => o.kind === "allow_always")?.optionId ??
      options.find((o) => o.optionId === "always")?.optionId ??
      "always"
    );
  }
  return (
    options.find((o) => o.kind === "allow_once")?.optionId ??
    options.find((o) => o.optionId === "once")?.optionId ??
    "once"
  );
}
