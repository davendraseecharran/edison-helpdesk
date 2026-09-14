import '@/styles/voice.css';

/**
 * The application arriving.
 *
 * One signature moment per session: the wordmark on the page's ground with the
 * lamp warming up behind it, one second, then gone. It is rendered by the
 * authenticated layout, which mounts on a real document load — a first visit,
 * a reload, the navigation that follows signing in — and stays mounted while
 * you move between screens, so moving from the queue to Today never replays it.
 *
 * No JavaScript at all. The whole thing is a CSS animation with
 * `animation-fill-mode: forwards`, so there is no script that could fail to run
 * and leave a sheet over the application, and it takes no pointer events even
 * while it is on screen. `aria-hidden` because it says nothing a reader needs:
 * the page behind it is already being announced.
 */
export function BootLamp() {
  return (
    <div className="boot-lamp" aria-hidden="true">
      <span className="boot-lamp-mark">
        <b>Edison</b>
        <span>Helpdesk</span>
      </span>
    </div>
  );
}
