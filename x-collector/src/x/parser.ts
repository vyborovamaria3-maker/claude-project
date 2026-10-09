import type { Page } from "playwright";
import type { XTweet } from "./types";

/**
 * Парсит DOM X (article) в XTweet[].
 * Элемент без id/status-ссылки (в т.ч. закреплённый без ссылки) или без
 * текста пропускается. Дубликаты tweet id отбрасываются, limit — сверху.
 */
export async function parseTweets(page: Page, limit = Number.MAX_SAFE_INTEGER): Promise<XTweet[]> {
  const raw = await page.locator("article").evaluateAll((articles): Array<XTweet | null> =>
    articles.map((article) => {
      try {
        const parseMetric = (t: string | null | undefined): number => {
          if (!t) return 0;
          const m = String(t).replace(/\s+/g, "").match(/([0-9]+(?:[.,][0-9]+)?)([KMBКМБ]?)/i);
          if (!m) return 0;
          const s = (m[2] || "").toUpperCase();
          const v = Number(s ? m[1].replace(",", ".") : m[1].replace(/[.,]/g, ""));
          if (!isFinite(v)) return 0;
          if (s === "K" || s === "К") return Math.round(v * 1e3);
          if (s === "M" || s === "М") return Math.round(v * 1e6);
          if (s === "B" || s === "Б") return Math.round(v * 1e9);
          return Math.round(v);
        };

        const links = Array.from(article.querySelectorAll('a[href*="/status/"]'));
        const href = links.map((a) => a.getAttribute("href") || "").find((h) => /\/status\/\d+/.test(h)) || "";
        const id = (href.match(/\/status\/(\d+)/) || [])[1] || "";
        const text = article.querySelector('[data-testid="tweetText"]')?.textContent?.trim() || "";
        if (!id || !text) return null;

        const analyticsAria = article.querySelector('a[href$="/analytics"]')?.getAttribute("aria-label") || "";
        const fullText = article.textContent || "";
        const viewsMatch = analyticsAria.match(/([0-9.,]+[KMBКМБ]?)\s*(?:Views|просмотр)/i)
          || fullText.match(/([0-9.,]+[KMBКМБ]?)\s*(?:Views|просмотр|просмотров)/i);
        const timeAttr = article.querySelector("time")?.getAttribute("datetime") || null;

        return {
          id,
          author: href.split("/").filter(Boolean)[0] || "unknown",
          text,
          url: `https://x.com${href.split("/analytics")[0]}`,
          likes: parseMetric(article.querySelector('[data-testid="like"]')?.textContent),
          reposts: parseMetric(article.querySelector('[data-testid="retweet"]')?.textContent),
          replies: parseMetric(article.querySelector('[data-testid="reply"]')?.textContent),
          views: parseMetric(viewsMatch?.[1]),
          createdAt: timeAttr ? Date.parse(timeAttr) : null,
        };
      } catch {
        return null;
      }
    })
  );

  const seen = new Set<string>();
  const out: XTweet[] = [];
  for (const t of raw) {
    if (!t || !t.id || !t.text) continue;
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}
