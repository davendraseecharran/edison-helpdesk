/**
 * Google Forms, in and out.
 *
 * The fixture below is a synthetic `FB_PUBLIC_LOAD_DATA_` array written for
 * this suite, in the shape a public Google Form's page carries: invented
 * questions, invented ids, nobody real. What is pinned:
 *
 *   1. The page's JSON is found and parsed without running anything, a `]`
 *      inside a title included.
 *   2. Each Google type lands as the type it should, and what cannot come
 *      (a grid, an upload) is listed with a reason rather than dropped.
 *   3. The Apps Script's JSON maps the same way.
 *   4. Titles that name a directory fact are offered as one — text questions
 *      only, once per fact.
 *   5. The fetch only ever asks Google's own form addresses, follows a
 *      redirect only onto another, and treats the sign-in page as "use the
 *      script".
 *   6. The export script builds the same form with FormApp.
 */

import { describe, expect, it } from 'vitest';
import {
  APPS_SCRIPT_READER,
  canonicalFormPath,
  directoryKeyFor,
  draftFromAppsScript,
  draftFromLoadData,
  extractLoadData,
  fieldsFromDraft,
  formJson,
  googleFormLink,
  googleFormScript,
  jsonInPaste,
  readImportInput,
  redirectTarget,
  suggestedDirectory,
} from '../src/lib/domain/google-forms';
import { fetchGoogleFormDraft } from '../src/lib/google-forms/fetch';
import type { FormField } from '../src/lib/domain/forms';

const LOAD_DATA = [
  null,
  [
    'Bring a packed lunch.\nThe bus leaves at 8.',
    [
      [111, 'Full name', null, 0, [[1001, null, 1]]],
      [112, 'Email address', null, 0, [[1002, null, 1]]],
      [113, 'Shirt size', 'Pick one', 2, [[1003, [['S'], ['M'], ['L'], ['', null, null, null, 1]], 1]]],
      [114, 'Dietary needs', null, 4, [[1004, [['Vegetarian'], ['Halal'], ['None']], 0]]],
      [115, 'Grade', null, 3, [[1005, [['9'], ['10'], ['11'], ['12']], 1]]],
      [116, 'How excited are you?', null, 5, [[1006, [['1'], ['2'], ['3'], ['4'], ['5']], 0, ['Meh', 'Very']]]],
      [117, 'Travel', 'Tell us how you get there.', 8, null],
      [118, 'Departure date', null, 9, [[1007, null, 0, null, null, null, null, [0, 1]]]],
      [119, 'Pickup time', null, 10, [[1008, null, 0]]],
      [120, 'Rate the sessions', null, 7, [[1009, [['Good'], ['Bad']], 0, ['Morning']], [1010, [['Good'], ['Bad']], 0, ['Afternoon']]]],
      [121, 'Upload your permission slip', null, 13, [[1011, null, 1]]],
      [122, 'Parent/guardian phone number', null, 0, [[1012, null, 1]]],
      [123, 'A ] tricky "title" with [brackets]', null, 1, [[1013, null, 0]]],
      [124, 'Your name', null, 0, [[1014, null, 0]]],
      [125, 'Just a heading', null, 6, null],
    ],
    null,
    null,
    null,
    null,
    null,
    null,
    'Museum of the Moving Image trip',
  ],
  '/forms',
  'Museum trip (file name)',
];

const PAGE = `<!doctype html><html><head><title>Museum trip</title></head><body><div>x</div><script type="text/javascript" nonce="abc">var FB_PUBLIC_LOAD_DATA_ = ${JSON.stringify(
  LOAD_DATA,
)}\n;</script><script>var later = [1,2,3];</script></body></html>`;

