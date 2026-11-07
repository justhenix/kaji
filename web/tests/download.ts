import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const base = process.env.TEST_BASE_URL ?? 'https://kaji.henix.my.id';
const expectedHash = process.env.EXPECTED_INSTALLER_SHA256?.toLowerCase();
const expectedBytes = Number(process.env.EXPECTED_INSTALLER_BYTES);
assert(expectedHash?.match(/^[a-f0-9]{64}$/) && expectedBytes > 0, 'Set the verified installer SHA256 and byte size');
const output = resolve(import.meta.dir, '../scratch/verification');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const started = page.waitForEvent('download', { timeout: 30_000 });
  const response = await page.goto(`${base}/download`);
  assert.equal(response?.status(), 200);
  const download = await started;
  assert.equal(download.suggestedFilename(), 'Kaji-0.1.1-x64-setup.exe');
  const stream = await download.createReadStream();
  const hash = new Bun.CryptoHasher('sha256');
  let bytes = 0;
  for await (const chunk of stream) { bytes += chunk.length; hash.update(chunk); }
  assert.equal(await download.failure(), null);
  assert.equal(bytes, expectedBytes);
  assert.equal(hash.digest('hex'), expectedHash);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => document.fonts.ready);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Download page overflows at ${width}px`);
    await page.screenshot({ path: resolve(output, `download-live-${width}.png`), fullPage: true });
  }
  const retryStarted = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download manually', exact: true }).click();
  const retry = await retryStarted;
  assert.equal(retry.suggestedFilename(), 'Kaji-0.1.1-x64-setup.exe');
  assert.equal(retry.url(), download.url());
  await retry.cancel();
  assert.deepEqual(errors, []);
  const report = { passed: true, base, url: download.url(), filename: download.suggestedFilename(), bytes, sha256: expectedHash, anonymousDownload: true, manualRetryStarted: true, viewportWidths: [1440, 390, 320] };
  await Bun.write(resolve(output, 'download-live.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
