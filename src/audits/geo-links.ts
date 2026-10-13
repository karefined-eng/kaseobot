import { validateAndNormalizeUrl } from "../url-validation";

const MAX_GEO_PAGES = 5;
const NON_HTML_EXTENSION = /\.(?:avif|bmp|css|csv|docx?|eot|gif|ico|jpe?g|js|json|map|mp[34]|pdf|png|svg|ttf|web[mp]|woff2?|xlsx?|xml|zip)$/i;

export function clampGeoPageLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_GEO_PAGES) : MAX_GEO_PAGES;
}

export function extractInternalLinks(html: string, pageUrl: string, maxPages: number): string[] {
  const limit = clampGeoPageLimit(maxPages);
  const base = validateAndNormalizeUrl(pageUrl);
  if (!base.ok) return [];

  const origin = new URL(base.url).origin;
  const links = [base.url];
  const seen = new Set([base.url]);
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");

  for (const match of markup.matchAll(/<a\b[^>]*>/gi)) {
    const tag = match[0];
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(tag);
    const rawHref = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3];
    if (!rawHref) continue;

    const href = decodeHtmlAttribute(rawHref).trim();
    if (!href || href.startsWith("#") || /^(?:mailto|javascript|data|tel):/i.test(href)) continue;

    let destination: URL;
    try {
      destination = new URL(href, base.url);
    } catch {
      continue;
    }
    if (destination.protocol !== "http:" && destination.protocol !== "https:") continue;
    destination.hash = "";

    const validated = validateAndNormalizeUrl(destination.toString());
    if (!validated.ok) continue;
    const normalized = new URL(validated.url);
    if (normalized.origin !== origin || NON_HTML_EXTENSION.test(normalized.pathname) || seen.has(validated.url)) continue;

    seen.add(validated.url);
    links.push(validated.url);
    if (links.length >= limit) break;
  }

  return links;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}