describe('the public page', () => {
  it('finds the JSON and parses it without running anything', () => {
    expect(extractLoadData(PAGE)).toEqual(LOAD_DATA);
    expect(extractLoadData('<html>no form here</html>')).toBeNull();
    expect(extractLoadData('var FB_PUBLIC_LOAD_DATA_ = [1, "unterminated')).toBeNull();
  });

  it('maps every Google type to its own, and lists what cannot come', () => {
    const draft = draftFromLoadData(extractLoadData(PAGE))!;
    expect(draft.title).toBe('Museum of the Moving Image trip');
    expect(draft.description).toBe('Bring a packed lunch.\nThe bus leaves at 8.');

    const summary = draft.questions.map((entry) => [entry.label, entry.type, entry.required]);
    expect(summary).toEqual([
      ['Full name', 'short_text', true],
      ['Email address', 'short_text', true],
      ['Shirt size', 'single_choice', true],
      ['Dietary needs', 'multi_choice', false],
      ['Grade', 'dropdown', true],
      ['How excited are you?', 'single_choice', false],
      ['Departure date', 'date', false],
      ['Pickup time', 'short_text', false],
      ['Parent/guardian phone number', 'short_text', true],
      ['A ] tricky "title" with [brackets]', 'long_text', false],
      ['Your name', 'short_text', false],
    ]);

    const shirt = draft.questions[2];
    expect(shirt.options).toEqual(['S', 'M', 'L']);
    expect(shirt.help).toBe('Pick one');
    expect(shirt.note).toContain('Other');

    const scale = draft.questions[5];
    expect(scale.options).toEqual(['1', '2', '3', '4', '5']);
    expect(scale.help).toBe('1 is Meh, 5 is Very.');
    expect(scale.note).toContain('Linear scale');

    // The section's own words, under the first question of the section.
    expect(draft.questions[6].help).toBe('Travel. Tell us how you get there.');
    expect(draft.questions[7].note).toContain('short answer');

    expect(draft.skipped.map((item) => item.label)).toEqual([
      'Rate the sessions',
      'Upload your permission slip',
      'Just a heading',
    ]);
    for (const item of draft.skipped) expect(item.reason.length).toBeGreaterThan(10);
  });

  it('offers directory questions for text questions only, and each fact once', () => {
    const draft = draftFromLoadData(extractLoadData(PAGE))!;
    const offered = draft.questions.map((entry) => entry.directory);
    expect(offered).toEqual([
      'full_name',
      'email',
      null,
      null,
      // A dropdown called Grade stays a dropdown: its choices are not a class.
      null,
      null,
      null,
      null,
      'guardian_phone',
      null,
      // "Your name" is a second full name: the first question keeps the fact.
      null,
    ]);

    const fields = fieldsFromDraft(draft, suggestedDirectory(draft));
    expect(fields.filter((field) => field.type === 'directory').map((field) => field.directory)).toEqual([
      'full_name',
      'email',
      'guardian_phone',
    ]);
    // The label stays Google's own.
    expect(fields[0]).toMatchObject({ type: 'directory', label: 'Full name', required: true });
    expect(new Set(fields.map((field) => field.id)).size).toBe(fields.length);
    for (const field of fields) expect(field.id).toMatch(/^[a-z0-9]{4,16}$/);

    // Untick them all and nothing is a directory question.
    expect(fieldsFromDraft(draft, new Set()).some((field) => field.type === 'directory')).toBe(false);
  });

  it('reads a title the way an officer writes it', () => {
    expect(directoryKeyFor('Name')).toBe('full_name');
    expect(directoryKeyFor('Student Name')).toBe('full_name');
    expect(directoryKeyFor('First and last name')).toBe('full_name');
    expect(directoryKeyFor('First name')).toBeNull();
    expect(directoryKeyFor('Project name')).toBeNull();
    expect(directoryKeyFor('OSIS #')).toBe('external_id');
    expect(directoryKeyFor('Student ID number')).toBe('external_id');
    expect(directoryKeyFor('E-mail')).toBe('email');
    expect(directoryKeyFor('Class of')).toBe('class_of');
    expect(directoryKeyFor('Official class')).toBe('official_class');
    expect(directoryKeyFor('Grade')).toBe('official_class');
    expect(directoryKeyFor('Which class are you taking for credit?')).toBeNull();
    expect(directoryKeyFor("Parent's name")).toBe('guardian_name');
    expect(directoryKeyFor('Parent/Guardian cell')).toBe('guardian_phone');
    expect(directoryKeyFor('Parent email')).toBeNull();
    expect(directoryKeyFor('Favourite colour')).toBeNull();
  });
});

