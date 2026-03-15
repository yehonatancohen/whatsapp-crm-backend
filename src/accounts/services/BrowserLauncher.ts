import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser } from 'puppeteer';

// Configure stealth plugin once at module level.
// Disable iframe.contentWindow evasion — it conflicts with
// WhatsApp Web's internal document.createElement monkey-patching.
const stealth = StealthPlugin();
stealth.enabledEvasions.delete('iframe.contentWindow');
puppeteer.use(stealth);

export async function launchStealthBrowser(proxy?: string, userDataDir?: string): Promise<Browser> {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
  ];

  if (proxy) {
    args.push(`--proxy-server=${proxy}`);
  }

  // Clean up Chromium lock file if it exists (prevents "Profile in use" error after crashes)
  if (userDataDir) {
    const lockFile = path.join(userDataDir, 'SingletonLock');
    try {
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
      }
    } catch (err) {
      // Ignore errors if file is already gone or inaccessible
    }
  }

  const browser = await puppeteer.launch({
    headless: true,
    args,
    userDataDir,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });

  return browser as unknown as Browser;
}
