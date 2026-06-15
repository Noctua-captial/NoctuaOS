import { authEnabled } from "@/lib/auth";
import { LoginForm } from "@/components/login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="serif text-4xl font-semibold tracking-wide text-parchment">NOCTUA</div>
          <div className="label mt-2">Decision Intelligence — Restricted</div>
        </div>
        <LoginForm from={from ?? "/"} enabled={authEnabled()} />
      </div>
    </div>
  );
}
