// The only place in the core that starts a child process. A GUI host has no
// console of its own, so Windows otherwise allocates and shows a black console
// window for every engine invocation. The option is ignored off Windows.
//
// Writing windowsHide after the caller's options makes the guarantee
// structural. A call site cannot forget it or override it through a spread.
import {
  type ChildProcess,
  type ChildProcessByStdio,
  spawn,
  type SpawnOptions,
  type SpawnOptionsWithStdioTuple,
  type StdioNull,
  type StdioPipe,
} from 'child_process';
import type { Readable } from 'stream';

/**
 * 三条标准流都不需要读取时的形式，例如只关心退出码的 `serve --ensure`。
 * 单独一条重载：管道式的返回值精确到 `stdout`/`stderr` 非空，现有调用方
 * 直接写 `child.stdout.on(...)` 依赖这一点，放宽成一个宽类型会把它们弄红。
 *
 * 顺序有讲究：窄签名在前，宽签名在后。TypeScript 取第一个匹配的重载，
 * 把宽的放前面会让每一次管道式调用都退化成可空流。
 */
export function spawnHidden(
  command: string,
  args: readonly string[],
  options: Omit<SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>, 'windowsHide'>,
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnHidden(
  command: string,
  args: readonly string[],
  options: Omit<SpawnOptions, 'windowsHide'>,
): ChildProcess;
export function spawnHidden(
  command: string,
  args: readonly string[],
  options: Omit<SpawnOptions, 'windowsHide'>,
): ChildProcess {
  return spawn(command, args, { ...options, windowsHide: true });
}
