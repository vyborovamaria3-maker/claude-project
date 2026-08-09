"use client";

import { useState } from "react";
import { Loader2, Lock } from "lucide-react";

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
      <input
        type="text"
        value={login}
        onChange={(e) => setLogin(e.target.value)}
        placeholder="Введите логин"
        maxLength={32}
        aria-label="Логин доступа"
        className="mt-1 w-full rounded-xl border border-white/10 bg-black/50 px-4 py-3 text-white placeholder:text-white/30 focus:border-neon-green focus:outline-none"
      />

      <input
        type="text"
        value={password}
        onChange={(e) => setPassword(e.target.value.toUpperCase())}
        placeholder="Введите пароль"
        maxLength={32}
        aria-label="Пароль доступа"
        className="mt-1 w-full rounded-xl border border-white/10 bg-black/50 px-4 py-3 text-white placeholder:text-white/30 focus:border-neon-green focus:outline-none"
      />

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={isLoading}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-neon-green px-4 py-3 font-semibold text-white transition hover:scale-[1.02] disabled:opacity-50"
      >
        {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
        Войти
      </button>
    </form>
  );
}
