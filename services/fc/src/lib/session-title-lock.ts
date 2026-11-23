/**
 * In-memory twin of `amux.apply_generated_session_title` plus a user lock.
 *
 * The database statement is the atomic write. This function is what the
 * in-memory repository fakes and the unit tests follow, so a locked title
 * is left alone and `titleApplied` stays false.
 */
export type SessionTitlePatch = {
  title?: string;
  titleLocked?: boolean;
};

export type SessionTitleRow = {
  title: string;
  titleLocked?: boolean;
};

export type SessionTitleWrite = {
  title: string;
  titleLocked: boolean;
  /** True only when this call stored `patch.title`. */
  titleApplied: boolean;
};

export function applySessionTitlePatch(
  row: SessionTitleRow,
  patch: SessionTitlePatch,
): SessionTitleWrite {
  const locked = row.titleLocked === true;
  if (patch.titleLocked === true && typeof patch.title === "string") {
    return {
      title: patch.title,
      titleLocked: true,
      titleApplied: true,
    };
  }
  if (typeof patch.title === "string") {
    if (locked) {
      return {
        title: row.title,
        titleLocked: true,
        titleApplied: false,
      };
    }
    return {
      title: patch.title,
      titleLocked: false,
      titleApplied: true,
    };
  }
  return {
    title: row.title,
    titleLocked: locked,
    titleApplied: false,
  };
}
