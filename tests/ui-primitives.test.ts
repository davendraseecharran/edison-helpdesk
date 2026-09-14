/**
 * Markup contracts of the UI primitives that later screens build on.
 *
 * Rendered to static markup on the server, so these assert the structure and
 * accessibility attributes without a browser: what a screen reader and the
 * stylesheet both depend on.
 */

import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/people',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { ActorLabel, possessive } from '../src/components/ui/ActorLabel';
import { Button } from '../src/components/ui/Button';
import { DataTable } from '../src/components/ui/DataTable';
import { Pagination } from '../src/components/ui/Pagination';
import { Tabs } from '../src/components/ui/Tabs';
import { PriorityBadge, StatusBadge } from '../src/components/Badges';

describe('ActorLabel', () => {
  it('renders the plain name for a person', () => {
    const html = renderToStaticMarkup(h(ActorLabel, { name: 'Priya Raman', via: 'user' }));
    expect(html).toContain('Priya Raman');
    expect(html).not.toContain("'s AI");
    expect(html).not.toContain('title=');
  });

  it("renders <name>'s with an AI tag and the model in the tooltip", () => {
    const html = renderToStaticMarkup(
      h(ActorLabel, { name: 'Morgan Ellis', via: 'ai', model: 'claude-fable-5-1' }),
    );
    expect(html).toContain('Morgan Ellis&#x27;s');
    expect(html).toContain('title="Made by Morgan Ellis&#x27;s AI (claude-fable-5-1)"');
    // The tag is real text in a hairline box, not an icon: a screen reader, a
    // greyscale print and a glance all read "Morgan Ellis's AI".
    expect(html).toContain('<span class="actor-ai-tag">AI</span>');
    expect(html).not.toContain('<svg');
  });

  it('keeps apostrophe-s after a name ending in s', () => {
    expect(possessive('Dev Okafor Jones')).toBe("Dev Okafor Jones's");
    expect(possessive('Chris')).toBe("Chris's");
  });
});

describe('DataTable', () => {
  interface Row {
    id: string;
    number: string;
    title: string;
    age: number;
  }
  const rows: Row[] = [
    { id: 'a', number: 'T-1001', title: 'Projector will not turn on', age: 3 },
    { id: 'b', number: 'T-1002', title: 'Cart 4 charger missing', age: 1 },
  ];
  const columns = [
    { key: 'number', header: 'Ticket', cell: (r: Row) => r.number, mono: true },
    { key: 'title', header: 'Request', cell: (r: Row) => r.title, hideOnPhone: true },
    { key: 'age', header: 'Age', cell: (r: Row) => `${r.age}d`, align: 'right' as const },
  ];

  it('renders a real table and a row-card list from the same rows', () => {
    const html = renderToStaticMarkup(
      h(DataTable<Row>, {
        columns,
        rows,
        rowKey: (r) => r.id,
        cardTitle: (r) => r.title,
        cardMeta: (r) => r.number,
        caption: 'Tickets',
      }),
    );
    expect(html).toContain('<table class="table">');
    expect(html).toContain('<caption class="visually-hidden">Tickets</caption>');
    expect(html).toContain('<th scope="col">Ticket</th>');
    expect(html).toContain('<th scope="col" class="num">Age</th>');
    expect(html).toContain('<td class="mono">T-1001</td>');
    expect(html).toContain('<td class="num">3d</td>');
    // Two cards; the hidden column is left out of the facts but the rest stay.
    expect(html.match(/class="row-card"/g)).toHaveLength(2);
    expect(html).toContain('<div class="row-card-title">Projector will not turn on</div>');
    expect(html).toContain('<div class="row-card-meta">T-1001</div>');
    expect(html).toContain('<dt>Age</dt>');
    expect(html).not.toContain('<dt>Request</dt>');
  });

  it('renders the empty state instead of an empty table', () => {
    const html = renderToStaticMarkup(
      h(DataTable<Row>, {
        columns,
        rows: [],
        rowKey: (r) => r.id,
        cardTitle: (r) => r.title,
        empty: h('p', null, 'Nothing here'),
      }),
    );
    expect(html).not.toContain('<table');
    expect(html).toContain('Nothing here');
  });
});

describe('Pagination', () => {
  const hrefFor = (page: number) => `/queue?page=${page}`;

  it('renders nothing for a single page', () => {
    expect(renderToStaticMarkup(h(Pagination, { page: 1, pageCount: 1, hrefFor }))).toBe('');
  });

  it('links the reachable edge and disables the other', () => {
    const html = renderToStaticMarkup(h(Pagination, { page: 1, pageCount: 3, hrefFor }));
    expect(html).toContain('aria-label="Pagination"');
    expect(html).toContain('Page 1 of 3');
    expect(html).toContain('href="/queue?page=2"');
    expect(html).toContain('rel="next"');
    expect(html).not.toContain('href="/queue?page=0"');
    expect(html).toContain('aria-disabled="true"');
  });
});

describe('Tabs', () => {
  it('marks the current tab and shows counts', () => {
    const html = renderToStaticMarkup(
      h(Tabs, {
        label: 'Administration',
        items: [
          { href: '/admin/people', label: 'People', count: 12 },
          { href: '/admin/import', label: 'Import' },
        ],
      }),
    );
    expect(html).toContain('<nav class="tabs" aria-label="Administration">');
    expect(html).toContain('aria-current="page"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('count-pill');
    expect(html).toContain('>12<');
  });
});

describe('Button', () => {
  it('disables itself and announces busy while loading', () => {
    const html = renderToStaticMarkup(
      h(Button, { variant: 'primary', loading: true }, 'Save changes'),
    );
    expect(html).toContain('class="btn btn-primary"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('icon-spin');
    expect(html).toContain('type="button"');
  });
});

describe('Badges', () => {
  it('pairs every status colour with a dot and a text label', () => {
    const html = renderToStaticMarkup(h(StatusBadge, { status: 'waiting' }));
    expect(html).toContain('badge-dot');
    expect(html).toContain('status-waiting');
    expect(html).toContain('Waiting');
  });

  it('pairs priority with a glyph so it survives greyscale', () => {
    expect(renderToStaticMarkup(h(PriorityBadge, { priority: 'urgent' }))).toContain('▲▲');
    expect(renderToStaticMarkup(h(PriorityBadge, { priority: 'high' }))).toContain('▲');
    expect(renderToStaticMarkup(h(PriorityBadge, { priority: 'low' }))).toContain('▽');
    expect(renderToStaticMarkup(h(PriorityBadge, { priority: 'normal' }))).toContain('Normal');
  });
});
