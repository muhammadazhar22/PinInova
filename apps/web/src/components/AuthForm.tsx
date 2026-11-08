"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/modules/auth/client";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email"));
    const password = String(f.get("password"));
    const res =
      mode === "signup"
        ? await authClient.signUp.email({ email, password, name: String(f.get("name") || email.split("@")[0]) })
        : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (res.error) return setError(res.error.message ?? "Something went wrong");
    router.push("/app");
    router.refresh();
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4" aria-describedby={error ? "auth-error" : undefined}>
      {mode === "signup" && (
        <div>
          <label className="label" htmlFor="name">Name</label>
          <input className="input" id="name" name="name" autoComplete="name" />
        </div>
      )}
      <div>
        <label className="label" htmlFor="email">Email</label>
        <input className="input" id="email" name="email" type="email" required autoComplete="email" />
      </div>
      <div>
        <label className="label" htmlFor="password">Password</label>
        <input className="input" id="password" name="password" type="password" required minLength={10} autoComplete={mode === "signup" ? "new-password" : "current-password"} />
        {mode === "signup" && <p className="muted mt-1 text-xs">At least 10 characters.</p>}
      </div>
      {error && <p id="auth-error" role="alert" className="text-sm text-red-700">{error}</p>}
      <button className="btn-primary w-full justify-center" disabled={busy}>{busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}</button>
    </form>
  );
}
