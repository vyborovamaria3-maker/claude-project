"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import SidebarTop from "@/components/SidebarTop";
import MasterWalletBar from "@/components/MasterWalletBar";
import SidebarNav from "@/components/SidebarNav";
import Header from "@/components/Header";
import TrendingBar from "@/components/TrendingBar";
import DesktopOnlyOverlays from "@/components/DesktopOnlyOverlays";
import ThemePickerToggle from "@/components/ThemePickerToggle";
import { siteDesign } from "@/lib/siteDesign";

const PUBLIC_ROUTES = new Set(siteDesign.publicRoutes);
const ACCESS_TOKEN_KEY = "potapoff.access_token";
const AUTH_META_KEY = "potapoff.auth_meta";
const ACCESS_RECHECK_MS = 60_000;

type AccessState = "checking" | "allowed" | "unavailable";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isPublic = useMemo(() => pathname === "/" || PUBLIC_ROUTES.has(pathname), [pathname]);
  const [accessState, setAccessState] = useState<AccessState>(isPublic ? "allowed" : "checking");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isPublic) {
      setAccessState("allowed");
      return;
    }

    let cancelled = false;
    let timer: number | undefined;

    const denyAccess = () => {
      window.localStorage.removeItem(ACCESS_TOKEN_KEY);
      window.localStorage.removeItem(AUTH_META_KEY);
      if (!cancelled) {
        setAccessState("checking");
        router.replace("/login");
      }
    };

    const verifyAccess = async (initial: boolean) => {
      const token = window.localStorage.getItem(ACCESS_TOKEN_KEY);
      if (initial && !cancelled) setAccessState("checking");

      try {
        const headers: HeadersInit = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch("/api/v1/auth/me", {
          method: "GET",
          headers,
          cache: "no-store",
          credentials: "same-origin",
        });

        if (response.status === 401 || response.status === 403) {
          denyAccess();
          return;
        }
        if (!response.ok) {
          if (!cancelled) setAccessState("unavailable");
          return;
        }
        if (!cancelled) setAccessState("allowed");
      } catch {
        if (!cancelled) setAccessState("unavailable");
      }
    };

    void verifyAccess(true);
    timer = window.setInterval(() => void verifyAccess(false), ACCESS_RECHECK_MS);

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [isPublic, pathname, router]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileNavOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileNavOpen(false);
      }
    };

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previous.focus();
    };
  }, [mobileNavOpen]);

  const openMobileNav = () => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMobileNavOpen(true);
  };

  if (isPublic) {
    return (
      <main className={siteDesign.shell.publicMainClassName}>
        <div className={siteDesign.shell.publicBackgroundClassName} />
        {children}
      </main>
    );
  }

  if (accessState !== "allowed") {
    return (
      <main className="grid min-h-screen place-items-center bg-bg px-6 text-content">
        <div className="max-w-md rounded-2xl border border-bg-border bg-bg-card/90 p-6 text-center shadow-2xl">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" aria-hidden="true" />
          <h1 className="mt-4 text-lg font-semibold">
            {accessState === "checking" ? "Проверяем доступ…" : "Сервис авторизации временно недоступен"}
          </h1>
          <p className="mt-2 text-sm leading-6 text-content-muted">
            {accessState === "checking"
              ? "Закрытые разделы откроются только после подтверждения активной подписки."
              : "Закрытые данные не показываются, пока сервер не подтвердит действующий доступ."}
          </p>
          {accessState === "unavailable" ? (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 rounded-xl border border-bg-border px-4 py-2 text-sm font-semibold text-content"
            >
              Повторить проверку
            </button>
          ) : null}
        </div>
      </main>
    );
  }

  return (
    <>
      <aside
        className={`${siteDesign.shell.sidebarClassName} hidden lg:flex`}
        style={{ width: "16rem" }}
        aria-label="Desktop navigation"
      >
        <SidebarTop />
        <MasterWalletBar />
        <SidebarNav />
      </aside>

      {mobileNavOpen ? (
        <div className="fixed inset-0 z-[90] lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            type="button"
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            aria-label="Close navigation"
            onClick={() => setMobileNavOpen(false)}
          />

          <div className="absolute inset-y-0 left-0 flex w-[min(20rem,88vw)] max-w-full flex-col overflow-y-auto border-r border-bg-border bg-bg shadow-2xl">
            <div className="relative shrink-0">
              <SidebarTop />
              <button
                ref={closeButtonRef}
                type="button"
                onClick={() => setMobileNavOpen(false)}
                className="absolute right-3 top-4 z-10 flex h-10 w-10 items-center justify-center rounded-xl border border-bg-border bg-bg-card/90 text-content-muted transition hover:border-primary-border hover:text-content"
                aria-label="Close navigation"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <MasterWalletBar />
            <SidebarNav />
          </div>
        </div>
      ) : null}

      <div className={`${siteDesign.shell.contentClassName} w-full lg:ml-64 lg:w-[calc(100vw-16rem)]`}>
        <div className={siteDesign.shell.appBackgroundClassName} />
        <Header onMenuToggle={openMobileNav} />
        <TrendingBar />
        <main className={siteDesign.shell.mainClassName}>{children}</main>
      </div>

      <DesktopOnlyOverlays />
      <ThemePickerToggle />
    </>
  );
}
