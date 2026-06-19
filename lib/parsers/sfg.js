/**
 * ForumIAS SFG 50Q Parser — v2
 * Uses pdf-parse plain text (no spatial data needed).
 * Exact logic port from the HTML tool.
 */

'use strict';

// Vercel-safe pdf-parse import
let pdfParse;
try { pdfParse = require('pdf-parse/lib/pdf-parse.js'); }
catch(e) { pdfParse = require('pdf-parse'); }

async function extractText(buffer) {
  const data = await pdfParse(buffer);
  if (!data.text || !data.text.trim())
    throw new Error('No text found in PDF. It may be a scanned image — this converter requires a text-based PDF.');
  return data.text;
}

// ─── Noise removal ────────────────────────────────────────────────────────────
function cleanLines(rawText) {
  return rawText.split('\n').map(l => l.trim()).filter(l => {
    if (!l) return false;
    if (/^Forum Learning Centre/i.test(l)) return false;
    if (/^9311\d{6}/.test(l)) return false;
    if (/^\d{10}\s*,\s*\d{10}/.test(l)) return false;
    if (/^\[\d+\]$/.test(l)) return false;
    if (/^SFG 20\d\d\s*\|\s*Level/i.test(l)) return false;
    if (/^https?:\/\//i.test(l) && l.length < 120) return false;
    if (/^admissions@forumias/i.test(l)) return false;
    if (/^helpdesk@forumias/i.test(l)) return false;
    if (/^\d{4,5}\s*,\s*\d{4,5}/.test(l)) return false;
    if (/^ForumIAS/i.test(l)) return false;
    if (/^All\s+Rights\s+Reserved/i.test(l)) return false;
    return true;
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const ROMAN_MAP = { I:1,II:2,III:3,IV:4,V:5,VI:6,VII:7,VIII:8,IX:9,X:10,XI:11,XII:12 };
function romanToNum(r) { return ROMAN_MAP[r.toUpperCase()]; }

function isQStart(l)   { return /^Q\.?\s*\d+\s*[).]/i.test(l); }
function getQNum(l)    { const m = l.match(/^Q\.?\s*(\d+)\s*[).]/i); return m ? parseInt(m[1]) : null; }
function stripQPfx(l)  { return l.replace(/^Q\.?\s*\d+\s*[).]\s*/i, '').trim(); }
function isOpt(l)      { return /^\(?[a-d]\)?\s+\S/i.test(l); }
function cleanOpt(l)   { return l.replace(/^\(?[a-d]\)?\s+/i, '').trim(); }
function getOptLetter(l) { const m = l.match(/^\(?([a-d])\)?/i); return m ? m[1].toLowerCase() : null; }

function normalizeRoman(l) {
  return l.replace(/^(I{1,3}|IV|V?I{0,3}|IX|XI{0,3})[.)\-]\s+/i, (match, r) => {
    const n = romanToNum(r); return n ? n + '. ' : match;
  });
}

function buildBody(firstLine, bodyLines) {
  const parts = [];
  const addedStmt = [];
  parts.push(firstLine.trim());

  for (let line of bodyLines) {
    line = normalizeRoman(line.trim());
    if (!line) continue;
    // Numbered statements: "1. text" or "Statement I:"
    const stmtRoman = line.match(/^Statement\s+(I{1,3}|IV|V?I{0,3}|IX|X)\s*[:.]\s*(.*)/i);
    if (stmtRoman) { const n = romanToNum(stmtRoman[1]); parts.push((n||'?') + '. ' + stmtRoman[2].trim()); continue; }
    const numDot = line.match(/^(\d{1,2})\.\s+(.+)/);
    if (numDot) { parts.push(line); continue; }
    const romanDot = line.match(/^(I{1,3}|IV|V?I{0,3}|IX|X)\.\s+/i);
    if (romanDot) { parts.push(line); continue; }
    // Directive line (question stem)
    if (/^(Which|How many|Select|In how many|Arrange|Of the above|From the above|Based on|Consider)/i.test(line)) {
      parts.push(line); continue;
    }
    // Continuation — append to last part
    if (parts.length) parts[parts.length - 1] += ' ' + line;
    else parts.push(line);
  }
  return parts.map(p => p.replace(/\s{2,}/g, ' ').trim()).filter(Boolean);
}

function extractExplanation(metaLines) {
  const expIdx = metaLines.findIndex(l => /^Exp\s*[).]\s*/i.test(l));
  if (expIdx === -1) return '';
  const parts = [];
  for (let j = expIdx; j < metaLines.length; j++) {
    const l = metaLines[j].trim();
    if (/^(Source|Subject|Topic|Subtopic)\s*[):.\-]/i.test(l)) break;
    parts.push(j === expIdx ? l.replace(/^Exp\s*[).]\s*/i, '').trim() : l);
  }
  const text = parts.join(' ').replace(/\s{2,}/g, ' ').trim();
  return text ? 'Ex: ' + text : '';
}

function parseAndFormat(rawText) {
  const lines  = cleanLines(rawText);
  const output = [];
  let answersFound = 0, noAns = 0, questionCount = 0;
  let i = 0;

  while (i < lines.length) {
    if (!isQStart(lines[i])) { i++; continue; }

    const qNum    = getQNum(lines[i]);
    const qFirst  = stripQPfx(lines[i]);
    questionCount++;

    // Collect body until options
    const bodyLines = [];
    let j = i + 1;
    while (j < lines.length && !isQStart(lines[j]) && !isOpt(lines[j])) {
      bodyLines.push(lines[j]); j++;
    }

    // Collect options
    const optLines = [];
    while (j < lines.length && !isQStart(lines[j])) {
      const l = lines[j];
      if (/^(Ans|Exp|Source|Subject|Topic)\s*[).]/i.test(l)) break;
      if (isOpt(l)) { optLines.push(l); j++; continue; }
      if (optLines.length > 0) { optLines[optLines.length - 1] += ' ' + l; j++; continue; }
      j++;
    }

    // Collect meta (Ans + Exp)
    const metaLines = [];
    while (j < lines.length && !isQStart(lines[j])) { metaLines.push(lines[j]); j++; }

    // Find answer
    let ansLetter = null;
    for (const ml of metaLines) {
      const m = ml.match(/^Ans\s*[).]\s*\(?([a-d])\)?/i);
      if (m) { ansLetter = m[1].toLowerCase(); break; }
    }
    if (ansLetter) answersFound++; else noAns++;

    const body  = buildBody(qFirst, bodyLines);
    const expTx = extractExplanation(metaLines);

    output.push(`Q${qNum}. ${body[0] || ''}`);
    for (let k = 1; k < body.length; k++) output.push(body[k]);
    output.push('😂');

    const letters = ['a','b','c','d'];
    optLines.forEach((raw, idx) => {
      const letter = letters[idx] || getOptLetter(raw) || String.fromCharCode(97+idx);
      const text   = cleanOpt(raw);
      const mark   = ansLetter && letter === ansLetter ? ' ✅' : '';
      output.push(text + mark);
    });

    if (expTx) output.push(expTx);
    output.push('');
    i = j;
  }

  return { text: output.join('\n'), questionCount, answersFound, noAns };
}

async function parseSFG(buffer) {
  try {
    const raw    = await extractText(buffer);
    const result = parseAndFormat(raw);
    return result;
  } catch (err) {
    return { text: '', questionCount: 0, answersFound: 0, noAns: 0, error: err.message };
  }
}

module.exports = { parseSFG };
