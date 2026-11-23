/*
 * Helpers for sharing the keyboard between the game stream and the page.
 *
 * While stream input is attached, the GameLift Streams SDK captures keyboard events for
 * the whole page, so typing into a testing-outcome field would go to the game instead.
 * The playtester page pauses stream input while a text field has focus; this decides
 * which focused elements count as "the playtester is typing".
 */

// <input> types that do not take typed text. Everything else (text, search, number, ...) does.
const NON_TEXT_INPUT_TYPES = new Set([
    "button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"
]);

interface ElementLike {
    tagName?: string;
    type?: string;
    isContentEditable?: boolean;
    readOnly?: boolean;
    disabled?: boolean;
}

/** True when the element accepts typed text, so keystrokes belong to the page, not the game. */
export function isTextEntryElement(target: unknown): boolean {
    if (!target || typeof target !== "object") return false;
    const el = target as ElementLike;
    if (el.isContentEditable === true) return true;
    if (el.disabled === true || el.readOnly === true) return false;
    const tag = (el.tagName ?? "").toUpperCase();
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") return !NON_TEXT_INPUT_TYPES.has((el.type ?? "text").toLowerCase());
    return false;
}
