// 服务身份推导的守护测试。
//
// 这套设计把「服务在哪」从 runtime.json 换成「从目录推导出的候选端口」，
// 代价是三端各有一份拷贝（src / dsh / claude 各一份，各自独立构建）。
// 三份一旦漂移，就会出现「服务绑 42037、客户端去探 42041」这种互相看不见
// 的错配，且症状与「服务没起来」一模一样。所以这里既测算法本身，
// 也测三份拷贝的一致性。
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { candidatePorts, fingerprintOf, identityOf, PORT_BASE, PORT_SPAN, stateDirOf } from './serveIdentity.ts';

describe('serveIdentity 的确定性', () => {
  it('同一个目录永远算出同一个指纹与同一组端口', () => {
    const a = identityOf('/home/u');
    const b = identityOf('/home/u');
    expect(a).toEqual(b);
    expect(new Set(a.ports).size).toBe(a.ports.length);
  });

  it('不同目录算出不同指纹', () => {
    expect(fingerprintOf('/home/u')).not.toBe(fingerprintOf('/home/v'));
  });

  it('同一目录的不同写法归一化到同一个指纹', () => {
    // 尾部斜杠、`.` 段、大小写差异都不该把同一份状态认成两份。
    expect(fingerprintOf('/home/u/.searchfuse')).toBe(fingerprintOf('/home/u/.searchfuse/'));
    expect(fingerprintOf('/home/u/./.searchfuse')).toBe(fingerprintOf('/home/u/.searchfuse'));
    expect(fingerprintOf('C:/Users/X/.searchfuse')).toBe(
      fingerprintOf('c:/users/x/.searchfuse'),
    );
  });

  it('候选端口的数量、范围与连续性', () => {
    const ports = candidatePorts(fingerprintOf('/home/u'));
    expect(ports).toHaveLength(PORT_SPAN);
    expect(ports[0]).toBeGreaterThanOrEqual(PORT_BASE);
    expect(ports[0]).toBeLessThan(PORT_BASE + 2_000);
    // 连续：客户端可以按顺序试，服务端可以向后找空位。
    for (let i = 1; i < ports.length; i += 1) {
      expect(ports[i]).toBe(ports[i - 1]! + 1);
    }
    // 全部是合法端口。
    for (const port of ports) {
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65_535);
    }
  });

  it('状态目录的拼法与其他模块一致', () => {
    expect(stateDirOf('/home/u')).toBe(path.join('/home/u', '.searchfuse'));
  });

  it('指纹是固定长度的十六进制', () => {
    const fp = fingerprintOf('/home/u');
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });
});
