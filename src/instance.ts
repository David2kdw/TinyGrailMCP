import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AppError, atomicJson, DATA, fingerprint, readJson } from './core.js';

interface ProcessIdentity {
  pid: number;
  creation: string;
  executable: string;
  command: string;
}
interface Owner {
  instance: string;
  parent: number;
  directory: string;
  child?: ProcessIdentity;
}
async function identity(pid: number): Promise<ProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1 || process.platform !== 'win32') return undefined;
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){[pscustomobject]@{pid=[int]$p.ProcessId;creation=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath;command=$p.CommandLine}|ConvertTo-Json -Compress}`;
  const { stdout } = await promisify(execFile)(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 10000 },
  );
  return stdout.trim() ? JSON.parse(stdout) : undefined;
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
export class TunnelLease {
  private path: string;
  private owner?: Owner;
  constructor(
    tunnelId: string,
    private directory: string,
  ) {
    this.path = join(
      process.env.LOCALAPPDATA ?? DATA,
      'TinyGrailMCP',
      'tunnel-locks',
      `${fingerprint(tunnelId)}.json`,
    );
  }
  async acquire() {
    await mkdir(join(this.path, '..'), { recursive: true, mode: 0o700 });
    const old = await readJson<Owner | null>(this.path, null);
    if (old) {
      if (!Number.isSafeInteger(old.parent) || old.parent < 1 || typeof old.instance !== 'string')
        throw new AppError('LEASE_CORRUPT', 'Tunnel 租约格式不完整，禁止自动删除或启动第二实例。');
      if (alive(old.parent))
        throw new AppError('TUNNEL_ALREADY_RUNNING', '同一 Tunnel ID 已有本机管理器占用，禁止同时启动。');
      if (!old.child || alive(old.child.pid))
        throw new AppError('TUNNEL_ORPHANED', '发现上次遗留的 Tunnel 进程；请先点击“停止”清理，再启动。');
      await rm(this.path, { force: true });
    }
    const f = await open(this.path, 'wx', 0o600);
    this.owner = { instance: randomUUID(), parent: process.pid, directory: this.directory };
    try {
      await f.writeFile(JSON.stringify(this.owner));
      await f.sync();
    } finally {
      await f.close();
    }
  }
  async child(pid: number) {
    const owner = this.owner;
    if (!owner) throw new AppError('LEASE', '没有 Tunnel 单实例租约。');
    const child = await identity(pid);
    if (this.owner !== owner || !child) return;
    owner.child = child;
    await atomicJson(this.path, owner);
  }
  async release() {
    const record = await readJson<Owner | null>(this.path, null);
    if (record?.instance === this.owner?.instance) await rm(this.path, { force: true });
    this.owner = undefined;
  }
  async recoverOrphan() {
    const old = await readJson<Owner | null>(this.path, null);
    if (!old) return;
    if (alive(old.parent) && old.parent !== process.pid)
      throw new AppError('TUNNEL_ALREADY_RUNNING', '另一管理器仍在使用此 Tunnel，未停止它的进程。');
    if (!old.child)
      throw new AppError('ORPHAN_IDENTITY', '上次启动未完整记录子进程身份，请在任务管理器核对后处理租约。');
    if (alive(old.child.pid)) {
      const current = await identity(old.child.pid);
      if (
        !current ||
        fingerprint(current) !== fingerprint(old.child) ||
        !/tunnel-client\.exe$/i.test(current.executable) ||
        !current.command.includes('tunnel-profile.yaml')
      )
        throw new AppError('ORPHAN_IDENTITY', '无法确认遗留进程身份，未结束任何进程；请在任务管理器核对。');
      await promisify(execFile)('taskkill.exe', ['/PID', String(current.pid), '/T', '/F'], {
        windowsHide: true,
      });
      for (let n = 0; n < 50 && alive(current.pid); n++) await new Promise((r) => setTimeout(r, 100));
      if (alive(current.pid)) throw new AppError('STOP_TIMEOUT', '遗留进程仍在运行，禁止新实例。');
    }
    await rm(this.path, { force: true });
  }
}
