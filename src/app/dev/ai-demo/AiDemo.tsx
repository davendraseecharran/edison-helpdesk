'use client';

/**
 * A stand-in shell around the real panel, with the server replaced by a
 * script. `?scenario=` picks what the script does; `?theme=` pins a theme;
 * `?pace=` scales the delays (1 is the written pace, 0 is instant).
 *
 * The transport builds an NDJSON stream exactly as the route would, one
 * line at a time with pauses, so the panel exercises the same code it uses
 * in production. Only the words are invented.
 */

import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AppRuntimeProvider } from '@/components/AppRuntime';
import { Flash } from '@/components/Primitives';
import { AiPanel } from '@/components/ai/AiPanel';
import { openAssistant } from '@/components/ai/assistant-store';
import type { AiServices, AiStatus } from '@/components/ai/services';
import { defaultTransport, turnsFromTranscript, type ChatRequest, type Turn } from '@/components/ai/useAiChat';
import { AiToggle } from '@/components/shell/AiToggle';
import { useTheme } from '@/components/shell/ThemeProvider';
import { SkeletonPanel } from '@/components/ui/Skeleton';
import type { ActorAccount } from '@/lib/auth/session';
import { Plus } from 'lucide-react';
import { ButtonLink } from '@/components/ui/Button';

type Line = Record<string, unknown>;
/** A number is a pause in milliseconds; an object is one NDJSON line. */
type Script = Array<Line | number>;

const ACTOR: ActorAccount = {
  id: 'demo-actor',
  displayName: 'Priya Raman',
  email: 'priya.raman@edison.example',
  role: 'technician',
  roles: ['netrider'],
  status: 'active',
  credentialActionPending: false,
  sessionIsCurrent: true,
  schemaBehind: false,
};

const STATUS: AiStatus = {
  enabled: true,
  connected: true,
  email: 'priya.raman@edison.example',
  planType: 'plus',
  reasoning: 'high',
  confirmChanges: false,
  speakReplies: false,
  welcomeStates: ['generating', 'listening'],
  model: 'gpt-6-luna',
  modelLabel: 'GPT-6 Luna',
};

const REPLY = [
  'Three tickets are waiting, and one of them is older than the rest:',
  '',
  '- **EDT-1042** Projector in room 214 shows no signal, opened yesterday',
  '- **EDT-1047** Chromebook `CB-2201` will not charge',
  '- **EDT-1051** Staff laptop missing from the cart',
  '',
  'The projector one has been waiting longest. Want me to [open it](/tickets/EDT-1042) or claim it for you?',
].join('\n');

const REASONING =
  'The person wants the open queue. I should list what is waiting, oldest first, and point out anything that has been waiting unusually long.';

function words(text: string): string[] {
  return text.split(/(?<=\s)/);
}

function deltas(text: string, gap: number, type: 'delta' | 'reasoning' = 'delta'): Script {
  const out: Script = [];
  for (const piece of words(text)) {
    out.push({ type, text: piece }, gap);
  }
  return out;
}

