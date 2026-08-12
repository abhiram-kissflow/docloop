import LoginForm from '@/components/login-form';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Docloop — sign in' };

// One password for the whole documentation team. The gate exists because this
// screen carries text derived from real support conversations and sits on a
// public URL; it is not an account system and does not pretend to be one.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.error) ? params.error[0] : params.error;
  const configured = Boolean(process.env.DASHBOARD_PASSWORD);

  return (
    <main className="dl-center">
      <div className="dl-login">
        <h1 className="dl-title">Docloop</h1>
        <p className="text-muted mt-2 text-sm">
          The review queue is behind a shared password. Ask the documentation lead for it.
        </p>

        <div className="mt-8">
          <LoginForm configured={configured} initialError={raw ?? null} />
        </div>
      </div>
    </main>
  );
}
