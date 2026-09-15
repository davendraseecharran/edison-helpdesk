import '@/styles/voice.css';

/** Where the browsing session records that it has already seen the lamp. */
export const BOOT_LAMP_SEEN_KEY = 'edison.boot.seen';

/**
 * The gate, as the only thing early enough to be one.
 *
 * A CSS animation runs the moment the element is painted, so a decision made
 * after hydration is a decision made after the lamp is already on screen. This
 * runs where it is written — before the parser has reached the element below
 * it — and it can only ever HIDE the lamp: storage refused, a script blocked,
 * anything at all goes wrong and the moment simply plays, which is the failure
 * everybody would rather have.
 */
const BOOT_LAMP_SCRIPT = `(function(){var s=false;try{var k=${JSON.stringify(
  BOOT_LAMP_SEEN_KEY,
)};if(window.sessionStorage.getItem(k))s=true;else window.sessionStorage.setItem(k,'1');}catch(e){}if(s){try{document.documentElement.setAttribute('data-boot-seen','');}catch(e){}}})();`;

/**
 * The application arriving.
 *
 * One signature moment per session: the wordmark on the page's ground with the
 * lamp warming up behind it, one second, then gone. It is rendered by the
 * authenticated layout, which mounts on a real document load — a first visit,
 * a reload, the navigation that follows signing in — and stays mounted while
 * you move between screens, so moving from the queue to Today never replays it.
 *
 * Per session means per session. The layout mounting is not the test, because a
 * reload mounts it again and nobody wants the arrival ceremony three times
 * while they are chasing one bug; `sessionStorage` is, and a tab opened fresh
 * tomorrow morning gets it back.
 *
 * The removal is still pure CSS. `animation-fill-mode: forwards` takes the
 * sheet away with no script involved, so the one line of JavaScript above
 * decides only whether the moment happens at all, and never whether it ends.
 * `aria-hidden` because it says nothing a reader needs: the page behind it is
 * already being announced.
 */
export function BootLamp() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: BOOT_LAMP_SCRIPT }} />
      <div className="boot-lamp" aria-hidden="true">
        <span className="boot-lamp-mark">
          <b>Edison</b>
          <span>Helpdesk</span>
        </span>
      </div>
    </>
  );
}