const SCRIPTS: Record<string, (body: ChatRequest) => Script> = {
  streaming: () => [
    { type: 'phase', phase: 'thinking' },
    600,
    ...deltas(REASONING, 45, 'reasoning'),
    400,
    { type: 'phase', phase: 'writing' },
    ...deltas(REPLY, 55),
    { type: 'done' },
  ],
  reasoning: () => [
    { type: 'phase', phase: 'thinking' },
    800,
    ...deltas(`${REASONING} ${REASONING} ${REASONING}`, 120, 'reasoning'),
    { type: 'phase', phase: 'writing' },
    ...deltas(REPLY, 40),
    { type: 'done' },
  ],
  tools: () => [
    { type: 'phase', phase: 'thinking' },
    500,
    ...deltas('Look the queue up first, then the projector ticket.', 40, 'reasoning'),
    { type: 'phase', phase: 'tool' },
    {
      type: 'tool_call',
      callId: 'c1',
      name: 'search_records',
      args: { query: 'projector' },
      summary: 'Search records (query: projector)',
      needsApproval: false,
    },
    1600,
    { type: 'tool_result', callId: 'c1', ok: true, summary: 'Found 3 records for "projector"' },
    300,
    { type: 'phase', phase: 'tool' },
    {
      type: 'tool_call',
      callId: 'c2',
      name: 'get_ticket',
      args: { ticket: 'EDT-1042' },
      summary: 'Get ticket (ticket: EDT-1042)',
      needsApproval: false,
    },
    1200,
    { type: 'tool_result', callId: 'c2', ok: true, summary: 'Read EDT-1042' },
    300,
    { type: 'phase', phase: 'tool' },
    {
      type: 'tool_call',
      callId: 'c3',
      name: 'claim_ticket',
      args: { ticket: 'EDT-1042' },
      summary: 'Claim ticket (ticket: EDT-1042)',
      needsApproval: false,
    },
    1400,
    { type: 'tool_result', callId: 'c3', ok: true, summary: 'Claimed EDT-1042' },
    200,
    { type: 'phase', phase: 'tool' },
    {
      type: 'tool_call',
      callId: 'c4',
      name: 'set_priority',
      args: { ticket: 'EDT-1042', priority: 'urgent' },
      summary: 'Set priority (ticket: EDT-1042, priority: urgent)',
      needsApproval: false,
    },
    900,
    {
      type: 'tool_result',
      callId: 'c4',
      ok: false,
      summary: 'Could not set the priority: only an administrator can mark a ticket urgent.',
    },
    400,
    { type: 'phase', phase: 'writing' },
    ...deltas(
      'Claimed **EDT-1042** for you. I could not raise it to urgent: that needs an administrator. It is yours at high priority, and the requester has been told.',
      45,
    ),
    { type: 'done' },
  ],
  approval: (body) =>
    body.approve?.length
      ? [
          { type: 'phase', phase: 'tool' },
          1200,
          { type: 'tool_result', callId: 'a1', ok: true, summary: 'Claimed EDT-1042' },
          300,
          { type: 'phase', phase: 'writing' },
          ...deltas('Done. **EDT-1042** is yours now; I added a note saying you are on your way to room 214.', 45),
          { type: 'done' },
        ]
      : body.reject?.length
        ? [
            { type: 'phase', phase: 'tool' },
            400,
            { type: 'tool_result', callId: 'a1', ok: false, summary: 'Not approved: Claim ticket (ticket: EDT-1042)' },
            { type: 'phase', phase: 'writing' },
            ...deltas('Left it in the queue. Say the word if you change your mind.', 45),
            { type: 'done' },
          ]
        : [
            { type: 'phase', phase: 'thinking' },
            500,
            ...deltas('Claiming a ticket is a change, so the application will ask first.', 40, 'reasoning'),
            { type: 'phase', phase: 'tool' },
            {
              type: 'tool_call',
              callId: 'a1',
              name: 'claim_ticket',
              args: { ticket: 'EDT-1042', note: 'On my way to room 214 with a spare HDMI cable.' },
              summary: 'Claim ticket (ticket: EDT-1042)',
              needsApproval: true,
            },
            { type: 'done' },
          ],
  error: () => [
    { type: 'phase', phase: 'thinking' },
    900,
    ...deltas('Looking at the queue.', 60, 'reasoning'),
    600,
    { type: 'error', message: 'ChatGPT is over capacity right now. Wait a moment and try again.' },
    { type: 'done' },
  ],
  notice: () => [
    { type: 'error', message: 'Could not read your assistant settings; changes will ask for approval this turn.' },
    { type: 'phase', phase: 'thinking' },
    400,
    { type: 'phase', phase: 'writing' },
    ...deltas('Settings were briefly unreadable, so anything I change this turn will ask you first.', 45),
    { type: 'done' },
  ],
};

const HISTORY: Turn[] = turnsFromTranscript([
  { role: 'user', text: 'Anything waiting on a requester today?' },
  { role: 'tool', callId: 'h1', name: 'list_queue', summary: 'List queue (status: waiting)', ok: true },
  {
    role: 'assistant',
    text: 'Two tickets are waiting on their requesters: **EDT-1038** (waiting since Monday for a loaner return) and **EDT-1044** (asked the teacher which cart the laptop came from).',
  },
  { role: 'user', text: 'Nudge the second one and claim the first' },
  { role: 'tool', callId: 'h2', name: 'add_note', summary: 'Add note (ticket: EDT-1044)', ok: true },
  { role: 'tool', callId: 'h3', name: 'claim_ticket', summary: 'Claim ticket (ticket: EDT-1038)', ok: true },
  {
    role: 'assistant',
    text: 'Added a note on **EDT-1044** asking about the cart, and claimed **EDT-1038** for you. Both requesters have been notified.',
  },
]);

