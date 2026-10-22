import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { ROOT } from '../src/core.js';

const run = promisify(execFile);
const shells = ['powershell.exe'];
if (process.platform === 'win32') {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '(Get-AppxPackage Microsoft.PowerShell).InstallLocation'],
    { windowsHide: true },
  );
  if (stdout.trim()) shells.push(join(stdout.trim(), 'pwsh.exe'));
}
async function environment() {
  // AppData Temp is isolated by Store PowerShell too; all tested shells must see this fixture.
  const dir = await mkdtemp(join(homedir(), '.tinygrail startup test '));
  const env = { ...process.env, TG_DATA_DIR: dir, TG_PORT: '0' };
  delete env.CONTROL_PLANE_API_KEY;
  delete env.CONTROL_PLANE_TUNNEL_ID;
  return { dir, env };
}
const startArgs = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  join(ROOT, 'scripts/Start.ps1'),
  '-NoBrowser',
];

for (const shell of shells) {
  test(
    `${shell}: cold start and proxy-independent reopen reuse the same manager`,
    { skip: process.platform !== 'win32' },
    async () => {
      const { dir, env } = await environment();
      let runtime: any;
      try {
        const started = await run(shell, startArgs, {
          cwd: ROOT,
          env,
          windowsHide: true,
          timeout: 30000,
        });
        assert.match(started.stdout, /manager is running/);
        runtime = JSON.parse(await readFile(join(dir, 'runtime.json'), 'utf8'));
        assert.equal((await fetch(runtime.origin + '/health')).status, 200);
        const proxy = `Add-Type 'public class BadLocalProxy : System.Net.IWebProxy { public System.Net.ICredentials Credentials {get;set;} public bool IsBypassed(System.Uri u) {return false;} public System.Uri GetProxy(System.Uri u) {return new System.Uri("http://127.0.0.1:1");} }'; [System.Net.WebRequest]::DefaultWebProxy = New-Object BadLocalProxy; & '${join(ROOT, 'scripts/Start.ps1').replaceAll("'", "''")}' -NoBrowser`;
        const reopened = await run(
          shell,
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', proxy],
          { cwd: ROOT, env, windowsHide: true, timeout: 10000 },
        );
        assert.match(reopened.stdout, /manager is running/);
        assert.equal(JSON.parse(await readFile(join(dir, 'runtime.json'), 'utf8')).pid, runtime.pid);
      } finally {
        if (runtime)
          await run(process.execPath, [join(ROOT, 'dist/cli.js'), 'stop'], {
            cwd: ROOT,
            env,
            windowsHide: true,
          });
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test(
    `${shell}: launcher reports the actual startup failure and retains private diagnostics`,
    { skip: process.platform !== 'win32' },
    async () => {
      const { dir, env } = await environment();
      const occupied = createServer((_req, res) => res.end('occupied'));
      await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
      const address = occupied.address();
      assert.ok(address && typeof address !== 'string');
      env.TG_PORT = String(address.port);
      try {
        await assert.rejects(
          run(shell, startArgs, { cwd: ROOT, env, windowsHide: true, timeout: 15000 }),
          (e: any) => {
            assert.match(e.stderr, /EADDRINUSE/);
            assert.match(e.stderr, /manager-startup-error\.json/);
            return true;
          },
        );
        const diagnostic = JSON.parse(await readFile(join(dir, 'manager-startup-error.json'), 'utf8'));
        assert.equal(diagnostic.code, 'EADDRINUSE');
        assert.deepEqual(Object.keys(diagnostic).sort(), ['code', 'pid', 'time']);
        assert.equal((await fetch(`http://127.0.0.1:${address.port}`)).status, 200);
      } finally {
        await new Promise<void>((resolve) => occupied.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}

test(
  'Windows cmd start, restart and stop share the manager with Store PowerShell',
  { skip: process.platform !== 'win32' },
  async () => {
    const { dir, env } = await environment();
    const command = async (name: string, args = '') =>
      run('cmd.exe', ['/d', '/c', name, ...(args ? [args] : [])], {
        cwd: ROOT,
        env,
        windowsHide: true,
        timeout: 30000,
      });
    try {
      await command('Start.cmd', '-NoBrowser');
      const first = JSON.parse(await readFile(join(dir, 'runtime.json'), 'utf8'));
      await command('Restart.cmd', '-NoBrowser');
      const second = JSON.parse(await readFile(join(dir, 'runtime.json'), 'utf8'));
      assert.notEqual(first.instance, second.instance);
      await run(
        shells.at(-1)!,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(ROOT, 'scripts/Stop.ps1'),
        ],
        { cwd: ROOT, env, windowsHide: true, timeout: 30000 },
      );
      await assert.rejects(readFile(join(dir, 'runtime.json')), { code: 'ENOENT' });
      await command('Start.cmd', '-NoBrowser');
      await command('Stop.cmd');
      await assert.rejects(readFile(join(dir, 'runtime.json')), { code: 'ENOENT' });
    } finally {
      await run(process.execPath, [join(ROOT, 'dist/cli.js'), 'stop'], { cwd: ROOT, env, windowsHide: true });
      await rm(dir, { recursive: true, force: true });
    }
  },
);
