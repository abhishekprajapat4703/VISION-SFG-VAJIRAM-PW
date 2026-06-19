/**
 * ForumIAS SFG 50Q Parser
 * Exact port of the browser-side parser from the HTML tool.
 *
 * Input : PDF buffer
 * Output: { text: string, questionCount: number, error?: string }
 *
 * Output Format:
 *   Q1. Question text
 *   Statement 1
 *   Statement 2
 *   Which of the above?
 *   😂
 *   Option A ✅
 *   Option B
 *   Ex: Explanation...
 *
 *   Q2. ...
 */

'use strict';

const pdfParse = require('pdf-parse');

// ─── PDF Text Extraction ─────────────────────────────────────────────────────
async function extractText(buffer) {
  const data = await pdfParse(buffer, { normalizeWhitespace: false });
  return data.text;
}

// ─── Noise line filter (same as HTML cleanLines) ────────────────────────────
function cleanLines(rawText) {
  const lines = rawText.split('\n');
  const cleaned = [];
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    if (/^Forum Learning Centre/i.test(line)) continue;
    if (/^9311\d{6}/.test(line)) continue;
    if (/^\d{10}\s*,\s*\d{10}/.test(line)) continue;
    if (/^\[\d+\]$/.test(line)) continue;
    if (/^SFG 20\d\d\s*\|\s*Level/i.test(line)) continue;
    if (/^https?:\/\//i.test(line) && line.length < 120) continue;
    if (/^admissions@forumias/i.test(line)) continue;
    if (/^helpdesk@forumias/i.test(line)) continue;
    if (/^\d{4,5}\s*,\s*\d{4,5}/.test(line)) continue;
    cleaned.push(line);
  }
  return cleaned;
}

// ─── Helpers (same as HTML) ──────────────────────────────────────────────────
const ROMAN_MAP = { I:'1',II:'2',III:'3',IV:'4',V:'5',VI:'6',VII:'7',VIII:'8',IX:'9',X:'10' };
function romanDigit(r) { return ROMAN_MAP[r.toUpperCase()] || r; }

function isQuestionStart(l) { return /^Q\.?\s*\d+\s*[)\.]/i.test(l); }
function getQNum(l)         { const m = l.match(/^Q\.?\s*(\d+)\s*[)\.]/i); return m ? parseInt(m[1]) : null; }
function stripQPrefix(l)    { return l.replace(/^Q\.?\s*\d+\s*[)\.]?\s*/i, '').trim(); }
function isOption(l)        { return /^[a-d]\s*[)\.]?\s*.{1,}/i.test(l); }
function cleanOpt(l)        { return l.replace(/^[a-d]\s*[)\.]?\s*/i, '').trim(); }

function classifyBodyLine(l) {
  const roman = l.match(/^(I{1,3}|IV|V|VI{1,3}|IX|X)\s*[\.)?\-]\s*(.*)/i);
  if (roman) return { type: 'roman', num: romanDigit(roman[1]), rest: roman[2].trim() };
  const stmtRoman = l.match(/^Statement\s+(I{1,3}|IV|V|VI{1,3}|IX|X)\s*[:\.]?\s*(.*)/i);
  if (stmtRoman) return { type: 'statementWord', num: romanDigit(stmtRoman[1]), rest: stmtRoman[2].trim() };
  const stmtArabic = l.match(/^Statement\s+(\d+)\s*[:\.]?\s*(.*)/i);
  if (stmtArabic) return { type: 'statementWord', num: stmtArabic[1], rest: stmtArabic[2].trim() };
  const arabic = l.match(/^(\d+)\s*[\.)?\-]\s+(.*)/);
  if (arabic) return { type: 'arabic', num: arabic[1], rest: arabic[2].trim() };
  if (/^(Which\b|How many\b|Select\b|In how many\b|Who\b|What\b|When\b|Where\b|Name\b|Identify\b|Arrange\b|Among\b|Of the above|From the above|Based on\b|In the above|The above)/i.test(l))
    return { type: 'directive', rest: l };
  return null;
}

function isTableDataRow(l) {
  return /\s{3,}/.test(l) && (/^(I{1,3}|IV|V|VI{1,3}|IX|X)\s*[\.)?\-]/i.test(l) || /^\d+\s*[\.)?\-]/.test(l));
}
function isTableHeaderRow(l) {
  return /\s{4,}/.test(l) && !isOption(l) && !isTableDataRow(l) &&
    !/^(Ans|Exp|Source|Subject|Topic|Subtopic)\s*[)\.]?/i.test(l) && /^[A-Z]/.test(l);
}

