import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createManager } from '../src/main.js';
import { ROOT } from '../src/core.js';
import { fixture } from './helpers.js';

test('browser renders actual manager, shows escaped server data and requires independent local confirmation', async () => {
  const f = await fixture();
  f.chara.Name = '<img src=x onerror=alert(1)>';
  const m = await createManager({ dir: f.dir, port: 0, queries: f.q, vault: f.vault });
  const browser = await chromium.launch({ headless: true }),
    page = await browser.newPage({ viewport: { width: 1440, height: 1150 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${m.runtime.origin}/#${m.runtime.bootstrap}`);
    await page.locator('#workspace').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#write-state').innerText(), '已关闭');
    assert.equal(await page.locator('img').count(), 0);
    await page.getByRole('button', { name: '查询真实公开角色', exact: true }).click();
    await page.waitForFunction(() =>
      document.getElementById('diagnostic')?.textContent?.includes('CharacterId'),
    );
    assert.equal(await page.locator('img').count(), 0);
    const p = await m.safety.prepare('buy', {
      characterId: 1,
      price: '10',
      amount: 2,
      requestId: 'ui-prepare-01',
    });
    await m.safety.policy({
      enabled: true,
      allowedActions: ['buy'],
      perTrade: '1000',
      daily: '5000',
      maxShares: 100,
      acknowledgeUnverified: true,
    });
    await page.reload();
    await page.getByRole('button', { name: '核对并批准', exact: true }).waitFor();
    await page.getByRole('button', { name: '核对并批准', exact: true }).click();
    assert.equal(f.writes.length, 0);
    assert.equal(await page.locator('#approve-final').isDisabled(), true);
    assert.equal(await page.locator('img').count(), 0);
    await page.locator('#approval-check').check();
    await page.locator('#approve-final').click();
    await page.waitForFunction(() =>
      document.getElementById('diagnostic')?.textContent?.includes('"verified": true'),
    );
    assert.equal(f.writes.length, 1);
    await page.locator('#kill').click();
    await page.waitForFunction(() => document.getElementById('write-state')?.textContent === '已关闭');
    assert.equal(m.safety.status().policy.enabled, false);
    f.temple.Level = 2;
    const image = await m.safety.prepare('image_upload', {
      characterId: 1,
      requestId: 'ui-image-preview',
      kind: 'cover',
      mime: 'image/png',
      imageBase64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/SAAAAAASUVORK5CYII=',
    });
    assert.equal((await fetch(m.runtime.origin + '/api/plan-image/' + image.id)).status, 403);
    await page.reload();
    await page.waitForFunction(() => [...document.images].some((img) => img.naturalWidth === 1));
    assert.equal(f.writes.length, 1);
    await mkdir(join(ROOT, 'private-data'), { recursive: true });
    await page.screenshot({ path: join(ROOT, 'private-data/ui-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(ROOT, 'private-data/ui-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await m.close();
  }
});
