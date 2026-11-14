/**
 * The URL two engines must agree on for the same page.
 *
 * Fusion dedupes by this key. Everything removed here is something that does
 * not change what the page says: a fragment never selects a different document,
 * tracking parameters are appended by whoever shared the link, and parameter
 * order is an accident of how the URL was assembled. What is deliberately NOT
 * removed is the `www.` prefix and the path case — those do name different
 * pages often enough that merging them would silently drop a real second
 * source, which is worse than showing one page twice.
 *
 * An unparseable input comes back unchanged. A provider handing back a broken
 * URL must not abort a whole search; its entry stays visible under its own
 * spelling.
 */
const TRACKING_PARAMETERS = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'source',
  'spm',
]);

function isTracking(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMETERS.has(lower);
}

export function canonicalUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return raw;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return raw;
  }

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  // Setting the port to '' drops an explicit default port and keeps a
  // non-default one, which is what the URL API does.
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }

  const kept: Array<[string, string]> = [];
  for (const [name, value] of url.searchParams) {
    if (!isTracking(name)) {
      kept.push([name, value]);
    }
  }
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));

  const query = new URLSearchParams();
  for (const [name, value] of kept) {
    query.append(name, value);
  }
  url.search = query.toString();

  let out = url.toString();
  // A trailing slash on a non-root path is the same page; the root's slash is
  // part of the address.
  if (url.pathname !== '/' && out.endsWith('/')) {
    out = out.slice(0, -1);
  }
  return out;
}