describe('the Apps Script route', () => {
  const SCRIPT_JSON = {
    source: 'edison-apps-script',
    version: 1,
    title: 'Robotics sign-up',
    description: 'Tuesdays after school.',
    items: [
      { type: 'TEXT', title: 'Full name', help: '', required: true },
      { type: 'PARAGRAPH_TEXT', title: 'Why do you want to join?', help: '', required: false },
      { type: 'MULTIPLE_CHOICE', title: 'Team', help: '', required: true, choices: ['Build', 'Code', 'Drive'], other: true },
      { type: 'CHECKBOX', title: 'Days', help: '', required: false, choices: ['Tue', 'Thu'], other: false },
      { type: 'LIST', title: 'Shirt', help: '', required: false, choices: ['S', 'M', 'L'] },
      { type: 'SCALE', title: 'Experience', help: '', required: false, lower: 0, upper: 3, lowerLabel: 'None', upperLabel: 'Lots' },
      { type: 'DATETIME', title: 'Available from', help: '', required: false },
      { type: 'DURATION', title: 'How long can you stay?', help: '', required: false },
      { type: 'SECTION_HEADER', title: 'Guardian', help: 'Somebody we can call.' },
      { type: 'TEXT', title: 'Guardian name', help: '', required: true },
      { type: 'CHECKBOX_GRID', title: 'Availability grid', help: '' },
      { type: 'FILE_UPLOAD', title: 'Photo release', help: '' },
      { type: 'PAGE_BREAK', title: 'Page two', help: '' },
      { type: 'IMAGE', title: 'Logo', help: '' },
    ],
  };

  it('maps FormApp item types onto the same questions', () => {
    const draft = draftFromAppsScript(SCRIPT_JSON)!;
    expect(draft.source).toBe('apps_script');
    expect(draft.title).toBe('Robotics sign-up');
    expect(draft.questions.map((entry) => [entry.label, entry.type])).toEqual([
      ['Full name', 'short_text'],
      ['Why do you want to join?', 'long_text'],
      ['Team', 'single_choice'],
      ['Days', 'multi_choice'],
      ['Shirt', 'dropdown'],
      ['Experience', 'single_choice'],
      ['Available from', 'date'],
      ['How long can you stay?', 'short_text'],
      ['Guardian name', 'short_text'],
    ]);
    expect(draft.questions[2].note).toContain('Other');
    expect(draft.questions[5].options).toEqual(['0', '1', '2', '3']);
    expect(draft.questions[5].help).toBe('0 is None, 3 is Lots.');
    expect(draft.questions[6].note).toContain('time of day');
    expect(draft.questions[8].help).toBe('Guardian. Somebody we can call.');
    expect(draft.questions[8].directory).toBe('guardian_name');
    expect(draft.skipped.map((item) => item.label)).toEqual(['Availability grid', 'Photo release', 'Page two', 'Logo']);
  });

  it('takes the JSON out of whatever was pasted with it', () => {
    const log = `10:31:05 AM\tNotice\tExecution started\n10:31:06 AM\tInfo\t${JSON.stringify(SCRIPT_JSON)}\n10:31:06 AM\tNotice\tExecution completed`;
    expect(jsonInPaste(log)).toEqual(SCRIPT_JSON);
    const input = readImportInput(log);
    expect(input.kind).toBe('draft');
    expect(readImportInput('{"source":"edison-apps-script","items":[').kind).toBe('unreadable');
    expect(readImportInput('{"hello":"world"}')).toMatchObject({ kind: 'unreadable' });
  });

  it('is a script that only reads, and asks for the edit link', () => {
    expect(APPS_SCRIPT_READER).toContain('FormApp.openByUrl(FORM_EDIT_LINK)');
    expect(APPS_SCRIPT_READER).toContain('PASTE_THE_EDIT_LINK_HERE');
    expect(APPS_SCRIPT_READER).toContain("source: 'edison-apps-script'");
    expect(APPS_SCRIPT_READER).not.toMatch(/\.(create|setTitle|deleteItem|addTextItem)\(/);
    for (const type of ['MULTIPLE_CHOICE', 'CHECKBOX', 'LIST', 'SCALE', 'PARAGRAPH_TEXT', 'DATE']) {
      expect(APPS_SCRIPT_READER).toContain(`FormApp.ItemType.${type}`);
    }
  });

  it('round-trips this helpdesk’s own JSON download', () => {
    const fields: FormField[] = [
      { id: 'aaaa', type: 'directory', directory: 'external_id', label: 'OSIS', help: '', required: true },
      { id: 'bbbb', type: 'yes_no', label: 'Taking the bus', help: '', required: false },
      { id: 'cccc', type: 'single_choice', label: 'Shirt', help: '', required: false, options: ['S', 'M'] },
    ];
    const input = readImportInput(JSON.stringify(formJson({ title: 'Trip', description: '', audience: 'directory', fields })));
    expect(input.kind).toBe('draft');
    if (input.kind !== 'draft') return;
    const back = fieldsFromDraft(input.draft, suggestedDirectory(input.draft));
    expect(back.map((field) => [field.type, field.label, field.directory ?? null])).toEqual([
      ['directory', 'OSIS', 'external_id'],
      ['yes_no', 'Taking the bus', null],
      ['single_choice', 'Shirt', null],
    ]);
  });
});

describe('links', () => {
  it('accepts a Google Form address and rebuilds it from the id', () => {
    expect(googleFormLink('https://docs.google.com/forms/d/e/1FAIpQLSfSyntheticForm0001/viewform?usp=sf_link')).toEqual({
      ok: true,
      url: 'https://docs.google.com/forms/d/e/1FAIpQLSfSyntheticForm0001/viewform',
      short: false,
    });
    expect(googleFormLink('docs.google.com/forms/u/1/d/1AbCdEfGhIjKlMnOp/edit#responses')).toEqual({
      ok: true,
      url: 'https://docs.google.com/forms/d/1AbCdEfGhIjKlMnOp/viewform',
      short: false,
    });
    expect(googleFormLink('https://forms.gle/AbC123xyz')).toEqual({ ok: true, url: 'https://forms.gle/AbC123xyz', short: true });
  });

  it('refuses everything else before any request is made', () => {
    for (const bad of [
      'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit',
      'https://docs.google.com.evil.example/forms/d/e/1FAIpQLSfSyntheticForm0001/viewform',
      'https://evil.example/forms/d/e/1FAIpQLSfSyntheticForm0001/viewform',
      'http://169.254.169.254/latest/meta-data',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a link at all',
    ]) {
      expect(googleFormLink(bad).ok, bad).toBe(false);
    }
    expect(canonicalFormPath('/forms/d/e/short/viewform')).toBeNull();
  });

  it('follows a redirect only onto another form, and hears sign-in as sign-in', () => {
    const from = 'https://forms.gle/AbC123xyz';
    expect(redirectTarget('https://docs.google.com/forms/d/e/1FAIpQLSfSyntheticForm0001/viewform?usp=send_form', from)).toEqual({
      kind: 'form',
      url: 'https://docs.google.com/forms/d/e/1FAIpQLSfSyntheticForm0001/viewform',
    });
    expect(redirectTarget('https://accounts.google.com/v3/signin/identifier?continue=x', from)).toEqual({ kind: 'signin' });
    expect(redirectTarget('https://evil.example/forms/d/e/1FAIpQLSfSyntheticForm0001/viewform', from)).toEqual({
      kind: 'refused',
    });
    expect(redirectTarget('http://docs.google.com/forms/d/e/1FAIpQLSfSyntheticForm0001/viewform', from)).toEqual({
      kind: 'refused',
    });
  });
});

describe('the fetch', () => {
  interface Seen {
    url: string;
    init: RequestInit | undefined;
  }

  function stub(answers: Array<(url: string) => Response>): { fetcher: typeof fetch; seen: Seen[] } {
    const seen: Seen[] = [];
    let at = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, init });
      const answer = answers[at];
      at += 1;
      if (!answer) throw new Error('no more answers');
      return answer(url);
    }) as typeof fetch;
    return { fetcher, seen };
  }

  it('follows forms.gle to the form by hand, with no cookies and no referrer', async () => {
    const { fetcher, seen } = stub([
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://docs.google.com/forms/d/e/1FAIpQLSfSyntheticForm0001/viewform?usp=send_form' },
        }),
      () => new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } }),
    ]);
    const result = await fetchGoogleFormDraft('https://forms.gle/AbC123xyz', fetcher);
    expect(result.ok).toBe(true);
    expect(seen.map((entry) => entry.url)).toEqual([
      'https://forms.gle/AbC123xyz',
      'https://docs.google.com/forms/d/e/1FAIpQLSfSyntheticForm0001/viewform',
    ]);
    for (const entry of seen) {
      expect(entry.init).toMatchObject({ redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer' });
      expect(JSON.stringify(entry.init?.headers ?? {})).not.toMatch(/cookie/i);
    }
  });

  it('never follows a redirect off Google’s form addresses', async () => {
    const { fetcher, seen } = stub([
      () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
    ]);
    const result = await fetchGoogleFormDraft('https://forms.gle/AbC123xyz', fetcher);
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect(seen).toHaveLength(1);
  });

  it('turns a sign-in, by redirect or by page, into "use the script"', async () => {
    const byRedirect = stub([
      () => new Response(null, { status: 302, headers: { location: 'https://accounts.google.com/ServiceLogin?continue=x' } }),
    ]);
    expect(await fetchGoogleFormDraft('https://docs.google.com/forms/d/e/1FAIpQLSfSyntheticForm0001/viewform', byRedirect.fetcher)).toMatchObject({
      ok: false,
      reason: 'signin',
    });
    const byPage = stub([
      () => new Response('<html><title>Sign in - Google Accounts</title><a href="https://accounts.google.com/v3/signin/x">', { status: 200 }),
    ]);
    expect(await fetchGoogleFormDraft('https://docs.google.com/forms/d/e/1FAIpQLSfSyntheticForm0001/viewform', byPage.fetcher)).toMatchObject({
      ok: false,
      reason: 'signin',
    });
  });

  it('stops at a page larger than a form, and at a link that is not one', async () => {
    const big = stub([() => new Response('x', { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } })]);
    expect(await fetchGoogleFormDraft('https://docs.google.com/forms/d/e/1FAIpQLSfSyntheticForm0001/viewform', big.fetcher)).toMatchObject({
      ok: false,
      reason: 'too_large',
    });
    const never = stub([]);
    expect(await fetchGoogleFormDraft('http://127.0.0.1:54321/rest/v1/', never.fetcher)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(never.seen).toHaveLength(0);
  });
});

