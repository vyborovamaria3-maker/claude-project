"use client";

import { useEffect, useState } from "react";

const MOBILE_VIEWPORT_QUERY = "(max-width: 1023px)";

function detectMobileViewport() {
  if (typeof window === "undefined") return false;
  return window.matchMedia(MOBILE_VIEWPORT_QUERY).matches;
}

export function useIsMobileViewport() {
  const [isMobile, setIsMobile] = useState(() => detectMobileViewport());

  useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_VIEWPORT_QUERY);
    const update = () => setIsMobile(mediaQuery.matches);

    update();
    mediaQuery.addEventListener("change", update);

    return () => {
      mediaQuery.removeEventListener("change", update);
    };
  }, []);

  return isMobile;
}
