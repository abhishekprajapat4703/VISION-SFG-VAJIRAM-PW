/**
 * Main Bot Logic — VISION + SFG + VAJIRAM + PW
 * v2.0 — Fixed PDF processing, live progress messages, detailed report cards
 */

'use strict';

const fetch  = require('node-fetch');
const FormData = require('form-data');
const { parseSFG }     = require('./parsers/sfg');
const { parseVajiram } = require('./parsers/vajiram');
const { parseVision }  = require('./parsers/vision');
const { parsePW }      = require('./parsers/pw');
const { fixTxtFile }   = require('./fixer');

const TOKEN    = process.env.BOT_TOKEN;
const BASE_URL = `https://api.telegram.org/bot${TOKEN}`;

// ─── Session store ────────────────────────────────────────────────────────────
const sessions = new Map();
function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, { mode: null, step: null, files: {} });
  return sessions.get(chatId);
}
function clearSession(chatId) {
  sessions.set(chatId, { mode: null, step: null, files: {} });
}

// ─── Telegram API helpers ─────────────────────────────────────────────────────
async function sendMessage(chatId, text, opts = {}) {
  const r = await fetch(`${BASE_URL}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...opts }),
  });
  const d = await r.json();
  return d.result;          // returns message object (has message_id)
}

async function editMessage(chatId, msgId, text) {
  await fetch(`${BASE_URL}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML' }),
  });
}

async function sendDocument(chatId, buffer, filename, caption = '') {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', buffer, { filename, contentType: 'text/plain' });
  if (caption) form.append('caption', caption, { contentType: 'text/plain' });
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
  const r    = await fetch(`${BASE_URL}/getFile?file_id=${fileId}`);
  const json = await r.json();
  if (!json.ok) throw new Error(`Telegram getFile failed: ${json.description}`);
  const url  = `https://api.telegram.org/file/bot${TOKEN}/${json.result.file_path}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`File download failed: ${resp.status}`);
  return resp.buffer();
}

// ─── Progress helper ──────────────────────────────────────────────────────────
function progressBar(pct) {
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}%`;
}

// ─── Report Card builder ──────────────────────────────────────────────────────
function buildReportCard(mode, stats) {
  const line = '━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const modeLabels = {
    sfg:     '⚡ ForumIAS SFG',
    vajiram: '⚙️ Vajiram &amp; Ravi',
    vision:  '🔮 VisionIAS',
    pw:      '🔥 PW Only IAS',
    fixer:   '🔧 TXT Fixer',
  };
  const label = modeLabels[mode] || mode;

  let card = `\n📊 <b>REPORT CARD</b>\n${line}\n`;
  card += `📌 <b>Mode:</b> ${label}\n`;
  card += `${line}\n`;

  if (stats.testFile)  card += `📄 <b>Test PDF:</b> <code>${stats.testFile}</code>\n`;
  if (stats.solFile)   card += `📄 <b>Solution PDF:</b> <code>${stats.solFile}</code>\n`;
  if (stats.inputFile) card += `📄 <b>Input File:</b> <code>${stats.inputFile}</code>\n`;
  card += `${line}\n`;

  if (stats.testQuestions  !== undefined) card += `📝 <b>Questions (Test PDF):</b>   ${stats.testQuestions}\n`;
  if (stats.solAnswers     !== undefined) card += `🔑 <b>Answers (Solution PDF):</b> ${stats.solAnswers}\n`;
  if (stats.matched        !== undefined) card += `✅ <b>Fully Matched:</b>          ${stats.matched}\n`;
  if (stats.noAns          !== undefined) card += `⚠️ <b>No Answer Found:</b>        ${stats.noAns}\n`;
  if (stats.noExpl         !== undefined) card += `⚠️ <b>No Explanation:</b>         ${stats.noExpl}\n`;
  if (stats.hindiSkipped   !== undefined) card += `⏭️ <b>Hindi Q Skipped:</b>        ${stats.hindiSkipped}\n`;
  if (stats.txtQuestions   !== undefined) card += `📤 <b>Questions in .txt:</b>      ${stats.txtQuestions}\n`;
  if (stats.questionsFixed !== undefined) card += `🔧 <b>😂 Added to:</b>            ${stats.questionsFixed} questions\n`;
  if (stats.total          !== undefined && stats.questionsFixed !== undefined)
                                          card += `📊 <b>Total Questions:</b>         ${stats.total}\n`;
  if (stats.outputLines    !== undefined) card += `📏 <b>Output Lines:</b>           ${stats.outputLines}\n`;
  if (stats.processingTime !== undefined) card += `⏱️ <b>Processing Time:</b>        ${stats.processingTime}s\n`;
  card += `${line}\n`;

  // Accuracy %
  if (stats.matched !== undefined && stats.testQuestions) {
    const acc = Math.round((stats.matched / stats.testQuestions) * 100);
    card += `🎯 <b>Match Rate:</b> ${acc}%\n`;
    if (acc === 100) card += `🏆 Perfect match!\n`;
    else if (acc >= 90) card += `✨ Excellent result!\n`;
    else if (acc >= 70) card += `👍 Good result!\n`;
    else card += `⚠️ Some questions may need manual check.\n`;
    card += `${line}\n`;
  }

  return card;
}

