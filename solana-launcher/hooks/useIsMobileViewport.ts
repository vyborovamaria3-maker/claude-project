"use client";

import { useEffect, useState } from "react";

function detectMobileViewport() {
  if (typeof window === "undefined") return false;

  const coarsePointer = window.matchMedia?.("(hover: none) and (pointer: coarse)")?.matches ?? false;
  const noHover = window.matchMedia?.("(any-hover: none)")?.matches ?? false;
  const touchCapable = typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;

  return coarsePointer || noHover || touchCapable;
}

export function useIsMobileViewport() {
  const [isMobile, setIsMobile] = useState(() => detectMobileViewport());

  useEffect(() => {
    const update = () => setIsMobile(detectMobileViewport());

    update();

    const mediaQueries = ["(hover: none) and (pointer: coarse)", "(any-hover: none)"]
      .map((query) => window.matchMedia(query));

    mediaQueries.forEach((mq) => mq.addEventListener("change", update));
    window.addEventListener("resize", update);

    return () => {
      mediaQueries.forEach((mq) => mq.removeEventListener("change", update));
      window.removeEventListener("resize", update);
    };
  }, []);

  return isMobile;
}
