/**
 * Turn an engine's `proxy` setting into the value `requestText` acts on.
 *
 * Three states, and the distinction between the first two is the feature:
 *
 * - `undefined` — nothing was configured, so the machine's http_proxy /
 *   https_proxy / no_proxy keep deciding. This is the pre-existing behavior and
 *   stays the default.
 * - `null` — the user wrote `direct` or `none`, asking that this engine bypass
 *   whatever proxy the machine would otherwise use.
 * - a URL — that proxy, and only that proxy, carries this engine's traffic.
 *
 * A value that is neither a recognized keyword nor a full http(s) URL is
 * refused rather than ignored. Falling back to the environment would hide a
 * hand-edited typo and quietly route traffic through a proxy the user was
 * trying to avoid, which is the failure this field exists to prevent.
 */
export function resolveExplicitProxy(value: string | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'direct' || lower === 'none') {
    return null;
  }
  // A proxy needs both a scheme undici can act on and a host to connect to;
  // "http://" alone parses as a URL but names no endpoint.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `Invalid engines.<name>.proxy "${trimmed}". Use "direct", "none", or a full http(s) proxy URL such as http://127.0.0.1:7890.`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid engines.<name>.proxy "${trimmed}": only http and https proxies are supported, not ${parsed.protocol.replace(':', '')}.`,
    );
  }
  if (parsed.hostname === '') {
    throw new Error(
      `Invalid engines.<name>.proxy "${trimmed}": the URL names no host. Use a full http(s) proxy URL such as http://127.0.0.1:7890.`,
    );
  }
  return trimmed;
}
