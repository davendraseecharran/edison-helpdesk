/**
 * The blocking script that stops Today's entrance replaying on a reload.
 *
 * The entrance is a CSS animation, so it starts the moment the element is
 * painted. Anything that runs after hydration is too late to prevent it — it
 * can only cut it short, which looks worse than letting it finish. So the
 * suppression is stamped on `<html>` before the body is parsed, by the same
 * trick the theme uses.
 *
 * It touches one session key and one attribute, reads nothing else, and is
 * wrapped in a try so a browser with storage disabled gets the animation
 * rather than a broken page. The matching layout effect in `TodayScreen`
 * covers a client-side navigation, where no script runs at all.
 */
export const TODAY_BOOT_SCRIPT = `(function(){try{var k='edison.today.seen';if(sessionStorage.getItem(k)){document.documentElement.setAttribute('data-today-seen','')}else{sessionStorage.setItem(k,'1')}}catch(e){}})();`;
