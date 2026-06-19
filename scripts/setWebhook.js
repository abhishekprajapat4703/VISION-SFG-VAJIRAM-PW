/**
 * Set Telegram Webhook — run once after deploying to Vercel.
 * Usage: node scripts/setWebhook.js https://your-app.vercel.app
 */

'use strict';

if (require('fs').existsSync('.env')) {
  const envContent = require('fs').readFileSync('.env', 'utf8');
  for (const line of envContent.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const fetch = require('node-fetch');
const TOKEN = process.env.BOT_TOKEN;
const url = process.argv[2];

if (!TOKEN) { console.error('BOT_TOKEN not set'); process.exit(1); }
if (!url)   { console.error('Usage: node scripts/setWebhook.js https://your-app.vercel.app'); process.exit(1); }

const webhookUrl = `${url}/api/webhook`;
const apiUrl = `https://api.telegram.org/bot${TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;

fetch(apiUrl)
  .then(r => r.json())
  .then(async data => {
    if (data.ok) {
      console.log('✅ Webhook set to:', webhookUrl);
      
      // Set bot commands list in Telegram menu
      const cmdUrl = `https://api.telegram.org/bot${TOKEN}/setMyCommands`;
      const cmdBody = {
        commands: [
          { command: 'start', description: 'Start the bot and show main menu' },
          { command: 'sfg', description: 'ForumIAS SFG Mode (1 PDF)' },
          { command: 'vajiram', description: 'Vajiram & Ravi Mode (2 PDFs)' },
          { command: 'vision', description: 'VisionIAS Mode (2 PDFs)' },
          { command: 'pw', description: 'PW Only IAS Mode (2 PDFs)' },
          { command: 'fixer', description: 'TXT File Fixer Mode (.txt)' },
          { command: 'cancel', description: 'Cancel current operation' },
          { command: 'help', description: 'Show detailed usage help' }
        ]
      };
      
      const cmdRes = await fetch(cmdUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cmdBody)
      });
      const cmdData = await cmdRes.json();
      if (cmdData.ok) {
        console.log('✅ Bot commands set successfully!');
      } else {
        console.error('❌ Failed to set bot commands:', cmdData.description);
      }
    }
    else console.error('❌ Failed:', data.description);
  })
  .catch(err => console.error('Error:', err));
