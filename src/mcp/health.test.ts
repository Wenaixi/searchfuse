import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkMcpHealth,
  probeMcpServer,
  usableMcpNames,
} from './health.ts';
import type { McpServerConfig } from './protocol.ts';

const servers: http.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 起一个假 MCP server；`behave` 决定它对握手与工具列表的回应。 */
function fakeServer(behave: 'healthy' | 'reject-tools'): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let message: { method?: string; id?: unknown } = {};
        try {
          message = JSON.parse(body);
        } catch {
          res.writeHead(202).end();
          return;
        }
        if (message.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                protocolVersion: '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'fake', version: '1' },
              },
            }),
          );
          return;
        }
        if (message.method === 'notifications/initialized') {
          res.writeHead(202).end();
          return;
        }
        if (message.method === 'tools/list') {
          if (behave === 'reject-tools') {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -1, message: 'nope' } }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }));
          return;
        }
        res.writeHead(202).end();
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve(`http://127.0.0.1:${port}/mcp`);
    });
  });
}

const config = (url: string): McpServerConfig => ({ transport: 'streamable-http', url, enabled: true });

describe('probeMcpServer', () => {
  it('能完成握手与 tools/list 的 server 判为可用', async () => {
    const url = await fakeServer('healthy');
    const health = await probeMcpServer(config(url));
    expect(health.ok).toBe(true);
    expect(health.fromCache).toBe(false);
  });

  it('tools/list 失败的 server 判为不可用并带出原因', async () => {
    const url = await fakeServer('reject-tools');
    const health = await probeMcpServer(config(url));
    expect(health.ok).toBe(false);
    expect(health.reason).toBeTruthy();
  });

  it('连不上的 server 判为不可用，不抛错', async () => {
    // 端口 1 上没有东西监听。
    const health = await probeMcpServer(config('http://127.0.0.1:1/mcp'));
    expect(health.ok).toBe(false);
    expect(health.reason).toBeTruthy();
  });
});

describe('checkMcpHealth', () => {
  function cacheFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-mcp-health-'));
    tempDirs.push(dir);
    return path.join(dir, 'mcp-health.json');
  }

  it('并发探测多个 server，可用与不可用分开报告', async () => {
    const good = await fakeServer('healthy');
    const bad = 'http://127.0.0.1:1/mcp';
    const result = await checkMcpHealth(
      { good: config(good), bad: config(bad) },
      { cachePath: cacheFile() },
    );
    expect(result.good?.ok).toBe(true);
    expect(result.bad?.ok).toBe(false);
    expect(usableMcpNames(result)).toEqual(['good']);
  });

  it('缓存期内复用结论，不重复探测', async () => {
    const url = await fakeServer('healthy');
    const file = cacheFile();
    const first = await checkMcpHealth({ srv: config(url) }, { cachePath: file, now: 1000 });
    expect(first.srv?.fromCache).toBe(false);
    // 同一个时间戳再查一次：应该来自缓存。
    const second = await checkMcpHealth({ srv: config(url) }, { cachePath: file, now: 1000 });
    expect(second.srv?.fromCache).toBe(true);
    expect(second.srv?.ok).toBe(true);
  });

  it('缓存过期后重新探测', async () => {
    const url = await fakeServer('healthy');
    const file = cacheFile();
    await checkMcpHealth({ srv: config(url) }, { cachePath: file, now: 1000, maxAgeMs: 100 });
    const later = await checkMcpHealth({ srv: config(url) }, { cachePath: file, now: 5000, maxAgeMs: 100 });
    expect(later.srv?.fromCache).toBe(false);
  });

  it('缓存文件损坏时当作没有缓存，不影响探测', async () => {
    const url = await fakeServer('healthy');
    const file = cacheFile();
    fs.writeFileSync(file, '{broken');
    const result = await checkMcpHealth({ srv: config(url) }, { cachePath: file });
    expect(result.srv?.ok).toBe(true);
  });
});