function stream(script: Script, pace: number, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const step of script) {
        if (signal.aborted) break;
        if (typeof step === 'number') {
          await new Promise((resolve) => setTimeout(resolve, step * pace));
          continue;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify(step)}\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

function problem(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function demoServices(scenario: string, pace: number, connectAfter: number): AiServices {
  let polls = 0;
  const connected = scenario !== 'connect' && scenario !== 'pairing';
  const status: AiStatus = {
    ...STATUS,
    enabled: scenario !== 'disabled',
    connected,
    confirmChanges: scenario === 'approval',
  };
  let live = { ...status };

  return {
    status: async () => live,
    updatePreferences: async (patch) => {
      live = { ...live, ...patch };
      return { ok: true };
    },
    startAuth: async () => {
      await new Promise((resolve) => setTimeout(resolve, 600 * pace));
      return {
        ok: true,
        start: {
          deviceAuthId: 'demo-device',
          userCode: 'HXKQ-7M2P',
          intervalSeconds: 2,
          verifyUrl: 'https://chatgpt.com/codex/device',
        },
      };
    },
    pollAuth: async () => {
      polls += 1;
      if (connectAfter > 0 && polls >= connectAfter) {
        live = { ...live, connected: true };
        return { ok: true, status: 'complete' };
      }
      return { ok: true, status: 'pending' };
    },
    disconnect: async () => {
      live = { ...live, connected: false };
      return { ok: true };
    },
    listConversations: async () => ({
      ok: true,
      conversations: [
        { id: 'k1', title: 'Anything waiting on a requester today?', updatedAt: new Date(Date.now() - 3 * 60_000).toISOString() },
        { id: 'k2', title: 'Which Chromebooks are out for repair', updatedAt: new Date(Date.now() - 26 * 3_600_000).toISOString() },
        { id: 'k3', title: 'Log 45 minutes on the projector job', updatedAt: new Date(Date.now() - 4 * 86_400_000).toISOString() },
      ],
    }),
    loadConversation: async () => ({ ok: true, title: 'Anything waiting on a requester today?', items: [], pending: [] }),
    deleteConversation: async () => ({ ok: true }),
    /*
     * `pictures` is the one scenario that talks to the real endpoint.
     *
     * Everything else about the panel can be shown with a scripted stream,
     * because what is interesting is what arrives. The picture path is the
     * opposite: what is interesting is what the composer SENDS, and a
     * transport that never touches the network is a transport nothing can
     * read the request off. Opened without an intercept in front of it, this
     * is simply the real assistant, and says so if no account is connected.
     */
    transport: scenario === 'pictures' ? defaultTransport : async (body, signal) => {
      if (scenario === 'signed-out') return problem(401, 'signed_out', 'Your session is not able to do that. Sign in again.');
      if (!live.connected) return problem(409, 'not_connected', 'Connect a ChatGPT account before using the assistant.');
      const script = SCRIPTS[scenario] ?? SCRIPTS.streaming;
      return stream([{ type: 'conversation', id: 'demo' }, ...script(body)], pace, signal);
    },
  };
}

/** A recognition stand-in so the listening state can be photographed. */
class FakeRecognition {
  lang = '';
  interimResults = false;
  continuous = false;
  onresult: ((event: { resultIndex: number; results: Array<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private timer = 0;
  private said = 0;
  private static PHRASES = [
    'find the',
    'find the projector',
    'find the projector ticket in',
    'find the projector ticket in room 214',
  ];
  start() {
    this.timer = window.setInterval(() => {
      const text = FakeRecognition.PHRASES[Math.min(this.said, FakeRecognition.PHRASES.length - 1)];
      this.said += 1;
      this.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: text } }] });
    }, 500);
  }
  stop() {
    window.clearInterval(this.timer);
    this.onend?.();
  }
  abort() {
    this.stop();
  }
}

function installFakeRecognition() {
  const scope = window as unknown as { webkitSpeechRecognition?: unknown };
  if (!scope.webkitSpeechRecognition) scope.webkitSpeechRecognition = FakeRecognition;
}

export function AiDemo() {
  const params = useSearchParams();
  const scenario = params.get('scenario') ?? 'welcome';
  const wanted = params.get('theme');
  const pace = Number(params.get('pace') ?? '1');
  const connectAfter = Number(params.get('connectAfter') ?? '0');
  const { setTheme } = useTheme();

  if (typeof window !== 'undefined' && scenario === 'listening') installFakeRecognition();

  useEffect(() => {
    if (wanted === 'dark' || wanted === 'light') void setTheme(wanted);
  }, [wanted, setTheme]);

  const services = useMemo(
    () => demoServices(scenario, Number.isFinite(pace) ? pace : 1, connectAfter),
    [scenario, pace, connectAfter],
  );

  const prompt = SCRIPTS[scenario]
    ? scenario === 'approval'
      ? 'Claim EDT-1042 for me and say I am on my way'
      : scenario === 'tools'
        ? 'Claim the projector ticket and make it urgent'
        : 'What is waiting in the queue?'
    : null;

  useEffect(() => {
    if (prompt) openAssistant({ prompt });
    else if (scenario === 'pairing') openAssistant({ section: 'connect' });
    else openAssistant();
  }, [prompt, scenario]);

  return (
    <AppRuntimeProvider actor={ACTOR} directory={[]} today="2026-09-13">
      <div className="shell">
        <header className="topbar">
          <Link href="/queue" className="brand" aria-label="Edison Helpdesk">
            <span className="brand-name" aria-hidden="true">
              Edison<span className="brand-name-tail">Helpdesk</span>
            </span>
          </Link>
          <div className="topbar-lookup" />
          <div className="topbar-actions">
            <ButtonLink href="/tickets/new" variant="primary" icon={Plus} collapseOnPhone>
              New ticket
            </ButtonLink>
            <AiToggle />
          </div>
        </header>
        <nav className="rail" aria-hidden="true" />
        <main className="main">
          <Flash />
          <div className="page-header">
            <div className="page-header-text">
              <h1>Queue</h1>
              <p>A stand-in page behind the assistant panel, scenario: {scenario}.</p>
            </div>
          </div>
          <SkeletonPanel title={120} lines={6} />
        </main>
        <AiPanel
          key={scenario}
          services={services}
          initialTurns={scenario === 'history' ? HISTORY : undefined}
        />
      </div>
    </AppRuntimeProvider>
  );
}
