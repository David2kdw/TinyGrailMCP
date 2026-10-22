import { randomBytes, createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const VERSION = '1.1.0';
export const ROOT = resolve(import.meta.dirname, '..');
export const DATA = resolve(
  process.env.TG_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? ROOT, 'TinyGrailMCP'),
);
export const runFile = join(DATA, 'runtime.json');
export const randomToken = () => randomBytes(32).toString('hex');
export const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function publicError(e: unknown) {
  return e instanceof AppError
    ? { code: e.code, message: e.message, details: e.details }
    : { code: 'INTERNAL', message: '内部错误；请查看本地诊断。' };
}
export function log(event: string, code?: string) {
  process.stderr.write(JSON.stringify({ time: new Date().toISOString(), event, code }) + '\n');
}
export async function atomicJson(path: string, value: unknown) {
  const temp = `${path}.${randomToken()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temp, path);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
}
export async function readJson<T>(path: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
}
export async function protectDirectory(path = DATA) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const { stdout } = await promisify(execFile)('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
      windowsHide: true,
    });
    const sid = stdout.match(/S-1-5-[0-9-]+/)?.[0];
    if (!sid) throw new AppError('ACL', '无法确认当前 Windows 用户。');
    await promisify(execFile)(
      'icacls.exe',
      [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'],
      { windowsHide: true },
    );
  }
}
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => {});
    return next;
  }
}
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AppError('SCHEMA', '服务器数据结构发生变化：预期对象。');
  return value as Record<string, any>;
}
export function pick(value: Record<string, any>, keys: string[]) {
  return Object.fromEntries(
    keys.filter((k) => value[k] !== undefined && value[k] !== null).map((k) => [k, value[k]]),
  );
}