// ─── Main menu ────────────────────────────────────────────────────────────────
const MAIN_MENU = {
  reply_markup: JSON.stringify({
    keyboard: [
      ['⚡ ForumIAS SFG — 50Q', '⚙️ Vajiram & Ravi — 100Q'],
      ['🔮 VisionIAS — 100Q',   '🔥 PW Only IAS — 100Q'],
      ['🔧 TXT File Fixer',     '❓ Help'],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  }),
};

const WELCOME =
`🚀 <b>VISION + SFG + VAJIRAM + PW Bot</b>

Convert UPSC PDFs to perfectly formatted <code>.txt</code> files instantly!

<b>📚 Available Converters:</b>
⚡ <b>ForumIAS SFG</b> — 50Q (1 PDF)
⚙️ <b>Vajiram &amp; Ravi</b> — 100Q (Test + Solution PDF)
🔮 <b>VisionIAS</b> — 100Q (Test + Solution PDF)
🔥 <b>PW Only IAS</b> — 100Q (Test + Solution PDF)
🔧 <b>TXT Fixer</b> — Add 😂 to existing .txt files

<b>📄 Output Format:</b>
<code>Q1.Question text
1. Statement one
2. Statement two
Which is correct?
😂
Option A ✅
Option B
Option C
Option D
Ex: Explanation here...</code>

👇 Select a converter below:`;

const HELP =
`<b>📖 How to Use:</b>

<b>SFG (1 PDF):</b>
→ Tap "⚡ ForumIAS SFG" → Send Solutions PDF

<b>Vajiram / Vision / PW (2 PDFs):</b>
→ Tap converter → Send <b>Test PDF</b> → then <b>Solution PDF</b>

<b>TXT Fixer:</b>
→ Tap "🔧 TXT File Fixer" → Send your .txt file

<b>Commands:</b>
/start — Main menu  |  /cancel — Cancel
/sfg /vajiram /vision /pw /fixer

<b>⚠️ Notes:</b>
• PDFs must be text-based (not scanned)
• Max size: 20MB (Telegram limit)
• Takes 20–50s for large PDFs`;

// ─── Webhook handler ──────────────────────────────────────────────────────────
async function handleWebhook(update) {
  if (!update) return;
  const message = update.message || update.edited_message;
  if (!message) return;

  const chatId  = message.chat.id;
  const session = getSession(chatId);

  // ── Text commands ───────────────────────────────────────────────────────────
  if (message.text) {
    const text  = message.text.trim();
    const lower = text.toLowerCase();

    if (lower === '/start') { clearSession(chatId); return sendMessage(chatId, WELCOME, MAIN_MENU); }
    if (lower === '/help' || text === '❓ Help') return sendMessage(chatId, HELP);
    if (lower === '/cancel') { clearSession(chatId); return sendMessage(chatId, '✅ Cancelled.', MAIN_MENU); }

    const MODE_MAP = {
      '/sfg':            'sfg',
      '⚡ forumias sfg — 50q': 'sfg',
      '/vajiram':        'vajiram',
      '⚙️ vajiram & ravi — 100q': 'vajiram',
      '/vision':         'vision',
      '🔮 visionias — 100q': 'vision',
      '/pw':             'pw',
      '🔥 pw only ias — 100q': 'pw',
      '/fixer':          'fixer',
      '🔧 txt file fixer': 'fixer',
    };
    const mode = MODE_MAP[lower];
    if (mode) {
      clearSession(chatId);
      session.mode = mode;
      const msgs = {
        sfg:     '📄 <b>ForumIAS SFG Mode</b>\n\nSend me the <b>Solutions PDF</b> (50 questions).',
        vajiram: '📚 <b>Vajiram &amp; Ravi Mode</b>\n\nSend the <b>Test Booklet PDF</b> (questions) first.',
        vision:  '🔮 <b>VisionIAS Mode</b>\n\nSend the <b>Test Booklet PDF</b> (questions) first.',
        pw:      '🔥 <b>PW Only IAS Mode</b>\n\nSend the <b>Test PDF</b> (questions) first.\n<i>Hindi sections will be auto-skipped.</i>',
        fixer:   '🔧 <b>TXT Fixer Mode</b>\n\nSend your <b>.txt file</b> — I will add 😂 where missing.',
      };
      session.step = mode === 'sfg' ? 'wait_pdf' : mode === 'fixer' ? 'wait_txt' : 'wait_test';
      return sendMessage(chatId, msgs[mode]);
    }

    if (!session.mode) return sendMessage(chatId, 'Please choose a converter 👇', MAIN_MENU);
  }

  // ── Documents ───────────────────────────────────────────────────────────────
  if (message.document) {
    const doc      = message.document;
    const filename = doc.file_name || 'file';
    const fileId   = doc.file_id;
    const mime     = doc.mime_type || '';
    const isPDF    = mime.includes('pdf') || filename.toLowerCase().endsWith('.pdf');
    const isTXT    = mime.includes('text') || filename.toLowerCase().endsWith('.txt');

    if (!session.mode) return sendMessage(chatId, '⚠️ Please choose a converter first.', MAIN_MENU);

    // ── TXT Fixer ─────────────────────────────────────────────────────────────
    if (session.mode === 'fixer') {
      if (!isTXT) return sendMessage(chatId, '❌ Please send a <b>.txt file</b>.');
      await sendChatAction(chatId);
      const prog = await sendMessage(chatId,
        `⏳ <b>Processing TXT File...</b>\n${progressBar(20)}\n\nReading file...`);
      const t0 = Date.now();
      try {
        const buf    = await downloadFile(fileId);
        await editMessage(chatId, prog.message_id,
          `⏳ <b>Processing TXT File...</b>\n${progressBar(60)}\n\nFixing 😂 markers...`);
        const result = fixTxtFile(buf.toString('utf8'));
        if (result.error) {
          await editMessage(chatId, prog.message_id, `❌ Error: ${result.error}`);
          return;
        }
        await editMessage(chatId, prog.message_id,
          `⏳ <b>Processing TXT File...</b>\n${progressBar(95)}\n\nPreparing file...`);
        const outBuf  = Buffer.from(result.text, 'utf8');
        const outName = filename.replace(/\.txt$/i, '') + '_FIXED.txt';
        const secs    = ((Date.now() - t0) / 1000).toFixed(1);
        await editMessage(chatId, prog.message_id, `✅ <b>Done!</b>`);
        await sendDocument(chatId, outBuf, outName);
        await sendMessage(chatId, buildReportCard('fixer', {
          inputFile:      filename,
          questionsFixed: result.questionsFixed,
          total:          result.total,
          outputLines:    result.text.split('\n').length,
          processingTime: secs,
        }));
        clearSession(chatId);
        return sendMessage(chatId, '✅ Use menu for another conversion.', MAIN_MENU);
      } catch (err) {
        console.error(err);
        await editMessage(chatId, prog.message_id, `❌ Failed: ${err.message}`);
      }
      return;
    }

    // ── PDF required beyond this point ────────────────────────────────────────
    if (!isPDF) return sendMessage(chatId, '❌ Please send a <b>PDF file</b>.');

    // ── SFG (1 PDF) ───────────────────────────────────────────────────────────
    if (session.mode === 'sfg') {
      await sendChatAction(chatId);
      const prog = await sendMessage(chatId,
        `⏳ <b>ForumIAS SFG Processing...</b>\n${progressBar(10)}\n\nDownloading PDF...`);
      const t0 = Date.now();
      try {
        const pdfBuf = await downloadFile(fileId);
        await editMessage(chatId, prog.message_id,
          `⏳ <b>ForumIAS SFG Processing...</b>\n${progressBar(40)}\n\nExtracting text from PDF...`);
        const result = await parseSFG(pdfBuf);
        if (result.error) { await editMessage(chatId, prog.message_id, `❌ Error: ${result.error}`); return; }
        await editMessage(chatId, prog.message_id,
          `⏳ <b>ForumIAS SFG Processing...</b>\n${progressBar(90)}\n\nPreparing .txt file...`);
        const outBuf  = Buffer.from(result.text, 'utf8');
        const outName = filename.replace(/\.pdf$/i, '') + '_SFG_CONVERTED.txt';
        const secs    = ((Date.now() - t0) / 1000).toFixed(1);
        await editMessage(chatId, prog.message_id, `✅ <b>SFG Conversion Complete!</b>`);
        await sendDocument(chatId, outBuf, outName);
        await sendMessage(chatId, buildReportCard('sfg', {
          testFile:       filename,
          testQuestions:  result.questionCount,
          txtQuestions:   result.questionCount,
          matched:        result.answersFound || result.questionCount,
          noAns:          result.noAns || 0,
          outputLines:    result.text.split('\n').length,
          processingTime: secs,
        }));
        clearSession(chatId);
        return sendMessage(chatId, '✅ Done! Choose another converter 👇', MAIN_MENU);
      } catch (err) {
        console.error(err);
        await editMessage(chatId, prog.message_id, `❌ Failed: ${err.message}`);
      }
      return;
    }

    // ── 2-PDF converters (Vajiram, Vision, PW) ────────────────────────────────
    if (['vajiram', 'vision', 'pw'].includes(session.mode)) {
      if (session.step === 'wait_test') {
        session.files.testId   = fileId;
        session.files.testName = filename;
        session.step           = 'wait_sol';
        const nextMsg = {
          vajiram: '✅ Got <b>Test PDF!</b>\n\nNow send the <b>Solution / Answer Key PDF</b>.',
          vision:  '✅ Got <b>Test PDF!</b>\n\nNow send the <b>Solution PDF</b> (with Q 1.A style answers).',
          pw:      '✅ Got <b>Test PDF!</b>\n\nNow send the <b>Solution PDF</b> (answers + explanations).',
        };
        return sendMessage(chatId, `${nextMsg[session.mode]}\n\n<i>📄 Saved: <code>${filename}</code></i>`);
      }

      if (session.step === 'wait_sol') {
        await sendChatAction(chatId);
        const modeLabel = { vajiram: 'Vajiram & Ravi', vision: 'VisionIAS', pw: 'PW Only IAS' }[session.mode];
        const prog = await sendMessage(chatId,
          `⏳ <b>${modeLabel} Processing...</b>\n${progressBar(5)}\n\nDownloading Test PDF...`);
        const t0 = Date.now();
        try {
          const testBuf = await downloadFile(session.files.testId);
          await editMessage(chatId, prog.message_id,
            `⏳ <b>${modeLabel} Processing...</b>\n${progressBar(20)}\n\nDownloading Solution PDF...`);
          const solBuf = await downloadFile(fileId);

          await editMessage(chatId, prog.message_id,
            `⏳ <b>${modeLabel} Processing...</b>\n${progressBar(45)}\n\nExtracting questions from Test PDF...`);

          let result;
          if (session.mode === 'vajiram') result = await parseVajiram(testBuf, solBuf);
          if (session.mode === 'vision')  result = await parseVision(testBuf, solBuf);
          if (session.mode === 'pw')      result = await parsePW(testBuf, solBuf);

          if (result.error) { await editMessage(chatId, prog.message_id, `❌ Error: ${result.error}`); return; }

          await editMessage(chatId, prog.message_id,
            `⏳ <b>${modeLabel} Processing...</b>\n${progressBar(85)}\n\nBuilding .txt file...`);

          const suffix   = { vajiram: 'VAJIRAM', vision: 'VISION', pw: 'PW' }[session.mode];
          const outBuf   = Buffer.from(result.text, 'utf8');
          const outName  = session.files.testName.replace(/\.pdf$/i, '') + `_${suffix}_CONVERTED.txt`;
          const secs     = ((Date.now() - t0) / 1000).toFixed(1);

          await editMessage(chatId, prog.message_id,
            `✅ <b>${modeLabel} — Conversion Complete!</b>`);
          await sendDocument(chatId, outBuf, outName);

          // Build report card stats
          const stats = {
            testFile:       session.files.testName,
            solFile:        filename,
            testQuestions:  result.questionCount,
            solAnswers:     result.answersFound || result.answersMatched || result.questionCount,
            matched:        result.matched || result.answersMatched,
            noAns:          result.noAns,
            noExpl:         result.noExpl,
            hindiSkipped:   result.hindiSkipped,
            txtQuestions:   result.questionCount,
            outputLines:    result.text.split('\n').length,
            processingTime: secs,
          };
          // Clean undefined keys
          Object.keys(stats).forEach(k => stats[k] === undefined && delete stats[k]);
          await sendMessage(chatId, buildReportCard(session.mode, stats));

          clearSession(chatId);
          return sendMessage(chatId, '✅ Done! Choose another converter 👇', MAIN_MENU);
        } catch (err) {
          console.error(err);
          await editMessage(chatId, prog.message_id, `❌ Processing failed: ${err.message}`);
        }
        return;
      }
    }
  }
}

module.exports = { handleWebhook };
