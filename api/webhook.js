/**
 * Telegram Webhook Endpoint — receives all updates from Telegram.
 * Unified handler for VISION + SFG + VAJIRAM + PW BOT.
 *
 * ⚠️ Vercel serverless timeout:
 *    - Hobby plan: 10 seconds
 *    - Pro plan: 60 seconds (configurable up to 300s with maxDuration)
 *
 * For large PDFs, consider using polling mode (node start.js) which
 * avoids the timeout limitation entirely.
 */
const { handleWebhook } = require('../lib/bot');

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      await handleWebhook(req.body);
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Webhook error:', err);
      res.status(200).json({ ok: true }); // Always 200 to Telegram
    }
  } else {
    res.status(200).send('VISION + SFG + VAJIRAM + PW Bot is running! 🚀');
  }
};
