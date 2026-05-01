import path from 'path';
import { Client, LocalAuth } from 'whatsapp-web.js';
import { launchStealthBrowser } from '../src/accounts/services/BrowserLauncher';

async function main() {
  const sessionDir = path.resolve('.wwebjs_auth', 'session-cmo4oj27l0017pf010hy76ima');
  
  // Launch browser with the same profile
  const browser = await launchStealthBrowser(undefined, sessionDir);
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'cmo4oj27l0017pf010hy76ima' }),
    puppeteer: { browserWSEndpoint: browser.wsEndpoint() },
  });

  client.on('ready', async () => {
    console.log('Client ready');
    const pupPage = (client as any).pupPage;
    
    const stats = await pupPage.evaluate(() => {
      const S = (globalThis as any).Store;
      const models = S?.Chat?.models || [];
      const privateChats = models.filter((c: any) => c.id?._serialized?.endsWith('@c.us'));
      const groupChats = models.filter((c: any) => c.id?._serialized?.endsWith('@g.us'));
      
      return {
        total: models.length,
        private: privateChats.length,
        groups: groupChats.length,
        firstPrivateIndex: models.findIndex((c: any) => c.id?._serialized?.endsWith('@c.us')),
      };
    });
    
    console.log('Stats:', stats);
    await browser.close();
    process.exit(0);
  });

  console.log('Initializing client...');
  await client.initialize();
}

main().catch(console.error);
