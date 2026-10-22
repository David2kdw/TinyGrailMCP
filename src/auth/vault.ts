import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, atomicJson, DATA, Mutex, readJson } from '../core.js';

// Secrets travel over anonymous stdin/stdout pipes; never in command arguments or environment.
export async function dpapi(mode: 'protect' | 'unprotect', input: string): Promise<string> {
  if (process.platform !== 'win32') throw new AppError('WINDOWS_REQUIRED', '凭据存储需要 Windows DPAPI。');
  const script = `Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($s); $r=[Security.Cryptography.ProtectedData]::${mode === 'protect' ? 'Protect' : 'Unprotect'}($b,[Text.Encoding]::UTF8.GetBytes('TinyGrailMCP/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let result = '';
    const timeout = setTimeout(() => {
      p.kill();
      reject(new AppError('VAULT', 'Windows 安全存储超时。'));
    }, 15000);
    p.stdout.on('data', (b) => {
      result += b.toString();
    });
    p.stderr.resume();
    p.once('error', () => {
      clearTimeout(timeout);
      reject(new AppError('VAULT', '无法调用 Windows 安全存储。'));
    });
    p.once('close', (code) => {
      clearTimeout(timeout);
      code === 0
        ? resolve(result.trim())
        : reject(new AppError('VAULT', '无法解密凭据；请使用原 Windows 用户或重新配置。'));
    });
    p.stdin.end(input);
  });
}
export class Vault {
  private mutex = new Mutex();
  constructor(private dir = DATA) {}
  async get<T>(name: 'session' | 'tunnel'): Promise<T | undefined> {
    const blob = await readJson<{ encrypted: string } | null>(join(this.dir, `${name}.dpapi.json`), null);
    if (!blob) return undefined;
    const plain = await dpapi('unprotect', blob.encrypted);
    return JSON.parse(Buffer.from(plain, 'base64').toString('utf8')) as T;
  }
  set(name: 'session' | 'tunnel', value: unknown) {
    return this.mutex.run(async () => {
      const encrypted = await dpapi('protect', Buffer.from(JSON.stringify(value)).toString('base64'));
      await atomicJson(join(this.dir, `${name}.dpapi.json`), { version: 1, encrypted });
    });
  }
  async remove(name: 'session' | 'tunnel') {
    await rm(join(this.dir, `${name}.dpapi.json`), { force: true });
  }
}
