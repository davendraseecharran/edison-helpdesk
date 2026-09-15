import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_OUTPUT_TOKENS,
  REASONING_FALLBACK,
  REASONING_LEVELS,
  effortFor,
  fallbackFor,
  isEffortRejection,
  streamResponses,
  type Reasoning,
  type ResponsesEvent,
} from '../../src/lib/ai/responses-client';

describe('effortFor', () => {
  it('passes the provider its own efforts unchanged', () => {
    expect(effortFor('high')).toEqual({ effort: 'high', summary: 'auto' });
    expect(effortFor('xhigh')).toEqual({ effort: 'xhigh', summary: 'auto' });
  });

  it('spends Max on the ceiling and the full working, not on a word the API refuses', () => {
    expect(effortFor('max')).toEqual({
      effort: 'xhigh',
      summary: 'detailed',
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
  });

  it('never sends "max" as an effort', () => {
    for (const level of REASONING_LEVELS) {
      expect(effortFor(level).effort, level).not.toBe('max');
    }
  });

  it('raises the ceiling only where the level asks for it', () => {
    for (const level of REASONING_LEVELS) {
      if (level === 'max') continue;
      expect(effortFor(level).maxOutputTokens, level).toBeUndefined();
    }
  });
});

describe('fallbackFor', () => {
  it('retries every other level at high', () => {
    expect(fallbackFor('max')).toBe(REASONING_FALLBACK);
    expect(fallbackFor('xhigh')).toBe(REASONING_FALLBACK);
    expect(fallbackFor('low')).toBe(REASONING_FALLBACK);
  });

  it('has nothing left to try once the request was already high', () => {
    expect(fallbackFor('high')).toBeNull();
  });
});

describe('isEffortRejection', () => {
  it('reads a refusal that names the effort', () => {
    expect(isEffortRejection("Unsupported reasoning.effort 'xhigh'")).toBe(true);
    expect(isEffortRejection('Invalid value for reasoning')).toBe(true);
  });

  it('leaves every other refusal alone', () => {
    expect(isEffortRejection('Model not found')).toBe(false);
  });
});

// --- The one retry, end to end ---------------------------------------------

interface SentBody {
  reasoning: { effort: string; summary: string };
  max_output_tokens?: number;
}

/** The bodies a run of `streamResponses` actually put on the wire. */
function recordFetch(statuses: Array<'refuse-effort' | 'refuse-other' | 'ok'>): SentBody[] {
  const sent: SentBody[] = [];
  let call = 0;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as SentBody);
    const outcome = statuses[call++] ?? 'ok';
    if (outcome === 'ok') {
      return Promise.resolve(
        new Response('data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    }
    const message =
      outcome === 'refuse-effort'
        ? "Unsupported reasoning.effort 'xhigh' for this model"
        : 'Model not found';
    return Promise.resolve(
      new Response(JSON.stringify({ error: { message } }), { status: 400 }),
    );
  });
  return sent;
}

async function run(reasoning: Reasoning): Promise<ResponsesEvent[]> {
  const events: ResponsesEvent[] = [];
  for await (const event of streamResponses({
    tokens: { accessToken: 'token', refreshToken: '', idToken: '', expiresAt: '' },
    chatgptAccountId: '',
    instructions: '',
    input: [],
    tools: [],
    reasoning,
    sessionId: 'session',
  })) {
    events.push(event);
  }
  return events;
}

describe('streamResponses, on a refused effort', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for Max as xhigh with the ceiling, then retries once at high', async () => {
    const sent = recordFetch(['refuse-effort', 'ok']);
    const events = await run('max');

    expect(sent).toHaveLength(2);
    expect(sent[0].reasoning).toEqual({ effort: 'xhigh', summary: 'detailed' });
    expect(sent[0].max_output_tokens).toBe(MAX_OUTPUT_TOKENS);
    // The retry is the plain level, and the ceiling goes with the level that
    // raised it.
    expect(sent[1].reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(sent[1].max_output_tokens).toBeUndefined();
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('does not retry a request that was already high', async () => {
    const sent = recordFetch(['refuse-effort']);
    const events = await run('high');

    expect(sent).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'error' });
  });

  it('does not retry a refusal that is not about the effort', async () => {
    const sent = recordFetch(['refuse-other']);
    const events = await run('max');

    expect(sent).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'Model not found' });
  });
});