describe('the export script', () => {
  const fields: FormField[] = [
    { id: 'n1', type: 'directory', directory: 'full_name', label: 'Full name', help: '', required: true },
    { id: 'e1', type: 'directory', directory: 'email', label: 'School email', help: '', required: true },
    { id: 's1', type: 'single_choice', label: 'Shirt "size"', help: 'Pick one', required: true, options: ['S', 'M'] },
    { id: 'm1', type: 'multi_choice', label: 'Days', help: '', required: false, options: ['Tue', 'Thu'] },
    { id: 'd1', type: 'dropdown', label: 'Bus', help: '', required: false, options: ['A', 'B'] },
    { id: 'y1', type: 'yes_no', label: 'Photo release', help: '', required: false },
    { id: 'u1', type: 'number', label: 'Age', help: '', required: false },
    { id: 't1', type: 'date', label: 'Day', help: '', required: false },
    { id: 'l1', type: 'long_text', label: 'Anything else?\n</script>', help: '', required: false },
    { id: 'g1', type: 'signature', label: 'Guardian signature', help: '', required: true },
  ];

  it('makes the same form with FormApp, and says what will differ', () => {
    const { script, notes } = googleFormScript({ title: 'Trip sign-up', description: 'Bring lunch.', fields });
    expect(script).toContain('FormApp.create("Trip sign-up")');
    expect(script).toContain('form.setDescription("Bring lunch.")');
    expect(script).toContain('form.addTextItem().setTitle("Full name").setRequired(true)');
    expect(script).toContain('requireTextIsEmail()');
    expect(script).toContain(
      'form.addMultipleChoiceItem().setTitle("Shirt \\"size\\"").setChoiceValues(["S", "M"]).setHelpText("Pick one").setRequired(true);',
    );
    expect(script).toContain('form.addCheckboxItem().setTitle("Days").setChoiceValues(["Tue", "Thu"])');
    expect(script).toContain('form.addListItem().setTitle("Bus")');
    expect(script).toContain(`setChoiceValues(['Yes', 'No'])`);
    expect(script).toContain('requireNumber()');
    expect(script).toContain('form.addDateItem().setTitle("Day")');
    // Text is a JSON string literal: a line break or a closing tag stays text.
    expect(script).toContain('"Anything else?\\n</script>"');
    expect(script).not.toContain('Guardian signature").');
    expect(script).toContain('getPublishedUrl()');
    expect(notes.join(' ')).toContain('signature');
    expect(notes.join(' ')).toContain('directory');
  });
});
