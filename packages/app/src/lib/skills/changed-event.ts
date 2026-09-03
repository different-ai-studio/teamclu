/**
 * DOM event fired when the on-disk skill set changes, so every open skill
 * surface can re-read it without a store subscription.
 *
 * STR-11: this used to live in `hooks/useAppInit.ts`, which four unrelated
 * components imported solely to reach this string.
 */
export const SKILLS_CHANGED_EVENT = "skills-files-changed";
