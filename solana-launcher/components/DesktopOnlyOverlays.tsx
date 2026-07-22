"use client";

import DevInspector from "./DevInspector";
import ChatWidget from "./ChatWidget";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";

export default function DesktopOnlyOverlays() {
  const isMobile = useIsMobileViewport();

  if (isMobile) return null;

  return (
    <>
      <DevInspector />
      <ChatWidget />
    </>
  );
}
