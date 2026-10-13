export type UrlValidationResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

const USAGE_ERROR = "Send exactly one complete HTTP or HTTPS URL, for example: /audit https://example.com, /geo https://example.com, or /seomator https://example.com.";
const PUBLIC_URL_ERROR = "I can only audit publicly accessible websites.";

export function validateAndNormalizeUrl(input: string | undefined): UrlValidationResult {
  if (!input || input.trim().length === 0) {
    return { ok: false, error: USAGE_ERROR };
  }

  const value = input.trim();
  if (value.length > 2048) return { ok: false, error: "That URL is too long (maximum 2,048 characters)." };
  if (/\s/.test(value)) return { ok: false, error: USAGE_ERROR };
  if (!/^https?:\/\//i.test(value)) {
    return { ok: false, error: "Use a complete HTTP or HTTPS URL, for example: /audit https://example.com, /geo https://example.com, or /seomator https://example.com." };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: "That doesn't look like a valid URL." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only HTTP and HTTPS URLs are supported." };
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.port === "0") {
    return { ok: false, error: "That URL isn't supported. Check the host, port, and credentials." };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (isBlockedHostname(hostname) || isNonPublicAddress(hostname)) {
    return { ok: false, error: PUBLIC_URL_ERROR };
  }
  if (!hostname.includes(".") && !hostname.startsWith("[")) {
    return { ok: false, error: PUBLIC_URL_ERROR };
  }

  parsed.hash = "";
  return { ok: true, url: parsed.toString() };
}

function isBlockedHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".test") ||
    hostname.endsWith(".example") ||
    hostname.endsWith(".invalid") ||
    hostname.endsWith(".home.arpa") ||
    hostname.endsWith(".onion")
  );
}

function isNonPublicAddress(hostname: string): boolean {
  if (hostname.startsWith("[")) {
    const parsed = parseIpv6(hostname);
    return parsed === null || !isPublicIpv6(parsed);
  }

  const ipv4 = parseIpv4(hostname);
  if (ipv4 !== null) return !isPublicIpv4(ipv4);
  return false;
}

function parseIpv4(value: string): [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return null;
  return octets as [number, number, number, number];
}

function isPublicIpv4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function parseIpv6(hostname: string): number[] | null {
  let value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!value || value.includes("%")) return null;

  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon < 0) return null;
    const ipv4 = parseIpv4(value.slice(lastColon + 1));
    if (!ipv4) return null;
    const [a, b, c, d] = ipv4;
    value = `${value.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  if ((value.match(/::/g) ?? []).length > 1) return null;
  const halves = value.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;

  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

function isPublicIpv6(groups: number[]): boolean {
  const first = groups[0];
  const second = groups[1];

  // Global unicast space is 2000::/3; this excludes loopback, link-local,
  // unique-local, IPv4-mapped, multicast, and unspecified ranges by default.
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && second <= 0x01ff) return false;
  if (first === 0x2001 && second === 0x0db8) return false; // documentation
  if (first === 0x2002) return false; // 6to4 embeds an IPv4 address
  if (first === 0x3fff && (second & 0xf000) === 0) return false; // documentation
  return true;
}
