const LOG_PREFIX = "[interrupt-msg-diag]";
const RING_MAX = 80;

type DiagRecord = {
  at: string;
  stage: string;
  [key: string]: unknown;
};

const ring: DiagRecord[] = [];

function push(record: DiagRecord): void {
  ring.push(record);
  if (ring.length > RING_MAX) ring.shift();
}

/** DevTools filter: `interrupt-msg-diag` */
export function logInterruptMsgDiag(
  stage: string,
  payload: Record<string, unknown> = {},
): void {
  const record: DiagRecord = {
    at: new Date().toISOString(),
    stage,
    ...payload,
  };
  push(record);
  if (import.meta.env.DEV) {
    console.info(`${LOG_PREFIX} ${stage}`, record);
  }
}

export function dumpInterruptMsgDiag(): DiagRecord[] {
  console.table(ring);
  return [...ring];
}

declare global {
  interface Window {
    teamcluInterruptMsgDiagDump?: () => DiagRecord[];
  }
}

if (typeof window !== "undefined") {
  window.teamcluInterruptMsgDiagDump = dumpInterruptMsgDiag;
}
