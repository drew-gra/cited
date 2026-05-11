const PROTOCOL_RE = /^https?:\/\//i;

export type NormalizedUrl = {
  raw: string;
  rootDomain: string;
  primaryUrl: string;
};

export function normalizeUrl(input: string): NormalizedUrl {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("URL is empty.");
  }

  const withScheme = PROTOCOL_RE.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("Could not parse URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("URL must use http or https.");
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!host || !host.includes(".")) {
    throw new Error("URL hostname is invalid.");
  }

  return {
    raw: input,
    rootDomain: host,
    primaryUrl: `https://${host}`,
  };
}
