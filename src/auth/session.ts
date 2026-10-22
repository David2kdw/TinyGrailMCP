import { Cookie, CookieJar } from 'tough-cookie';
import { chromium, type Browser } from 'playwright';
import { randomUUID } from 'node:crypto';
import { AppError, object } from '../core.js';
import { Vault } from './vault.js';

export const API = 'https://tinygrail.com/api/';
export const LOGIN =
  'https://bgm.tv/oauth/authorize?response_type=code&client_id=bgm2525b0e4c7d93fec&redirect_uri=https%3A%2F%2Ftinygrail.com%2Fapi%2Faccount%2Fcallback';
const allowedCookie = (name: string) => /^\.AspNetCore\.Identity\.Application(?:C\d+)?$/.test(name);
interface SavedSession {
  epoch: string;
  jar: NonNullable<ReturnType<CookieJar['serializeSync']>>;
  account: string;
  nickname: string;
}
export class Session {
  jar = new CookieJar();
  epoch: string = randomUUID();
  account?: string;
  nickname?: string;
  state: 'logged_out' | 'unchecked' | 'authenticated' | 'expired' | 'logging_in' = 'logged_out';
  private browser?: Browser;
  private loginTask?: Promise<void>;
  private timer?: NodeJS.Timeout;
  constructor(private vault: Vault) {}
  async restore() {
    const saved = await this.vault.get<SavedSession>('session');
    if (saved) {
      this.jar = CookieJar.deserializeSync(saved.jar);
      this.epoch = saved.epoch;
      this.account = saved.account;
      this.nickname = saved.nickname;
      this.state = 'unchecked';
    }
  }
  status() {
    return {
      state: this.state,
      account: this.account,
      nickname: this.nickname,
      requiresLogin: ['logged_out', 'expired'].includes(this.state),
    };
  }
  async cookie() {
    const cookies = await this.jar.getCookies(API);
    return cookies
      .filter((c) => c.domain?.replace(/^\./, '') === 'tinygrail.com' && allowedCookie(c.key))
      .map((c) => c.cookieString())
      .join('; ');
  }
  async absorb(values: string[], epoch: string) {
    if (epoch !== this.epoch) return;
    let changed = false;
    for (const value of values) {
      const c = Cookie.parse(value);
      if (c && allowedCookie(c.key) && (!c.domain || c.domain.replace(/^\./, '') === 'tinygrail.com')) {
        await this.jar.setCookie(c, API);
        changed = true;
      }
    }
    if (changed && this.account) await this.save();
  }
  async save() {
    await this.vault.set('session', {
      epoch: this.epoch,
      jar: this.jar.serializeSync(),
      account: this.account,
      nickname: this.nickname,
    });
  }
  authenticated(value: unknown) {
    const v = object(value);
    if (!Number.isSafeInteger(Number(v.Id)) || Number(v.Id) <= 0 || typeof v.Name !== 'string')
      throw new AppError('SCHEMA', '资产接口未提供有效账户身份。');
    if (this.account && this.account !== String(v.Id))
      throw new AppError('ACCOUNT_CHANGED', '服务器账号已变更，请重新登录。');
    this.account = String(v.Id);
    this.nickname = typeof v.Nickname === 'string' ? v.Nickname : v.Name;
    this.state = 'authenticated';
  }
  expire() {
    if (this.state !== 'logging_in') this.state = 'expired';
  }
  async logout() {
    this.epoch = randomUUID();
    this.account = undefined;
    this.nickname = undefined;
    this.state = 'logged_out';
    this.jar = new CookieJar();
    clearTimeout(this.timer);
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
    await this.vault.remove('session');
  }
  async closeBrowser() {
    clearTimeout(this.timer);
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
  }
  beginLogin(check: () => Promise<unknown>) {
    if (this.loginTask) throw new AppError('LOGIN_BUSY', '登录窗口已经打开。');
    this.loginTask = this.login(check).finally(() => {
      this.loginTask = undefined;
    });
    // The UI observes status; OAuth URLs and callback codes are never logged.
    this.loginTask.catch(() => {
      if (this.state === 'logging_in') this.state = 'logged_out';
    });
  }
  private async login(check: () => Promise<unknown>) {
    await this.logout();
    this.state = 'logging_in';
    const epoch = this.epoch;
    try {
      this.browser = await chromium.launch({ headless: false });
      const ctx = await this.browser.newContext();
      const page = await ctx.newPage();
      this.timer = setTimeout(
        () => {
          void this.browser?.close();
        },
        10 * 60 * 1000,
      );
      await page.goto(LOGIN, { waitUntil: 'domcontentloaded', timeout: 60000 });
      while (this.state === 'logging_in' && epoch === this.epoch && this.browser.isConnected()) {
        // Query only the TinyGrail origin. Never read Bangumi cookies, passwords or form values.
        const cookies = (await ctx.cookies(['https://tinygrail.com/'])).filter(
          (c) => allowedCookie(c.name) && c.domain.replace(/^\./, '') === 'tinygrail.com',
        );
        if (cookies.length) {
          const jar = new CookieJar();
          for (const c of cookies)
            await jar.setCookie(
              new Cookie({
                key: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                secure: c.secure,
                httpOnly: c.httpOnly,
                expires: c.expires > 0 ? new Date(c.expires * 1000) : 'Infinity',
                sameSite: c.sameSite.toLowerCase() as 'strict' | 'lax' | 'none',
              }),
              API,
            );
          this.jar = jar;
          try {
            const profile = await check();
            if (epoch !== this.epoch) return;
            this.authenticated(profile);
            await this.save();
            return;
          } catch (e) {
            if (e instanceof AppError && e.code === 'ACCOUNT_CHANGED') throw e;
          }
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
      throw new AppError('LOGIN_CANCELLED', '登录已取消或超时。');
    } finally {
      clearTimeout(this.timer);
      await this.browser?.close().catch(() => {});
      this.browser = undefined;
      if (this.state === 'logging_in') this.state = 'logged_out';
    }
  }
}
