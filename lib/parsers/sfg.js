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
  let i        = 0;
  let qNumber  = 0;

  const ROMAN_MAP = { I:'1',II:'2',III:'3',IV:'4',V:'5',VI:'6',VII:'7',VIII:'8',IX:'9',X:'10' };
  function romanDigit(r) { return ROMAN_MAP[r.toUpperCase()] || r; }

  function isQuestionStart(l) { return /^Q\.?\s*\d+\s*[)\.]/i.test(l); }
  function getQNum(l)         { const m = l.match(/^Q\.?\s*(\d+)\s*[)\.]/i); return m ? parseInt(m[1]) : null; }
  function stripQPrefix(l)    { return l.replace(/^Q\.?\s*\d+\s*[)\.]\s*/i, '').trim(); }
  function isOption(l)        { return /^[a-d]\s*[)\.]\s*.{1,}/i.test(l); }
  function cleanOpt(l)        { return l.replace(/^[a-d]\s*[)\.]\s*/i, '').trim(); }

  function classifyBodyLine(l) {
    const roman = l.match(/^(I{1,3}|IV|V|VI{1,3}|IX|X)\s*[\.)\-]\s*(.*)/i);
    if (roman) return { type:'roman', num: romanDigit(roman[1]), rest: roman[2].trim() };
    const stmtRoman = l.match(/^Statement\s+(I{1,3}|IV|V|VI{1,3}|IX|X)\s*[:\.]\s*(.*)/i);
    if (stmtRoman) return { type:'statementWord', num: romanDigit(stmtRoman[1]), rest: stmtRoman[2].trim() };
    const stmtArabic = l.match(/^Statement\s+(\d+)\s*[:\.]\s*(.*)/i);
    if (stmtArabic) return { type:'statementWord', num: stmtArabic[1], rest: stmtArabic[2].trim() };
    const arabic = l.match(/^(\d+)\s*[\.)\-]\s+(.*)/);
    if (arabic) return { type:'arabic', num: arabic[1], rest: arabic[2].trim() };
    if (/^(Which\b|How many\b|Select\b|In how many\b|Who\b|What\b|When\b|Where\b|Name\b|Identify\b|Arrange\b|Among\b|Of the above|From the above|Based on\b|In the above|The above)/i.test(l))
      return { type:'directive', rest: l };
    return null;
  }

  function isTableDataRow(l) {
    return /\s{3,}/.test(l) &&
           (/^(I{1,3}|IV|V|VI{1,3}|IX|X)\s*[\.)\-]/i.test(l) || /^\d+\s*[\.)\-]/.test(l));
  }
  function isTableHeaderRow(l) {
    return /\s{4,}/.test(l) &&
           !isOption(l) &&
           !isTableDataRow(l) &&
           !/^(Ans|Exp|Source|Subject|Topic|Subtopic)\s*[)\.]/i.test(l) &&
           /^[A-Z]/.test(l);
  }

  function tableToItems(tableLines) {
    const result = [];
    let rowNum = 0;
    for (const l of tableLines) {
      if (isTableHeaderRow(l)) continue;
      const romanRow = l.match(/^(I{1,3}|IV|V|VI{1,3}|IX|X)\s*[\.)\-]\s*(.*)/i);
      const digitRow = l.match(/^(\d+)\s*[\.)\-]\s*(.*)/);
      if (romanRow || digitRow) {
        rowNum++;
        const rest  = (romanRow ? romanRow[2] : digitRow[2]).trim();
        const parts = rest.split(/\s{3,}/).map(p => p.trim()).filter(Boolean);
        result.push(rowNum + '. ' + parts.join(' — '));
      } else if (rowNum > 0 && result.length) {
        const parts = l.split(/\s{3,}/).map(p => p.trim()).filter(Boolean);
        result[result.length - 1] += ' ' + parts.join(' ');
      }
    }
    return result;
  }

  function buildQuestionBody(firstStemLine, bodyLines) {
    const items = [{ text: firstStemLine, kind: 'stem' }];
    let stmtCounter = 0;
    let inTable     = false;
    const tableBuffer = [];

    const flushTable = () => {
      if (!tableBuffer.length) return;
      tableToItems(tableBuffer).forEach(t => items.push({ text: t, kind: 'statement' }));
      tableBuffer.length = 0;
      inTable = false;
    };

    for (const l of bodyLines) {
      if (!l) continue;
      if (isTableHeaderRow(l)) { flushTable(); inTable = true; tableBuffer.push(l); continue; }
      if (inTable && isTableDataRow(l)) { tableBuffer.push(l); continue; }
      if (inTable) {
        if (/\s{3,}/.test(l) && !/^(Ans|Exp|Source|Subject|Topic)/i.test(l)) { tableBuffer.push(l); continue; }
        flushTable();
      }
      const cls = classifyBodyLine(l);
      if (cls && cls.type === 'roman') { stmtCounter++; items.push({ text: stmtCounter + '. ' + cls.rest, kind: 'statement' }); continue; }
      if (cls && cls.type === 'statementWord') { stmtCounter++; items.push({ text: stmtCounter + '. ' + cls.rest, kind: 'statement' }); continue; }
      if (cls && cls.type === 'arabic') { items.push({ text: cls.num + '. ' + cls.rest, kind: 'statement' }); continue; }
      if (cls && cls.type === 'directive') { items.push({ text: cls.rest, kind: 'directive' }); continue; }
      if (items.length > 0) { items[items.length - 1].text += ' ' + l; }
      else { items.push({ text: l, kind: 'stem' }); }
    }
    flushTable();
    return items.map(it => it.text.trim()).filter(Boolean);
  }

  function extractExplanation(block) {
    let expIdx = -1;
    for (let j = 0; j < block.length; j++) {
      if (/^Exp\s*[)\.]/i.test(block[j])) { expIdx = j; break; }
    }
    if (expIdx === -1) return '';
    const parts = [];
    for (let j = expIdx; j < block.length; j++) {
      const l = block[j].trim();
      if (/^(Source|Subject|Topic|Subtopic)\s*[)\.:]/.test(l)) break;
      if (/^Source\s*[)\.:]/.test(l)) break;
      if (/^https?:\/\//i.test(l)) continue;
      if (/^Exp\s*[)\.]\s*Option\s+[a-d]\s+is\s+the\s+correct/i.test(l)) {
        const after = l.replace(/^Exp\s*[)\.]\s*Option\s+[a-d]\s+is\s+the\s+correct\s+answer[,\.]?\s*/i, '').trim();
        if (after) parts.push(after);
        continue;
      }
      if (j === expIdx && /^Exp\s*[)\.]/i.test(l)) {
        const after = l.replace(/^Exp\s*[)\.]\s*/i, '').trim();
        if (after) parts.push(after);
        continue;
      }
      const clean = l.replace(/^[●•·▪▸►\*\-]\s+/, '').trim();
      if (clean) parts.push(clean);
    }
    return parts.join(' ').replace(/\s{2,}/g, ' ').replace(/\*\*/g, '').trim();
  }

  let answersFound = 0, noAns = 0, questionCount = 0;

  while (i < lines.length) {
    if (!isQuestionStart(lines[i])) { i++; continue; }
    qNumber++;
    const qNum = getQNum(lines[i]) || qNumber;
    questionCount++;
    const block = [lines[i++]];
    while (i < lines.length && !isQuestionStart(lines[i])) block.push(lines[i++]);

    let optionStart = -1, answerIdx = -1;
    for (let j = 1; j < block.length; j++) {
      if (optionStart === -1 && isOption(block[j])) { optionStart = j; }
      if (/^Ans\s*[)\.]/i.test(block[j]))            { answerIdx  = j; }
    }

    const bodyEnd  = optionStart > -1 ? optionStart : (answerIdx > -1 ? answerIdx : block.length);
    const bodyRaw  = block.slice(1, bodyEnd).map(l => l.trim()).filter(Boolean);
    const qLines   = buildQuestionBody(stripQPrefix(block[0]), bodyRaw);
    const qText    = qLines.join('\n');

    const opts = [];
    if (optionStart > -1) {
      for (let j = optionStart; j < block.length; j++) {
        const ol = block[j].trim();
        if (isOption(ol)) { opts.push(ol); }
        else if (/^Ans\s*[)\.]/i.test(ol) || /^Exp\s*[)\.]/i.test(ol)) { break; }
        else if (opts.length > 0 && ol && !/^(Source|Subject|Topic|Subtopic)/i.test(ol)) { opts[opts.length - 1] += ' ' + ol; }
      }
    }

    let ansLetter = '';
    if (answerIdx > -1) {
      const m = block[answerIdx].match(/^Ans\s*[)\.]\s*([a-d])/i);
      if (m) ansLetter = m[1].toLowerCase();
    }
    const ansIdx = ansLetter ? ansLetter.charCodeAt(0) - 97 : -1;
    if (ansLetter) answersFound++; else noAns++;
    const expText = extractExplanation(block);

    if (!qText && opts.length === 0) continue;
    output.push(`Q${qNum}. ${qText}`);
    output.push('😂');
    opts.forEach((opt, idx) => {
      const txt = cleanOpt(opt.trim());
      output.push(idx === ansIdx ? `${txt} ✅` : txt);
    });
    if (expText) output.push(`Ex: ${expText}`);
    output.push('');
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
