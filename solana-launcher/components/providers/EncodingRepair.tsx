"use client";

import { useEffect } from "react";

const mojibakeHint = /(?:Р.|С.|В.|вЂ|в†)/;
const ATTRIBUTE_NAMES = ["title", "placeholder", "aria-label"] as const;

function buildWindows1251ReverseMap(): Map<string, number> | null {
  try {
    const decoder = new TextDecoder("windows-1251");
    const map = new Map<string, number>();
    for (let byte = 0; byte <= 255; byte += 1) {
      const char = decoder.decode(Uint8Array.of(byte));
      if (char.length === 1 && !map.has(char)) map.set(char, byte);
    }
    return map;
  } catch {
    return null;
  }
}

function makeRepairer() {
  const reverseMap = buildWindows1251ReverseMap();
  const utf8 = new TextDecoder("utf-8", { fatal: true });

  return (value: string): string => {
    if (!reverseMap || !mojibakeHint.test(value)) return value;

    try {
      const bytes: number[] = [];
      for (const char of value) {
        const byte = reverseMap.get(char);
        if (byte === undefined) return value;
        bytes.push(byte);
      }

      const decoded = utf8.decode(new Uint8Array(bytes));
      if (!decoded || decoded === value) return value;
      return decoded;
    } catch {
      return value;
    }
  };
}

function repairElement(root: ParentNode, repair: (value: string) => string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const text = node.nodeValue;
    if (text) {
      const fixed = repair(text);
      if (fixed !== text) node.nodeValue = fixed;
    }
    node = walker.nextNode();
  }

  if (root instanceof Element) {
    for (const attribute of ATTRIBUTE_NAMES) {
      const value = root.getAttribute(attribute);
      if (!value) continue;
      const fixed = repair(value);
      if (fixed !== value) root.setAttribute(attribute, fixed);
    }
  }

  if (root instanceof Element || root instanceof Document) {
    const selector = ATTRIBUTE_NAMES.map((name) => `[${name}]`).join(",");
    root.querySelectorAll(selector).forEach((element) => {
      for (const attribute of ATTRIBUTE_NAMES) {
        const value = element.getAttribute(attribute);
        if (!value) continue;
        const fixed = repair(value);
        if (fixed !== value) element.setAttribute(attribute, fixed);
      }
    });
  }
}

export default function EncodingRepair() {
  useEffect(() => {
    const repair = makeRepairer();
    repairElement(document, repair);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData" && mutation.target.nodeValue) {
          const fixed = repair(mutation.target.nodeValue);
          if (fixed !== mutation.target.nodeValue) mutation.target.nodeValue = fixed;
          continue;
        }

        if (mutation.type === "attributes" && mutation.target instanceof Element) {
          repairElement(mutation.target, repair);
          continue;
        }

        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.TEXT_NODE && node.nodeValue) {
            const fixed = repair(node.nodeValue);
            if (fixed !== node.nodeValue) node.nodeValue = fixed;
          } else if (node instanceof Element) {
            repairElement(node, repair);
          }
        });
      }
    });

    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...ATTRIBUTE_NAMES],
    });

    return () => observer.disconnect();
  }, []);

  return null;
}
