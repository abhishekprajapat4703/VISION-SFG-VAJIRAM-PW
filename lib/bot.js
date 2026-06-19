/**
 * Main Bot Logic — VISION + SFG + VAJIRAM + PW
 * Handles all Telegram updates, session management, and routing
 * to individual PDF parsers.
 *
 * Modes:
 *  - sfg     : ForumIAS SFG 50Q (1 PDF)
 *  - vajiram : Vajiram & Ravi 100Q (2 PDFs: test + solution)
 *  - vision  : VisionIAS 100Q (2 PDFs: test + solution)
 *  - pw      : PW Only IAS / QuizForge Pro (2 PDFs: test + solution)
 *  - fixer   : TXT File Fixer (adds 😂 between Q body and options)
 */

'use strict';

const fetch = require('node-fetch');
const FormData = require('form-data');
const { parseSFG } = require('./parsers/sfg');
const { parseVajiram } = require('./parsers/vajiram');
const { parseVision } = require('./parsers/vision');
const { parsePW } = require('./parsers/pw');
const { fixTxtFile } = require('./fixer');

const TOKEN = process.env.BOT_TOKEN;
const BASE_URL = `https://api.telegram.org/bot${TOKEN}`;

// ─── Session store (in-memory; resets on cold starts) ───────────────────────
const sessions = {};
function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = { mode: null, step: null, files: {} };
  }
  return sessions[chatId];
}
function clearSession(chatId) {
  sessions[chatId] = { mode: null, step: null, files: {} };
}

