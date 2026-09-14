/**
 * The assistant's markdown subset. The renderer produces HTML from text the
 * model wrote, so the contract that matters most is that nothing in that
 * text can become markup: everything is escaped first and only the handful
 * of constructs below are turned back into tags.
 */

import { describe, expect, it } from 'vitest';
import { escapeHtml, isSafeHref, renderMarkdown } from '../../src/components/ai/markdown';

describe('escapeHtml', () => {
  it('escapes every character that could open markup or an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('renderMarkdown: escaping', () => {
  it('never lets raw HTML through', () => {
    const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes inside code spans and code blocks too', () => {
    expect(renderMarkdown('use `a<b`')).toBe('<p>use <code>a&lt;b</code></p>');
    expect(renderMarkdown('```\n<b>bold</b>\n```')).toBe(
      '<pre><code>&lt;b&gt;bold&lt;/b&gt;</code></pre>',
    );
  });

  it('renders nothing for empty input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   \n\n  ')).toBe('');
  });
});

describe('renderMarkdown: paragraphs', () => {
  it('splits paragraphs on blank lines and keeps single newlines as breaks', () => {
    expect(renderMarkdown('one\ntwo\n\nthree')).toBe('<p>one<br>two</p><p>three</p>');
  });

  it('accepts Windows line endings', () => {
    expect(renderMarkdown('one\r\n\r\ntwo')).toBe('<p>one</p><p>two</p>');
  });

  it('renders a heading as an emphasised paragraph rather than a page heading', () => {
    expect(renderMarkdown('## Open tickets\n\ntext')).toBe(
      '<p class="md-heading"><strong>Open tickets</strong></p><p>text</p>',
    );
  });
});

describe('renderMarkdown: inline', () => {
  it('renders bold', () => {
    expect(renderMarkdown('**Claimed** EDT-1042')).toBe('<p><strong>Claimed</strong> EDT-1042</p>');
  });

  it('renders inline code and leaves bold markers inside it alone', () => {
    expect(renderMarkdown('run `npm **run** check`')).toBe(
      '<p>run <code>npm **run** check</code></p>',
    );
  });

  it('leaves a lone asterisk or underscore as text', () => {
    expect(renderMarkdown('a * b * c and snake_case_name')).toBe(
      '<p>a * b * c and snake_case_name</p>',
    );
  });
});

describe('renderMarkdown: code blocks', () => {
  it('renders a fenced block and ignores the language tag', () => {
    expect(renderMarkdown('```js\nconst x = 1;\nconst y = 2;\n```')).toBe(
      '<pre><code>const x = 1;\nconst y = 2;</code></pre>',
    );
  });

  it('treats an unterminated fence as running to the end, so streaming text stays readable', () => {
    expect(renderMarkdown('before\n\n```\npartial')).toBe(
      '<p>before</p><pre><code>partial</code></pre>',
    );
  });

  it('does not apply inline formatting inside a block', () => {
    expect(renderMarkdown('```\n**not bold** [not a link](https://x.test)\n```')).toBe(
      '<pre><code>**not bold** [not a link](https://x.test)</code></pre>',
    );
  });
});

describe('renderMarkdown: lists', () => {
  it('renders dash bullets', () => {
    expect(renderMarkdown('- one\n- two **2**')).toBe(
      '<ul><li>one</li><li>two <strong>2</strong></li></ul>',
    );
  });

  it('renders asterisk bullets and numbered lists', () => {
    expect(renderMarkdown('* a\n* b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderMarkdown('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('ends a list at a blank line', () => {
    expect(renderMarkdown('- a\n\nafter')).toBe('<ul><li>a</li></ul><p>after</p>');
  });
});

describe('renderMarkdown: links', () => {
  it('renders an internal link plainly', () => {
    expect(renderMarkdown('see [EDT-1042](/tickets/EDT-1042)')).toBe(
      '<p>see <a href="/tickets/EDT-1042">EDT-1042</a></p>',
    );
  });

  it('opens an external link in a new tab without a referrer', () => {
    expect(renderMarkdown('[ChatGPT](https://chatgpt.com/codex/device)')).toBe(
      '<p><a href="https://chatgpt.com/codex/device" target="_blank" rel="noopener noreferrer">ChatGPT</a></p>',
    );
  });

  it('escapes quotes inside an href', () => {
    expect(renderMarkdown('[q](https://x.test/?a="b")')).toBe(
      '<p><a href="https://x.test/?a=&quot;b&quot;" target="_blank" rel="noopener noreferrer">q</a></p>',
    );
  });

  it('drops the anchor for an unsafe scheme and keeps the text', () => {
    expect(renderMarkdown('[run](javascript:alert(1))')).toBe('<p>run</p>');
    expect(renderMarkdown('[data](data:text/html,x)')).toBe('<p>data</p>');
    expect(renderMarkdown('[proto](//evil.test/x)')).toBe('<p>proto</p>');
  });
});

describe('isSafeHref', () => {
  it('accepts http, https, mailto and site-relative paths only', () => {
    expect(isSafeHref('https://a.test')).toBe(true);
    expect(isSafeHref('http://a.test')).toBe(true);
    expect(isSafeHref('mailto:x@edison.example')).toBe(true);
    expect(isSafeHref('/tickets/EDT-1')).toBe(true);
    expect(isSafeHref('//a.test')).toBe(false);
    expect(isSafeHref('javascript:void(0)')).toBe(false);
    expect(isSafeHref('JavaScript:void(0)')).toBe(false);
    expect(isSafeHref(' javascript:void(0)')).toBe(false);
    expect(isSafeHref('data:text/plain,x')).toBe(false);
    expect(isSafeHref('relative/path')).toBe(false);
  });
});
