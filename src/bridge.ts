import { AppError, readJson, runFile } from './core.js';
export interface Runtime {
  origin: string;
  instance: string;
  pid: number;
  bootstrap: string;
  internal: string;
  control: string;
}
export async function bridge(path: '/internal/tool' | '/internal/event', body: unknown) {
  let runtime: Runtime;
  try {
    runtime = await readJson<Runtime>(runFile);
  } catch {
    throw new AppError('MANAGER_OFFLINE', '本地管理器未启动，请运行 scripts/Start.ps1。');
  }
  const url = new URL(runtime.origin);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:')
    throw new AppError('RUNTIME', '本地管理器地址无效。');
  try {
    const response = await fetch(new URL(path, url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${runtime.internal}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
      redirect: 'error',
    });
    const value: any = await response.json();
    if (!response.ok || value.error)
      throw new AppError(
        value.error?.code ?? 'MANAGER',
        value.error?.message ?? '本地管理器请求失败。',
        value.error?.details,
      );
    return value;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('MANAGER_OFFLINE', '本地管理器连接失败，请重新打开管理界面。');
  }
}