// ─── Telegram API helpers ────────────────────────────────────────────────────
async function sendMessage(chatId, text, opts = {}) {
  await fetch(`${BASE_URL}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...opts }),
  });
}

async function sendDocument(chatId, buffer, filename, caption = '') {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', buffer, { filename, contentType: 'text/plain' });
  if (caption) form.append('caption', caption);
  await fetch(`${BASE_URL}/sendDocument`, { method: 'POST', body: form });
}

async function sendChatAction(chatId, action = 'upload_document') {
  await fetch(`${BASE_URL}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
}

async function downloadFile(fileId) {
  const r = await fetch(`${BASE_URL}/getFile?file_id=${fileId}`);
  const json = await r.json();
  if (!json.ok) throw new Error('getFile failed');
  const filePath = json.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
  const resp = await fetch(fileUrl);
  const buf = await resp.buffer();
  return buf;
}

// ─── Main menu keyboard ──────────────────────────────────────────────────────
const MAIN_MENU = {
  reply_markup: JSON.stringify({
    keyboard: [
      ['⚡ ForumIAS SFG — 50Q', '⚙️ Vajiram & Ravi — 100Q'],
      ['🔮 VisionIAS — 100Q', '🔥 PW Only IAS — 100Q'],
      ['🔧 TXT File Fixer', '❓ Help'],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  }),
};

// ─── Welcome / help text ─────────────────────────────────────────────────────
const WELCOME_TEXT = `🚀 <b>VISION + SFG + VAJIRAM + PW Bot</b>

Convert UPSC PDF files to perfectly formatted <code>.txt</code> files.

<b>Available Converters:</b>
⚡ <b>ForumIAS SFG</b> — 50Q (1 PDF needed)
⚙️ <b>Vajiram & Ravi</b> — 100Q (Test PDF + Solution PDF)
🔮 <b>VisionIAS</b> — 100Q (Test PDF + Solution PDF)
🔥 <b>PW Only IAS</b> — 100Q (Test PDF + Solution PDF)
🔧 <b>TXT Fixer</b> — Adds 😂 emoji between Q body and options

<b>Output Format:</b>
<code>Q1.Question text here
Statement 1
Statement 2
Which of the above?
😂
Option A ✅
Option B
Option C
Option D
Ex: Explanation text…</code>

Select a converter below 👇`;

const HELP_TEXT = `<b>📖 How to use:</b>

<b>ForumIAS SFG (50Q):</b>
→ Tap "⚡ ForumIAS SFG" → Upload 1 Solutions PDF

<b>Vajiram / VisionIAS / PW (100Q):</b>
→ Tap the converter → Upload <b>Test PDF</b> first → then <b>Solution PDF</b>

<b>TXT File Fixer:</b>
→ Tap "🔧 TXT File Fixer" → Upload your .txt file
→ The bot adds 😂 between question body and options

<b>Commands:</b>
/start — Show main menu
/sfg — ForumIAS SFG mode
/vajiram — Vajiram & Ravi mode
/vision — VisionIAS mode
/pw — PW Only IAS mode
/fixer — TXT File Fixer mode
/cancel — Cancel current operation

<b>⚠️ Notes:</b>
• PDFs must be text-based (not scanned images)
• Max file size: 20MB (Telegram limit)
• Processing may take 20–50 seconds for large PDFs`;

// ─── Webhook handler ─────────────────────────────────────────────────────────
async function handleWebhook(update) {
  if (!update) return;

  const message = update.message || update.edited_message;
  if (!message) return;

  const chatId = message.chat.id;
  const session = getSession(chatId);

  // ── Handle commands ──────────────────────────────────────────────────────
  if (message.text) {
    const text = message.text.trim();
    const lower = text.toLowerCase();

    if (lower === '/start' || lower === 'start') {
      clearSession(chatId);
      return sendMessage(chatId, WELCOME_TEXT, MAIN_MENU);
    }

    if (lower === '/help' || text === '❓ Help') {
      return sendMessage(chatId, HELP_TEXT);
    }

    if (lower === '/cancel') {
      clearSession(chatId);
      return sendMessage(chatId, '✅ Cancelled. Use the menu to start again.', MAIN_MENU);
    }

    // Mode selection
    if (lower === '/sfg' || text === '⚡ ForumIAS SFG — 50Q') {
      clearSession(chatId);
      session.mode = 'sfg';
      session.step = 'wait_pdf';
      return sendMessage(chatId,
        '📄 <b>ForumIAS SFG Mode</b>\n\nSend me the <b>Solutions PDF</b> (50 questions).\nMake sure it\'s a text-based PDF (not scanned).');
    }

    if (lower === '/vajiram' || text === '⚙️ Vajiram & Ravi — 100Q') {
      clearSession(chatId);
      session.mode = 'vajiram';
      session.step = 'wait_test';
      return sendMessage(chatId,
        '📚 <b>Vajiram & Ravi Mode</b>\n\nSend me the <b>Test Booklet PDF</b> (questions) first.');
    }

    if (lower === '/vision' || text === '🔮 VisionIAS — 100Q') {
      clearSession(chatId);
      session.mode = 'vision';
      session.step = 'wait_test';
      return sendMessage(chatId,
        '🔮 <b>VisionIAS Mode</b>\n\nSend me the <b>Test Booklet PDF</b> (questions) first.');
    }

    if (lower === '/pw' || text === '🔥 PW Only IAS — 100Q') {
      clearSession(chatId);
      session.mode = 'pw';
      session.step = 'wait_test';
      return sendMessage(chatId,
        '🔥 <b>PW Only IAS Mode</b>\n\nSend me the <b>Test PDF</b> (questions) first.\n\n<i>Supports: Statement I/II/III, Match-the-Following, Hindi-skip, all UPSC formats.</i>');
    }

    if (lower === '/fixer' || text === '🔧 TXT File Fixer') {
      clearSession(chatId);
      session.mode = 'fixer';
      session.step = 'wait_txt';
      return sendMessage(chatId,
        '🔧 <b>TXT File Fixer Mode</b>\n\nSend me your <b>.txt file</b>.\n\nThis will add <code>😂</code> between question body and options if missing.');
    }

    // No mode set — show menu
    if (!session.mode) {
      return sendMessage(chatId, 'Please select a converter from the menu below 👇', MAIN_MENU);
    }
  }

  // ── Handle documents (PDF / TXT files) ───────────────────────────────────
  if (message.document) {
    const doc = message.document;
    const filename = doc.file_name || 'file';
    const fileId = doc.file_id;
    const mimeType = doc.mime_type || '';

    // No mode set
    if (!session.mode) {
      return sendMessage(chatId, '⚠️ Please select a converter first.', MAIN_MENU);
    }

    // TXT Fixer
    if (session.mode === 'fixer' && session.step === 'wait_txt') {
      if (!mimeType.includes('text') && !filename.endsWith('.txt')) {
        return sendMessage(chatId, '❌ Please send a <b>.txt file</b>.');
      }
      await sendChatAction(chatId, 'upload_document');
      try {
        const buf = await downloadFile(fileId);
        const result = fixTxtFile(buf.toString('utf8'));
        if (result.error) return sendMessage(chatId, `❌ Error: ${result.error}`);
        const outBuf = Buffer.from(result.text, 'utf8');
        const outName = filename.replace(/\.txt$/i, '') + '_FIXED.txt';
        await sendDocument(chatId, outBuf, outName,
          `✅ Fixed!\n📊 ${result.questionsFixed} questions had 😂 added.\n📄 ${result.total} questions total.`);
        clearSession(chatId);
        return sendMessage(chatId, 'Done! Use menu for another conversion.', MAIN_MENU);
      } catch (err) {
        console.error('Fixer error:', err);
        return sendMessage(chatId, `❌ Failed: ${err.message}`);
      }
    }

    // PDF checks
    if (!mimeType.includes('pdf') && !filename.toLowerCase().endsWith('.pdf')) {
      return sendMessage(chatId, '❌ Please send a <b>PDF file</b>.');
    }

    // ── ForumIAS SFG ─────────────────────────────────────────────────────
    if (session.mode === 'sfg' && session.step === 'wait_pdf') {
      await sendChatAction(chatId);
      await sendMessage(chatId, '⏳ Processing SFG PDF… This may take 20–40 seconds.');
      try {
        const pdfBuf = await downloadFile(fileId);
        const result = await parseSFG(pdfBuf);
        if (result.error) return sendMessage(chatId, `❌ Error: ${result.error}`);
        const outBuf = Buffer.from(result.text, 'utf8');
        const outName = filename.replace(/\.pdf$/i, '') + '_SFG_CONVERTED.txt';
        const qCount = result.questionCount;
        await sendDocument(chatId, outBuf, outName,
          `✅ <b>SFG Conversion Complete!</b>\n📊 Questions: ${qCount}/50\n${qCount < 50 ? '⚠️ Some questions may be missing — check output.' : '🎉 All 50 questions extracted!'}`);
        clearSession(chatId);
        return sendMessage(chatId, 'Done! Use menu for another conversion.', MAIN_MENU);
      } catch (err) {
        console.error('SFG error:', err);
        return sendMessage(chatId, `❌ Failed to process: ${err.message}`);
      }
    }

    // ── Vajiram ──────────────────────────────────────────────────────────
    if (session.mode === 'vajiram') {
      if (session.step === 'wait_test') {
        session.files.testId = fileId;
        session.files.testName = filename;
        session.step = 'wait_sol';
        return sendMessage(chatId,
          `✅ Got Test PDF: <code>${filename}</code>\n\nNow send the <b>Solution/Answer Key PDF</b>.`);
      }
      if (session.step === 'wait_sol') {
        await sendChatAction(chatId);
        await sendMessage(chatId, '⏳ Processing Vajiram PDFs… This may take 30–50 seconds.');
        try {
          const testBuf = await downloadFile(session.files.testId);
          const solBuf = await downloadFile(fileId);
          const result = await parseVajiram(testBuf, solBuf);
          if (result.error) return sendMessage(chatId, `❌ Error: ${result.error}`);
          const outBuf = Buffer.from(result.text, 'utf8');
          const outName = session.files.testName.replace(/\.pdf$/i, '') + '_VAJIRAM_COMPILED.txt';
          await sendDocument(chatId, outBuf, outName,
            `✅ <b>Vajiram Compilation Complete!</b>\n📊 Questions: ${result.questionCount}/100\n🎯 Answers matched: ${result.answersMatched}`);
          clearSession(chatId);
          return sendMessage(chatId, 'Done! Use menu for another conversion.', MAIN_MENU);
        } catch (err) {
          console.error('Vajiram error:', err);
          return sendMessage(chatId, `❌ Failed: ${err.message}`);
        }
      }
    }

    // ── VisionIAS ─────────────────────────────────────────────────────────
    if (session.mode === 'vision') {
      if (session.step === 'wait_test') {
        session.files.testId = fileId;
        session.files.testName = filename;
        session.step = 'wait_sol';
        return sendMessage(chatId,
          `✅ Got Test PDF: <code>${filename}</code>\n\nNow send the <b>Solution PDF</b> (with Q 1.A style answers).`);
      }
      if (session.step === 'wait_sol') {
        await sendChatAction(chatId);
        await sendMessage(chatId, '⏳ Processing VisionIAS PDFs… This may take 30–50 seconds.');
        try {
          const testBuf = await downloadFile(session.files.testId);
          const solBuf = await downloadFile(fileId);
          const result = await parseVision(testBuf, solBuf);
          if (result.error) return sendMessage(chatId, `❌ Error: ${result.error}`);
          const outBuf = Buffer.from(result.text, 'utf8');
          const outName = session.files.testName.replace(/\.pdf$/i, '') + '_VISION_CONVERTED.txt';
          await sendDocument(chatId, outBuf, outName,
            `✅ <b>VisionIAS Conversion Complete!</b>\n📊 Questions: ${result.questionCount}/100\n✅ Matched: ${result.matched}\n⚠️ No Answer: ${result.noAns}\n⚠️ No Explanation: ${result.noExpl}`);
          clearSession(chatId);
          return sendMessage(chatId, 'Done! Use menu for another conversion.', MAIN_MENU);
        } catch (err) {
          console.error('Vision error:', err);
          return sendMessage(chatId, `❌ Failed: ${err.message}`);
        }
      }
    }

    // ── PW Only IAS ───────────────────────────────────────────────────────
    if (session.mode === 'pw') {
      if (session.step === 'wait_test') {
        session.files.testId = fileId;
        session.files.testName = filename;
        session.step = 'wait_sol';
        return sendMessage(chatId,
          `✅ Got Test PDF: <code>${filename}</code>\n\nNow send the <b>Solution PDF</b> (with answers + explanations).`);
      }
      if (session.step === 'wait_sol') {
        await sendChatAction(chatId);
        await sendMessage(chatId, '⏳ Processing PW Only IAS PDFs… This may take 30–50 seconds.\n\n<i>Skipping Hindi sections, extracting English questions…</i>');
        try {
          const testBuf = await downloadFile(session.files.testId);
          const solBuf = await downloadFile(fileId);
          const result = await parsePW(testBuf, solBuf);
          if (result.error) return sendMessage(chatId, `❌ Error: ${result.error}`);
          const outBuf = Buffer.from(result.text, 'utf8');
          const outName = session.files.testName.replace(/\.pdf$/i, '') + '_PW_CONVERTED.txt';
          await sendDocument(chatId, outBuf, outName,
            `✅ <b>PW Only IAS Conversion Complete!</b>\n📊 Questions: ${result.questionCount}\n✅ Matched: ${result.matched}\n⏭️ Hindi Skipped: ${result.hindiSkipped}\n⚠️ No Answer: ${result.noAns}`);
          clearSession(chatId);
          return sendMessage(chatId, 'Done! Use menu for another conversion.', MAIN_MENU);
        } catch (err) {
          console.error('PW error:', err);
          return sendMessage(chatId, `❌ Failed: ${err.message}`);
        }
      }
    }
  }
}

module.exports = { handleWebhook };
