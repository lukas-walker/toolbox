// Document scanner — pure, DOM-free logic.
//
// For this scaffold the only logic is the capture state machine. Later tasks
// add the testable transforms here (perspective warp, compression, PDF build)
// so they stay independent of the DOM, mirroring the other tools' logic.js.

/** The capture states the tool can be in. */
export const STATES = Object.freeze({
    IDLE: "idle",
    SCANNING: "scanning",
    REVIEW: "review",
    PAGES: "pages",
});

// Allowed forward/backward transitions between states.
//   idle    → scanning
//   scanning→ review        (capture)
//           → idle          (cancel, no pages yet)
//           → pages         (back, pages already captured)
//   review  → scanning      (retake)
//           → pages         (accept)
//   pages   → scanning      (add more pages)
// Export is an action triggered from `pages`, not a separate render state.
const TRANSITIONS = Object.freeze({
    [STATES.IDLE]: [STATES.SCANNING],
    [STATES.SCANNING]: [STATES.REVIEW, STATES.IDLE, STATES.PAGES],
    [STATES.REVIEW]: [STATES.SCANNING, STATES.PAGES],
    [STATES.PAGES]: [STATES.SCANNING],
});

/**
 * Whether moving from `from` to `to` is a legal transition.
 * Re-entering the same state is always allowed (re-render).
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
    if (from === to) return true;
    return (TRANSITIONS[from] || []).includes(to);
}

/**
 * The states reachable from `from`.
 * @param {string} from
 * @returns {string[]}
 */
export function nextStates(from) {
    return (TRANSITIONS[from] || []).slice();
}
