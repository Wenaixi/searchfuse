/**
 * 这个 pid 的进程还活着吗。
 *
 * `process.kill(pid, 0)` 不发送信号，只做存在性检查：进程在则静默返回，
 * 不在则抛 ESRCH。跨进程锁用它回收「持锁进程已经死了」的陈旧锁。
 *
 * 独立成模块而不是留在 `main.ts`：`main.ts` 顶层有
 * `await program.parseAsync(process.argv)`，任何导入它的测试都会把整个
 * CLI 解析跑一遍。这个判据必须能被单元测试直接验，尤其是 EPERM 分支——
 * 2026-11-25 反向验证时亲眼见过「测试抄了一份实现去测自己」的假绿。
 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // **EPERM 的意思是「进程存在，但不是我拥有的」。**
    //
    // 把它当成「不在了」会让一个活着的持有者被判陈旧，锁被误抢，两个进程
    // 同时起服务。2026-11-25 实测：对 PID 4（System）这类受保护进程，
    // Windows 上 `process.kill(pid, 0)` 抛的正是 EPERM 而不是 ESRCH。
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
