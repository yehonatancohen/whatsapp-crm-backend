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
    // Required for WA Web's AudioContext (PTT waveform generation) to work
    // in headless Chrome — without these the audio subsystem is unavailable
    // and decodeAudioData times out with a minified 't: t' error.
    '--use-fake-audio-capture',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ];

  if (proxy) {
    args.push(`--proxy-server=${proxy}`);
  }

  // Clean up Chromium lock files (prevents "Profile in use" error after crashes).
  // Note: SingletonLock is a symlink on Linux — fs.existsSync returns false for
  // broken symlinks, so we must unlink unconditionally and catch ENOENT.
  if (userDataDir) {
    for (const lockName of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try {
        fs.unlinkSync(path.join(userDataDir, lockName));
      } catch {
        // File doesn't exist — expected on clean starts
      }
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
