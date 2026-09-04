"use client";

import { useState } from "react";
import { KeyRound, Loader2, Lock, UserRound } from "lucide-react";

const LOGIN_RE = /^[A-Za-z0-9_]{4,32}$/;

export default function PasswordLoginForm() {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!LOGIN_RE.test(login)) {
      setError("Логин должен быть 4-32 символа: буквы, цифры или _");
      return;
    }

    if (password.length !== 32) {
      setError("Пароль должен состоять из 32 символов");
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch("/api/v1/auth/login-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login, password: password.toUpperCase() }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Ошибка входа");
      }

      localStorage.setItem("potapoff.access_token", data.access_token);
      window.location.href = "/dashboard";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка входа");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.12em] text-white/45">Логин</span>
        <span className="relative block">
          <UserRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neon-green/75" />
          <input
            type="text"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            placeholder="Введите логин"
            maxLength={32}
            aria-label="Логин доступа"
            className="w-full rounded-2xl border border-white/10 bg-black/55 px-4 py-3 pl-10 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] placeholder:text-white/30 focus:border-neon-green focus:outline-none focus:ring-2 focus:ring-neon-green/15"
          />
        </span>
      </label>

      <label className="block">
        <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.12em] text-white/45">32-символьный пароль</span>
        <span className="relative block">
          <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neon-green/75" />
          <input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value.toUpperCase())}
            placeholder="Введите пароль"
            maxLength={32}
            aria-label="Пароль доступа"
            className="w-full rounded-2xl border border-white/10 bg-black/55 px-4 py-3 pl-10 font-mono text-sm uppercase tracking-[0.08em] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] placeholder:font-sans placeholder:normal-case placeholder:tracking-normal placeholder:text-white/30 focus:border-neon-green focus:outline-none focus:ring-2 focus:ring-neon-green/15"
          />
        </span>
      </label>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={isLoading}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-neon-green px-4 py-3 font-black text-black shadow-[0_18px_50px_-32px_rgba(0,255,133,0.9)] transition hover:scale-[1.01] disabled:cursor-wait disabled:opacity-50"
      >
        {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
        Войти в платформу
      </button>
    </form>
  );
}