function tableToItems(tableLines) {
  const result = [];
  let rowNum = 0;
  for (const l of tableLines) {
    if (isTableHeaderRow(l)) continue;
    const romanRow = l.match(/^(I{1,3}|IV|V|VI{1,3}|IX|X)\s*[\.)?\-]\s*(.*)/i);
    const digitRow = l.match(/^(\d+)\s*[\.)?\-]\s*(.*)/);
    if (romanRow || digitRow) {
      rowNum++;
      const rest = (romanRow ? romanRow[2] : digitRow[2]).trim();
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
  let inTable = false;
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
    if (/^Exp\s*[)\.]?/i.test(block[j])) { expIdx = j; break; }
  }
  if (expIdx === -1) return '';
  const parts = [];
  for (let j = expIdx; j < block.length; j++) {
    const l = block[j].trim();
    if (/^(Source|Subject|Topic|Subtopic)\s*[)\.:]/i.test(l)) break;
    if (j === expIdx) {
      const cleaned = l.replace(/^Exp\s*[)\.]?\s*/i, '').trim();
      if (cleaned) parts.push(cleaned);
    } else {
      parts.push(l);
    }
  }
  return 'Ex: ' + parts.join(' ').replace(/\s{2,}/g, ' ').trim();
}

function parseAndFormat(rawText) {
  const lines  = cleanLines(rawText);
  const output = [];
  let i        = 0;
  let qNumber  = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!isQuestionStart(line)) { i++; continue; }

    const qNum   = getQNum(line);
    const qFirst = stripQPrefix(line);
    qNumber      = qNum;

    // Collect body lines until we hit options
    const bodyLines = [];
    const optLines  = [];
    let j = i + 1;

    // Gather body (non-option lines)
    while (j < lines.length) {
      const l = lines[j];
      if (isQuestionStart(l)) break;
      if (isOption(l)) break;
      bodyLines.push(l);
      j++;
    }

    // Gather option lines
    const optStart = j;
    while (j < lines.length) {
      const l = lines[j];
      if (isQuestionStart(l)) break;
      if (/^(Ans|Exp|Source|Subject|Topic)\s*[)\.]?/i.test(l)) break;
      if (isOption(l)) { optLines.push(l); j++; continue; }
      if (optLines.length > 0) { optLines[optLines.length - 1] += ' ' + l; j++; continue; }
      j++;
    }

    // Gather ans+exp block
    const metaLines = [];
    while (j < lines.length && !isQuestionStart(lines[j])) {
      metaLines.push(lines[j]); j++;
    }

    // Find correct answer
    let ansLetter = null;
    for (const ml of metaLines) {
      const m = ml.match(/^Ans\s*[)\.]?\s*([a-d])\b/i);
      if (m) { ansLetter = m[1].toLowerCase(); break; }
    }

    // Build body
    const bodyParts = buildQuestionBody(qFirst, bodyLines);
    // Build explanation
    const expText = extractExplanation(metaLines);

    // Format output
    if (bodyParts.length > 0) {
      output.push(`Q${qNum}. ${bodyParts[0]}`);
      for (let k = 1; k < bodyParts.length; k++) output.push(bodyParts[k]);
    } else {
      output.push(`Q${qNum}. `);
    }
    output.push('😂');

    // Options
    const cleanedOpts = optLines.map(o => cleanOpt(o));
    const letters = ['a', 'b', 'c', 'd'];
    optLines.forEach((raw, idx) => {
      const letter = letters[idx] || String.fromCharCode(97 + idx);
      const text   = cleanOpt(raw);
      const mark   = (ansLetter && letter === ansLetter) ? ' ✅' : '';
      output.push(text + mark);
    });

    // Explanation
    if (expText) output.push(expText);
    output.push('');

    i = j;
  }

  return output.join('\n');
}

function countQuestions(text) {
  return (text.match(/^Q\d+\./gm) || []).length;
}

// ─── Main export ─────────────────────────────────────────────────────────────
async function parseSFG(pdfBuffer) {
  try {
    const rawText = await extractText(pdfBuffer);
    const formatted = parseAndFormat(rawText);
    const questionCount = countQuestions(formatted);
    return { text: formatted, questionCount };
  } catch (err) {
    console.error('parseSFG error:', err);
    return { text: '', questionCount: 0, error: err.message };
  }
}

module.exports = { parseSFG };
