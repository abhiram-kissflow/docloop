'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

const MESSAGES: Record<string, string> = {
  bad: 'That password is not right. Try it again.',
  empty: 'Enter the password.',
  unconfigured:
    'No password is configured on this deployment, so nobody can be let in. Set DASHBOARD_PASSWORD in the environment and redeploy.',
  network: 'The server did not answer. Check your connection and try again.',
};

const messageFor = (reason: string | null): string | null =>
  reason ? (MESSAGES[reason] ?? MESSAGES.bad) : null;

/**
 * Posts to /api/login. The form also works as a plain POST without JavaScript —
 * the route answers both, and the error then arrives back as ?error=.
 */
export default function LoginForm({
  configured,
  initialError,
}: {
  configured: boolean;
  initialError: string | null;
}) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setReason(null);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setPassword('');
        router.replace('/');
        router.refresh();
        return;
      }
      const body: unknown = await res.json().catch(() => null);
      const error = (body as { error?: unknown } | null)?.error;
      setReason(typeof error === 'string' ? error : 'bad');
    } catch {
      setReason('network');
    } finally {
      setBusy(false);
    }
  }

  const message = messageFor(reason);

  return (
    <form action="/api/login" method="post" onSubmit={onSubmit} noValidate>
      <label className="text-xs font-medium" htmlFor="password">
        Team password
      </label>

      <input
        id="password"
        name="password"
        type="password"
        className="dl-input mt-2"
        autoComplete="current-password"
        autoFocus
        required
        disabled={!configured || busy}
        aria-invalid={message ? true : undefined}
        aria-describedby={message ? 'login-error' : undefined}
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          if (reason) setReason(null);
        }}
      />

      <button
        type="submit"
        className="dl-btn dl-btn--primary mt-4 w-full"
        disabled={!configured || busy}
      >
        {busy ? 'Checking…' : 'Open the dashboard'}
      </button>

      {message && (
        <p id="login-error" role="alert" className="text-danger-ink mt-4 text-sm">
          {message}
        </p>
      )}
    </form>
  );
}
