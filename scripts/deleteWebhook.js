/**
 * Delete Telegram Webhook — run to switch back to polling mode.
 * Usage: node scripts/deleteWebhook.js
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
if (!TOKEN) { console.error('BOT_TOKEN not set'); process.exit(1); }

fetch(`https://api.telegram.org/bot${TOKEN}/deleteWebhook`)
  .then(r => r.json())
  .then(data => {
    if (data.ok) console.log('✅ Webhook deleted. You can now use polling mode.');
    else console.error('❌ Failed:', data.description);
  })
  .catch(err => console.error('Error:', err));
