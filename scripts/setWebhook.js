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
  .then(data => {
    if (data.ok) console.log('✅ Webhook set to:', webhookUrl);
    else console.error('❌ Failed:', data.description);
  })
  .catch(err => console.error('Error:', err));
