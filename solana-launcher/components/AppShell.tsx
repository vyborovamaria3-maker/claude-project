"use client";

import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import SidebarTop from "@/components/SidebarTop";
import MasterWalletBar from "@/components/MasterWalletBar";
import SidebarNav from "@/components/SidebarNav";
import Header from "@/components/Header";
import TrendingBar from "@/components/TrendingBar";
import DesktopOnlyOverlays from "@/components/DesktopOnlyOverlays";
import ThemePickerToggle from "@/components/ThemePickerToggle";
import { siteDesign } from "@/lib/siteDesign";

const PUBLIC_ROUTES = new Set(siteDesign.publicRoutes);

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublic = useMemo(() => PUBLIC_ROUTES.has(pathname), [pathname]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

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
