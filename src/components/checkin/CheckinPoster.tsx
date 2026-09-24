import { longDate, posterInstruction, shortLink, type CheckinIdentity } from '@/lib/domain/checkin';

/**
 * The poster itself: one Letter page for the door.
 *
 * Read from across a corridor, so it says four things and says them big —
 * what the event is, when, the code, and what to do — with the link under a
 * hairline for a phone whose camera will not read it. Monochrome on purpose:
 * it goes through the school's black-and-white printer, and a code printed in
 * grey is a code that does not scan. The four corners around the code are a
 * phone camera's own frame, which is the one instruction that needs no words.
 *
 * `svg` is drawn by `qrcode` on the server from this application's own origin
 * and a slug the database generated; anything that is not an `<svg>` element
 * renders as no code rather than as markup.
 */
export function CheckinPoster({
  eventName,
  groupName,
  heldOn,
  identity,
  svg,
  url,
}: {
  eventName: string;
  groupName: string;
  heldOn: string;
  identity: CheckinIdentity;
  svg: string;
  url: string;
}) {
  const safe = svg.trimStart().startsWith('<svg') && !/<\s*script/i.test(svg) ? svg : '';
  const length = eventName.length > 48 ? 'longer' : eventName.length > 26 ? 'long' : undefined;

  return (
    <article className="poster-sheet" aria-label={`Poster: scan to check in to ${eventName}`}>
      <div className="poster-body">
        <div className="poster-top">
          <span>{groupName}</span>
          <span>Thomas A. Edison CTE High School</span>
        </div>
        <h1 className="poster-event" data-length={length}>
          {eventName}
        </h1>
        <p className="poster-date">{longDate(heldOn)}</p>

        <div className="poster-code">
          <div
            className="poster-code-inner"
            role="img"
            aria-label="QR code that opens the check-in page"
            dangerouslySetInnerHTML={{ __html: safe }}
          />
          <span className="poster-corner" data-at="tl" aria-hidden="true" />
          <span className="poster-corner" data-at="tr" aria-hidden="true" />
          <span className="poster-corner" data-at="bl" aria-hidden="true" />
          <span className="poster-corner" data-at="br" aria-hidden="true" />
        </div>

        <p className="poster-scan">Scan to check in</p>
        <p className="poster-hint">{posterInstruction(identity)}</p>

        <div className="poster-foot">
          <span>No camera? Go to</span>
          <span className="poster-url">{shortLink(url)}</span>
        </div>
      </div>
    </article>
  );
}
