'use client';

/**
 * Linking a ChatGPT account, in the panel.
 *
 * Press Connect ChatGPT and the server starts the Codex device flow; what
 * comes back is a short code to type into chatgpt.com. The card shows the
 * code large, offers to copy it, opens the page in a new tab, and asks the
 * server on the interval the service named whether the code has been used.
 * The provider's own mark turns slowly while that waits — this is the one
 * place in the product that is about ChatGPT rather than about the assistant,
 * so it wears ChatGPT's mark rather than the orb. Cancel stops the asking; so
 * does closing the panel.
 *
 * When there already is a connection the same card says whose it is and
 * offers Disconnect, which is where Settings sends people.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { AiMark } from './AiMark';
import type { AiServices } from './services';

const VERIFY_URL = 'https://chatgpt.com/codex/device';

/** Device codes expire; stop asking after this long and say so. */
const PAIRING_LIMIT_MS = 15 * 60 * 1000;

type Step =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'pairing'; userCode: string; intervalSeconds: number; verifyUrl: string }
  | { kind: 'error'; message: string };

/** "plus" as ChatGPT writes it, "Plus" as a person reads it. */
function planLabel(plan: string | null): string | null {
  const trimmed = plan?.trim();
  if (!trimmed) return null;
  return trimmed
    .split(/[\s_-]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function AiConnectCard({
  services,
  connection,
  notify,
  onConnected,
  onDisconnected,
  autoStart = false,
}: {
  services: AiServices;
  /** The current connection, or null when there is none. */
  connection: { email: string | null; planType: string | null } | null;
  notify: (kind: 'success' | 'error', text: string) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  /** Begin the device flow as soon as the card shows. */
  autoStart?: boolean;
}) {
  // "Starting" is a state rather than a call, so the card can begin in it
  // (Settings sends people here to connect) and one effect does the asking.
  const [step, setStep] = useState<Step>(() =>
    autoStart && connection === null ? { kind: 'starting' } : { kind: 'idle' },
  );
  const [copied, setCopied] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const alive = useRef(true);
  // When the code on screen stops being worth asking about. Set once, where the
  // code is issued, so a re-run of the poll effect cannot push the deadline out
  // and leave an expired code saying "Waiting…" forever.
  const expiresAt = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (step.kind !== 'starting') return;
    let cancelled = false;
    void services.startAuth().then((result) => {
      if (cancelled || !alive.current) return;
      if (!result.ok || !result.start) {
        setStep({ kind: 'error', message: result.error ?? 'ChatGPT did not answer. Try again.' });
        return;
      }
      expiresAt.current = Date.now() + PAIRING_LIMIT_MS;
      setStep({
        kind: 'pairing',
        userCode: result.start.userCode,
        intervalSeconds: Math.max(2, result.start.intervalSeconds || 5),
        verifyUrl: result.start.verifyUrl || VERIFY_URL,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [step, services]);

  const start = useCallback(() => setStep({ kind: 'starting' }), []);

  // The poll. Lives and dies with the pairing step: a cancel, an error, or
  // the panel closing unmounts this effect and nothing asks again. The props it
  // depends on are stable, so a parent re-render does not restart it; the
  // deadline is held outside the effect in case one ever does.
  useEffect(() => {
    if (step.kind !== 'pairing') return;
    const { userCode, intervalSeconds } = step;
    let cancelled = false;
    let timer = 0;

    const ask = async () => {
      if (cancelled) return;
      if (Date.now() > expiresAt.current) {
        setStep({ kind: 'error', message: 'That code has expired. Start again to get a new one.' });
        return;
      }
      const result = await services.pollAuth(userCode);
      if (cancelled) return;
      if (!result.ok) {
        setStep({ kind: 'error', message: result.error ?? 'ChatGPT did not answer. Try again.' });
        return;
      }
      if (result.status === 'complete') {
        notify('success', 'ChatGPT connected');
        onConnected();
        return;
      }
      timer = window.setTimeout(() => void ask(), intervalSeconds * 1000);
    };

    timer = window.setTimeout(() => void ask(), intervalSeconds * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [step, services, notify, onConnected]);

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      notify('error', 'Could not copy the code. Select it and copy it yourself.');
    }
  }

  async function disconnect() {
    setDisconnecting(true);
    const result = await services.disconnect();
    if (!alive.current) return;
    setDisconnecting(false);
    if (!result.ok) {
      notify('error', result.error ?? 'Could not disconnect. Try again.');
      return;
    }
    notify('success', 'ChatGPT disconnected');
    onDisconnected();
  }

  if (connection) {
    const plan = planLabel(connection.planType);
    return (
      <section className="ai-connect" aria-labelledby="ai-connect-title">
        <AiMark size={40} className="ai-connect-mark" />
        <h3 id="ai-connect-title" className="ai-connect-title">
          Connected to ChatGPT
        </h3>
        <p className="ai-connect-text">
          {connection.email ? (
            <>
              Signed in as <strong>{connection.email}</strong>
              {plan ? ` on ${plan}` : ''}. The assistant acts as you, through this account.
            </>
          ) : (
            'The assistant acts as you, through your ChatGPT account.'
          )}
        </p>
        <div className="ai-connect-actions">
          <Button variant="danger" onClick={() => void disconnect()} loading={disconnecting}>
            Disconnect
          </Button>
        </div>
      </section>
    );
  }

  if (step.kind === 'pairing') {
    return (
      <section className="ai-connect ai-connect-pairing" aria-labelledby="ai-connect-title">
        <AiMark size={40} waiting className="ai-connect-mark" />
        <h3 id="ai-connect-title" className="ai-connect-title">
          Enter this code in ChatGPT
        </h3>
        <div className="ai-code-row">
          <output className="ai-code mono" aria-label={`Device code ${step.userCode.split('').join(' ')}`}>
            {step.userCode}
          </output>
          <Button
            variant="ghost"
            icon={copied ? Check : Copy}
            aria-label={copied ? 'Copied' : 'Copy code'}
            title={copied ? 'Copied' : 'Copy code'}
            onClick={() => void copyCode(step.userCode)}
          />
        </div>
        <a className="btn btn-primary ai-connect-link" href={step.verifyUrl} target="_blank" rel="noopener noreferrer">
          <Icon icon={ExternalLink} size={18} />
          Open chatgpt.com/codex/device
        </a>
        <p className="ai-connect-waiting" role="status">
          Waiting for you to approve in ChatGPT…
        </p>
        <div className="ai-connect-actions">
          <Button variant="ghost" onClick={() => setStep({ kind: 'idle' })}>
            Cancel
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="ai-connect" aria-labelledby="ai-connect-title">
      <AiMark size={40} className="ai-connect-mark" />
      <h3 id="ai-connect-title" className="ai-connect-title">
        Connect ChatGPT
      </h3>
      <p className="ai-connect-text">
        The assistant works through your own ChatGPT account and acts as you. You will get a short
        code to enter on chatgpt.com; nothing else is needed.
      </p>
      {step.kind === 'error' ? (
        <p className="ai-connect-error" role="alert">
          {step.message}
        </p>
      ) : null}
      <div className="ai-connect-actions">
        <Button variant="primary" onClick={start} loading={step.kind === 'starting'}>
          {step.kind === 'error' ? 'Try again' : 'Connect ChatGPT'}
        </Button>
      </div>
    </section>
  );
}
