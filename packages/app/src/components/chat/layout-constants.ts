/**
 * Chat layout spacing constants
 * 
 * These constants define the spacing between messages and the input area
 * to prevent overlap issues at the bottom of the chat panel.
 * 
 * ⚠️ WARNING: DO NOT MODIFY WITHOUT TESTING
 * These values have been carefully tuned to prevent message/input overlap.
 * If you change ChatInputArea padding or MessageList padding, you MUST:
 * 1. Test with messages at the very bottom of the chat
 * 2. Test with both compact and normal modes
 * 3. Test with expanded input area (multiline input, file attachments)
 * 4. Update the comments below to document your changes
 */

/**
 * Extra spacing added to MessageList's paddingBottom beyond inputAreaHeight.
 * 
 * Why this value:
 * - ChatInputArea (non-compact) has pt-8 (32px) with 30% transparent gradient
 * - The transparent gradient area (~10px) can cause content to show through
 * - Additional 32px ensures visual breathing room and accounts for:
 *   - Gradient transition zone
 *   - Sub-pixel rounding differences
 *   - ResizeObserver timing delays
 * 
 * Formula: MessageList paddingBottom = inputAreaHeight + SAFE_BOTTOM_SPACING
 * 
 * History:
 * - Originally 16px: Caused overlap issues (reported multiple times)
 * - Changed to 32px: Provides reliable spacing buffer
 */
export const SAFE_BOTTOM_SPACING = 32;

/** Default composer height before ResizeObserver reports the real value. */
export const DEFAULT_INPUT_AREA_HEIGHT = 160;

/**
 * Gap between the jump-to-latest button and the top of the floating composer.
 * The button is offset by the measured composer height, so it stays above the
 * overlay instead of sitting in the transparent fade that covers the pane.
 */
export const SCROLL_TO_LATEST_CLEARANCE = 12;

/**
 * Threshold for "near bottom" detection in scroll behavior.
 * Used to determine if user has scrolled up or is at the bottom.
 * 
 * Why this value:
 * - Must be larger than SAFE_BOTTOM_SPACING to avoid false positives
 * - 150px accommodates tall input areas (multiline, attachments)
 * 
 * DO NOT set lower than SAFE_BOTTOM_SPACING + 50px
 */
export const NEAR_BOTTOM_THRESHOLD = 150;

/**
 * Type guard to ensure spacing constants are properly validated
 */
if (NEAR_BOTTOM_THRESHOLD <= SAFE_BOTTOM_SPACING + 50) {
  throw new Error(
    `NEAR_BOTTOM_THRESHOLD (${NEAR_BOTTOM_THRESHOLD}) must be at least ` +
    `SAFE_BOTTOM_SPACING + 50px (${SAFE_BOTTOM_SPACING + 50}) to prevent ` +
    `false-positive scroll detection`
  );
}
