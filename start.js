/**
 * Polling mode entry point — for local testing without Vercel.
 * Uses long-polling instead of webhooks.
 *
 * Run: node start.js
 * Requires BOT_TOKEN in environment or .env file
 */

'use strict';

// Load .env if present
try { require('fs').existsSync('.env') && require('child_process').execSync(''); } catch (_) {}
if (require('fs').existsSync('.env')) {
  const envContent = require('fs').readFileSync('.env', 'utf8');
  for (const line of envContent.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const fetch = require('node-fetch');
const { handleWebhook } = require('./lib/bot');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('❌ BOT_TOKEN not set! Create a .env file with BOT_TOKEN=your_token');
  process.exit(1);
}

const BASE_URL = `https://api.telegram.org/bot${TOKEN}`;

console.log('🚀 VISION + SFG + VAJIRAM + PW Bot starting in polling mode...');
console.log('Press Ctrl+C to stop.\n');

let offset = 0;

async function poll() {
  try {
    const res = await fetch(`${BASE_URL}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["message"]`);
    const data = await res.json();
    if (!data.ok) { console.error('getUpdates error:', data); return; }

    for (const update of data.result) {
      offset = update.update_id + 1;
      try {
        await handleWebhook(update);
      } catch (err) {
        console.error('Handler error for update', update.update_id, ':', err.message);
      }
    }
  } catch (err) {
    console.error('Poll error:', err.message);
  }
  setTimeout(poll, 1000);
}

poll();
