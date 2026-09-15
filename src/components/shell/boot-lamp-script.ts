/**
 * The boot lamp's session gate, free of React so the root layout can put it in
 * the document's `<head>`.
 *
 * A separate module for the same reason `theme-script.ts` is one: a `'use
 * client'` file's exports reach a server component as client references rather
 * than as values, and this one has to be a string the server can write into the
 * head.
 */

/** Where the browsing session records that it has already seen the lamp. */
export const BOOT_LAMP_SEEN_KEY = 'edison.boot.seen';

/**
 * The gate, as the only thing early enough to be one.
 *
 * A CSS animation runs the moment the element is painted, so a decision made
 * after hydration is a decision made after the lamp is already on screen. This
 * runs in the `<head>`, before the parser has reached anything it governs, and
 * it can only ever HIDE the lamp: storage refused, a script blocked, anything
 * at all goes wrong and the moment simply plays, which is the failure
 * everybody would rather have.
 *
 * It reads and does not write. Writing is the lamp's own job, because the head
 * runs on every page and the lamp is only on the authenticated ones: a script
 * that marked the session seen from the sign-in screen would spend the one
 * moment on the one screen that never shows it.
 */
export const BOOT_LAMP_SCRIPT = `(function(){try{if(window.sessionStorage.getItem(${JSON.stringify(
  BOOT_LAMP_SEEN_KEY,
)}))document.documentElement.setAttribute('data-boot-seen','');}catch(e){}})();`;
