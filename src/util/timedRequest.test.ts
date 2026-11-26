import * as http from 'node:http';
import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestText } from './timedRequest.ts';

const PROXY_ENV_KEYS = [
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'no_proxy',
  'NO_PROXY',
] as const;

interface Server {
  port: number;
  close: () => Promise<void>;
}

function listen(server: http.Server): Promise<Server> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      resolve({ port, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

/** The engine API stand-in. */
function startOrigin(): Promise<Server> {
  return listen(
    http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"from":"origin"}');
    }),
  );
}

/**
 * Accepts every CONNECT, records the requested authority, and tunnels it to
 * the loopback origin whatever host was asked for. A name that never resolves
 * still gets an answer this way, so the test needs no DNS.
 */
async function startProxy(originPort: number): Promise<Server & { seen: string[] }> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    // undici 8 对 `http://` 目标走的是标准代理转发（绝对 URI 的
    // `GET http://host/path`），不再用 CONNECT 隧道——隧道本来就是 HTTPS
    // 的做法。所以这个假代理两条路都要接：转发与隧道都要把请求送到 origin。
    seen.push(`${req.method} ${req.url ?? ''}`);
    const upstream = http.request(
      { host: '127.0.0.1', port: originPort, path: req.url, method: req.method, headers: req.headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  server.on('connect', (req, clientSocket, head) => {
    seen.push(`CONNECT ${req.url ?? ''}`);
    const upstream = net.connect(originPort, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  const listening = await listen(server);
  return { ...listening, seen };
}

/** A loopback port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = await listen(http.createServer());
  await server.close();
  return server.port;
}

function call(url: string) {
  return requestText('engine', url, { method: 'GET' }, AbortSignal.timeout(5_000), 5_000, []);
}

/** The same call, with a per-engine proxy override. */
function callWithProxy(url: string, explicitProxy: string | null | undefined) {
  return requestText(
    'engine',
    url,
    { method: 'GET' },
    AbortSignal.timeout(5_000),
    5_000,
    [],
    explicitProxy,
  );
}

describe('requestText and the system HTTP proxy', () => {
  let origin: Server;
  let proxy: Server & { seen: string[] };

  beforeEach(async () => {
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, '');
    }
    origin = await startOrigin();
    proxy = await startProxy(origin.port);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await proxy.close();
    await origin.close();
  });

  it('sends the engine call through http_proxy when one is set', async () => {
    vi.stubEnv('http_proxy', `http://127.0.0.1:${proxy.port}`);
    const { response, text } = await call('http://engine-api.invalid/search');
    expect(response.status).toBe(200);
    expect(text).toBe('{"from":"origin"}');
    expect(proxy.seen).toEqual(['GET http://engine-api.invalid/search']);
  });

  it('goes direct for a host listed in NO_PROXY', async () => {
    vi.stubEnv('http_proxy', `http://127.0.0.1:${proxy.port}`);
    vi.stubEnv('no_proxy', '127.0.0.1');
    const { text } = await call(`http://127.0.0.1:${origin.port}/search`);
    expect(text).toBe('{"from":"origin"}');
    expect(proxy.seen).toEqual([]);
  });

  it('names the underlying cause when the transport fails', async () => {
    const port = await closedPort();
    await expect(call(`http://127.0.0.1:${port}/search`)).rejects.toThrow(
      /^engine request failed: fetch failed; cause: .*ECONNREFUSED/,
    );
  });
});

/**
 * The `proxy` field exists so one engine can be routed differently from the
 * rest of the machine. These three cases are the whole contract: the setting
 * wins over the environment in both directions, and its absence changes
 * nothing.
 */
describe('requestText and a per-engine proxy override', () => {
  let origin: Server;
  let proxy: Server & { seen: string[] };

  beforeEach(async () => {
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, '');
    }
    origin = await startOrigin();
    proxy = await startProxy(origin.port);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await proxy.close();
    await origin.close();
  });

  it('uses the explicit proxy even when no proxy variable is set', async () => {
    const { text } = await callWithProxy(
      'http://engine-api.invalid/search',
      `http://127.0.0.1:${proxy.port}`,
    );
    expect(text).toBe('{"from":"origin"}');
    expect(proxy.seen).toEqual(['GET http://engine-api.invalid/search']);
  });

  it('bypasses http_proxy when the engine asks for a direct connection', async () => {
    vi.stubEnv('http_proxy', `http://127.0.0.1:${proxy.port}`);
    const { text } = await callWithProxy(`http://127.0.0.1:${origin.port}/search`, null);
    expect(text).toBe('{"from":"origin"}');
    // The environment would have used the proxy; the setting overrides it.
    expect(proxy.seen).toEqual([]);
  });

  it('overrides a different proxy the environment would have used', async () => {
    // The environment names a port with nothing behind it: if the explicit
    // proxy lost, this request would fail rather than reach the origin.
    vi.stubEnv('http_proxy', `http://127.0.0.1:${await closedPort()}`);
    const { text } = await callWithProxy(
      'http://engine-api.invalid/search',
      `http://127.0.0.1:${proxy.port}`,
    );
    expect(text).toBe('{"from":"origin"}');
    expect(proxy.seen).toEqual(['GET http://engine-api.invalid/search']);
  });

  it('keeps following the environment when the setting is absent', async () => {
    vi.stubEnv('http_proxy', `http://127.0.0.1:${proxy.port}`);
    const { text } = await callWithProxy('http://engine-api.invalid/search', undefined);
    expect(text).toBe('{"from":"origin"}');
    expect(proxy.seen).toEqual(['GET http://engine-api.invalid/search']);
  });
});
