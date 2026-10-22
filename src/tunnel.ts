import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AppError, atomicJson, DATA, Mutex, ROOT, VERSION, fingerprint, readJson } from './core.js';
import type { Vault } from './auth/vault.js';
import { TunnelLease } from './instance.js';

export interface TunnelConfig {
  tunnelId: string;
  apiKey: string;
}
export function mcpDetails(details: any) {
  const list = details?.tools_list;
  return {
    protocolVersion: details?.initialize?.protocol_version,
    childState: details?.child_state,
    discovery: list?.ok
      ? {
          state: list.complete && !list.partial && !list.limited ? 'complete' : 'partial',
          observedAt: list.observed_at,
          toolNames: Array.isArray(list.tool_names) ? list.tool_names.slice(0, 100) : [],
        }
      : { state: 'not_observed' },
  };
}
export class Tunnel {
  private child?: ChildProcess;
  private lock = new Mutex();
  private stopping = false;
  private failures = 0;
  private restart?: NodeJS.Timeout;
  private desired = false;
  private healthFile: string;
  private config?: TunnelConfig;
  lastExit?: number | null;
  private childExited: Promise<void> = Promise.resolve();
  private lease?: TunnelLease;
  private forwarded?: { tool: string; observedAt: string };
  private verification?: { tunnelFingerprint: string; version: string; confirmedAt: string; basis: string };
  constructor(
    private vault: Vault,
    private record: (layer: string, event: string, code?: string) => void,
    private dir = DATA,
  ) {
    this.healthFile = join(dir, 'tunnel-health.url');
  }
  private binary() {
    return join(ROOT, 'tools', 'tunnel-client.exe');
  }
  async restore() {
    this.config = await this.vault.get<TunnelConfig>('tunnel');
    if (!this.config && process.env.CONTROL_PLANE_TUNNEL_ID && process.env.CONTROL_PLANE_API_KEY)
      this.config = {
        tunnelId: process.env.CONTROL_PLANE_TUNNEL_ID,
        apiKey: process.env.CONTROL_PLANE_API_KEY,
      };
    this.verification = await readJson<typeof this.verification>(
      join(this.dir, 'chatgpt-verification.json'),
      undefined,
    ).catch(() => undefined);
  }
  async configure(config: TunnelConfig) {
    if (
      !/^tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}$/.test(config.tunnelId) ||
      config.apiKey.length < 20 ||
      config.apiKey.length > 1000 ||
      /\s/.test(config.apiKey)
    )
      throw new AppError('CONFIG', 'Tunnel ID 或 Key 格式无效。');
    await this.stop();
    await this.vault.set('tunnel', config);
    this.config = config;
    this.forwarded = undefined;
    return { configured: true };
  }
  private async profile() {
    if (!this.config)
      throw new AppError('TUNNEL_CONFIG_REQUIRED', '请在本地配置 Tunnel ID 和 Restricted API Key。');
    await access(this.binary()).catch(() => {
      throw new AppError('TUNNEL_NOT_INSTALLED', '请运行 scripts/Install-Tunnel.ps1。');
    });
    const path = join(this.dir, 'tunnel-profile.yaml');
    // JSON is valid YAML. The profile contains an env reference, never the key.
    await atomicJson(path, {
      config_version: 1,
      control_plane: {
        base_url: 'https://api.openai.com',
        tunnel_id: this.config.tunnelId,
        api_key: 'env:CONTROL_PLANE_API_KEY',
      },
      health: { listen_addr: '127.0.0.1:0', url_file: this.healthFile },
      log: { level: 'info', format: 'json' },
      mcp: {
        stdio_send_initialized_notification: true,
        commands: [
          {
            channel: 'main',
            command: `"${process.execPath.replaceAll('\\', '/')}" "${join(ROOT, 'dist/index.js').replaceAll('\\', '/')}"`,
          },
        ],
      },
    });
    return path;
  }
  private environment(): NodeJS.ProcessEnv {
    const allowed = [
      'PATH',
      'Path',
      'SystemRoot',
      'WINDIR',
      'USERPROFILE',
      'LOCALAPPDATA',
      'APPDATA',
      'TEMP',
      'TMP',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'NO_PROXY',
      'NODE_EXTRA_CA_CERTS',
    ];
    const env = Object.fromEntries(allowed.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
    return {
      ...env,
      TG_DATA_DIR: this.dir,
      TG_TRANSPORT: 'tunnel',
      CONTROL_PLANE_API_KEY: this.config!.apiKey,
    };
  }
  async start() {
    return this.lock.run(async () => {
      this.desired = true;
      if (this.child) return;
      this.failures = 0;
      await this.launch();
    });
  }
  private async launch() {
    const profile = await this.profile();
    await rm(this.healthFile, { force: true });
    this.lease = new TunnelLease(this.config!.tunnelId, this.dir);
    await this.lease.acquire();
    this.stopping = false;
    this.forwarded = undefined;
    const child = spawn(this.binary(), ['run', '--profile-file', profile], {
      env: this.environment(),
      windowsHide: true,
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    const lease = this.lease;
    // Never retain raw tunnel output: upstream logs can include credentials, IDs or header values.
    child.stdout?.resume();
    child.stderr?.resume();
    this.childExited = new Promise((resolve) => {
      child.once('error', () => {
        this.record('tunnel', '启动失败', 'SPAWN');
      });
      child.once('close', (code) => {
        this.lastExit = code;
        if (this.child === child) this.child = undefined;
        this.record('tunnel', '进程已退出', String(code));
        this.forwarded = undefined;
        void lease.release().then(
          () => {
            resolve();
            if (this.desired && !this.stopping && ++this.failures <= 3)
              this.restart = setTimeout(
                () => {
                  void this.lock
                    .run(async () => {
                      if (this.desired && !this.child) await this.launch();
                    })
                    .catch(() => this.record('tunnel', '恢复失败', 'RESTART'));
                },
                2000 * 2 ** (this.failures - 1),
              );
          },
          () => {
            this.record('tunnel', '单实例租约清理失败，禁止重复启动', 'LEASE_IO');
            resolve();
          },
        );
      });
    });
    if (child.pid)
      await this.lease
        .child(child.pid)
        .catch(() => this.record('tunnel', '进程身份记录失败；请正常停止后重启', 'IDENTITY'));
    this.record('tunnel', '进程已启动，等待控制面连接');
  }
  async stop() {
    this.desired = false;
    this.forwarded = undefined;
    clearTimeout(this.restart);
    return this.lock.run(async () => {
      const child = this.child;
      if (!child) {
        if (this.config) await new TunnelLease(this.config.tunnelId, this.dir).recoverOrphan();
        return;
      }
      this.stopping = true;
      // Windows terminates the entire owned tree, including stdio child, before replacement.
      if (process.platform === 'win32' && child.pid)
        await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
        }).catch(() => {});
      else child.kill('SIGTERM');
      await Promise.race([
        this.childExited,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new AppError('STOP_TIMEOUT', 'Tunnel 尚未退出，禁止启动替代实例。')),
            10000,
          ).unref(),
        ),
      ]);
    });
  }
  async doctor() {
    const profile = await this.profile();
    const checks = (output: string) =>
      [...output.matchAll(/^CHECK\s+(\w+)\s+(PASS|FAIL|SKIP)\s/gm)].map((m) => ({
        check: m[1],
        result: m[2],
      }));
    try {
      const { stdout } = await promisify(execFile)(
        this.binary(),
        ['doctor', '--profile-file', profile, '--explain'],
        { env: this.environment(), windowsHide: true, timeout: 30000, maxBuffer: 200000 },
      );
      // Return only result, not raw stdout (which can include configuration secrets).
      return {
        ok: true,
        checks: checks(stdout),
      };
    } catch (e) {
      return {
        ok: false,
        checks: checks(typeof (e as any).stdout === 'string' ? (e as any).stdout : ''),
        note: '连接诊断失败，请查看未通过的检查项。',
      };
    }
  }
  observeForwardedTool(tool: string) {
    this.forwarded = { tool, observedAt: new Date().toISOString() };
  }
  async confirmChatgpt() {
    if (!this.config) throw new AppError('TUNNEL_CONFIG_REQUIRED', '尚未配置 Tunnel。');
    this.verification = {
      tunnelFingerprint: fingerprint(this.config.tunnelId),
      version: VERSION,
      confirmedAt: new Date().toISOString(),
      basis: 'user_confirmed_chatgpt_readonly_call',
    };
    await atomicJson(join(this.dir, 'chatgpt-verification.json'), this.verification);
    return {
      recorded: true,
      confirmedAt: this.verification.confirmedAt,
    };
  }
  async status() {
    let health: any = undefined;
    if (this.child) {
      try {
        const address = (await readFile(this.healthFile, 'utf8')).trim();
        const url = new URL(address);
        if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error();
        const res = await fetch(new URL('/health?details=true', url), {
          signal: AbortSignal.timeout(1500),
          redirect: 'error',
        });
        const h: any = await res.json();
        health = {
          live: h.live,
          ready: h.ready,
          snapshotAt: h.snapshot_at,
          components: Object.fromEntries(
            Object.entries(h.components ?? {}).map(([k, v]: [string, any]) => [
              k,
              {
                status: v.status,
                state: v.state,
                reasonCode: v.reason_code,
                observedAt: v.observed_at,
                ...(k === 'mcp'
                  ? {
                      details: mcpDetails(v.details),
                    }
                  : {}),
              },
            ]),
          ),
        };
      } catch {
        health = { live: false, ready: false, note: '健康端点尚不可用。' };
      }
    }
    const confirmed =
      this.verification?.version === VERSION &&
      !!this.config &&
      this.verification.tunnelFingerprint === fingerprint(this.config.tunnelId);
    const forwarded = !!this.forwarded && health?.components?.['control-plane']?.status === 'ok';
    return {
      configured: !!this.config,
      processRunning: !!this.child,
      restartAttempts: this.failures,
      lastExit: this.lastExit,
      health,
      chatgptEndToEndVerified: confirmed || forwarded,
      verification: {
        userConfirmedAt: confirmed ? this.verification?.confirmedAt : undefined,
        latestForwardedTool: this.forwarded,
        basis: confirmed
          ? this.verification?.basis
          : forwarded
            ? 'observed_tunnel_forwarded_tool'
            : 'not_yet_observed',
      },
    };
  }
}
