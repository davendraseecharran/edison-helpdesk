/**
 * The assistant's markdown: a small, safe subset rendered to HTML.
 *
 * The model writes text; the panel shows it. Between the two sits this
 * renderer, and its first job is refusing to be a way of injecting markup:
 * every character is escaped BEFORE any construct is recognised, so the only
 * tags that can appear in the output are the ones this file writes.
 *
 * What is recognised, and nothing else:
 *   paragraphs      blank line between; a single newline is a <br>
 *   **bold**
 *   `code`          inline; nothing inside it is formatted
 *   ``` fences      a block; an unterminated fence runs to the end, so a reply
 *                   that is still streaming reads as code rather than as noise
 *   - lists         `-` or `*` bullets, `1.` numbered; one level
 *   [text](href)    http, https, mailto, or a site path; anything else loses
 *                   its anchor and keeps its text
 *   # headings      shown as an emphasised paragraph, so the model cannot
 *                   restructure the panel
 *
 * Pure and dependency-free, so it runs in the unit suite.
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Whether a link target may become an anchor.
 *
 * Absolute http(s) and mailto, or a path on this site. A protocol-relative
 * `//host` is refused: it looks like a path and leaves the site.
 */
export function isSafeHref(href: string): boolean {
  if (href !== href.trim()) return false;
  if (/^https?:\/\//i.test(href)) return true;
  if (/^mailto:[^\s]+$/i.test(href)) return true;
  return href.startsWith('/') && !href.startsWith('//');
}

function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/**
 * Placeholders keep code spans out of reach of the bold and link passes. A
 * private-use character cannot arrive in model text through JSON in any way
 * that matters, and it is escaped-neutral.
 */
const CODE_SLOT = String.fromCharCode(0xe000);
const CODE_SLOT_PATTERN = new RegExp(`${CODE_SLOT}(\\d+)${CODE_SLOT}`, 'g');

function inline(text: string): string {
  const codes: string[] = [];
  let out = escapeHtml(text.split(CODE_SLOT).join('')).replace(
    /`([^`\n]+)`/g,
    (_match, code: string) => {
      codes.push(`<code>${code}</code>`);
      return `${CODE_SLOT}${codes.length - 1}${CODE_SLOT}`;
    },
  );

  // Links before bold, so a bold link label formats inside the anchor.
  out = out.replace(/\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_match, label: string, rawHref: string) => {
    // The href was escaped with everything else; undo that so a query string
    // round-trips, then escape it again as an attribute value.
    const href = rawHref
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    if (!isSafeHref(href)) return label;
    const attribute = escapeHtml(href);
    return isExternal(href)
      ? `<a href="${attribute}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : `<a href="${attribute}">${label}</a>`;
  });

  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

  return out.replace(CODE_SLOT_PATTERN, (_match, index: string) => codes[Number(index)] ?? '');
}

const FENCE = /^\s*```/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/;

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    paragraph = [];
  };

  let at = 0;
  while (at < lines.length) {
    const line = lines[at];

    if (FENCE.test(line)) {
      flushParagraph();
      const body: string[] = [];
      at += 1;
      while (at < lines.length && !FENCE.test(lines[at])) {
        body.push(lines[at]);
        at += 1;
      }
      // Skip the closing fence when there is one; at the end there is not.
      if (at < lines.length) at += 1;
      html.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      flushParagraph();
      const pattern = BULLET.test(line) ? BULLET : NUMBERED;
      const items: string[] = [];
      while (at < lines.length) {
        const match = pattern.exec(lines[at]);
        if (!match) break;
        items.push(`<li>${inline(match[1])}</li>`);
        at += 1;
      }
      html.push(pattern === NUMBERED ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      html.push(`<p class="md-heading"><strong>${inline(heading[1])}</strong></p>`);
      at += 1;
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      at += 1;
      continue;
    }

    paragraph.push(line.trim());
    at += 1;
  }

  flushParagraph();
  return html.join('');
}
