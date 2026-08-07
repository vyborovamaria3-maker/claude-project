"use client";

import { useEffect, useState } from "react";

const MOBILE_VIEWPORT_QUERY = "(max-width: 1023px)";

export function useIsMobileViewport() {
  // Keep the initial client render identical to SSR. Reading matchMedia inside
  // the useState initializer makes mobile clients hydrate with different HTML
  // than the server rendered, which triggers React hydration error #418.
  const [isMobile, setIsMobile] = useState(false);

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
