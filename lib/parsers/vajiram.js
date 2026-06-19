/**
 * Vajiram & Ravi 100Q Parser
 * Exact port of the browser-side "Production-Grade Document Compiler Engine"
 * from the HTML tool. Uses deterministic spatial two-column parsing framework.
 *
 * Input : testBuffer (PDF), solBuffer (PDF)
 * Output: { text, questionCount, answersMatched, error? }
 */

'use strict';

const pdfParse = require('pdf-parse');

// ─── PDF extraction with spatial data ────────────────────────────────────────
async function extractPagesWithSpatial(buffer) {
  const pages = [];
  let pageNum = 0;

  await pdfParse(buffer, {
    pagerender: function(pageData) {
      pageNum++;
      const items = [];
      let pageWidth = 595; // default A4

      return pageData.getTextContent({ normalizeWhitespace: false })
        .then(tc => {
          const vp = pageData.getViewport({ scale: 1 });
          pageWidth = vp.width || 595;
          tc.items.forEach(item => {
            if (item.str && item.str.trim()) {
              items.push({
                text: item.str,
                x: Math.round(item.transform[4]),
                y: Math.round(vp.height - item.transform[5]),
                pageWidth
              });
            }
          });
          pages.push({ items, pageWidth, num: pageNum });
          return '';
        });
    }
  });
  return pages;
}

// Fallback: use pdfParse plain text per page
async function extractFallback(buffer) {
  const data = await pdfParse(buffer);
  // Split by form-feed if multi-page
  const pageTexts = data.text.split('\f');
  return pageTexts.map((t, i) => ({
    items: t.split('\n').filter(l => l.trim()).map((l, idx) => ({
      text: l.trim(), x: 0, y: idx * 12, pageWidth: 595
    })),
    pageWidth: 595,
    num: i + 1
  }));
}

// ─── Spatial line grouping ────────────────────────────────────────────────────
function consolidateSpatialTokensIntoTextLines(items, yTol = 4) {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].y - cur[0].y) <= yTol) cur.push(sorted[i]);
    else { rows.push(cur); cur = [sorted[i]]; }
  }
  rows.push(cur);
  return rows.map(r => {
    const sorted2 = r.sort((a, b) => a.x - b.x);
    return {
      text: sorted2.map(i => i.text).join(' ').replace(/\s{2,}/g, ' ').trim(),
      y: r[0].y,
      x: r[0].x
    };
  }).filter(l => l.text.length > 0);
}

// ─── Noise filter ─────────────────────────────────────────────────────────────
function isNoise(t) {
  const s = t.trim();
  if (!s) return true;
  const noisePatterns = [
    /^vajiram\s*(&|and)\s*ravi/i, /^www\.vajiramandravi/i, /^copyright/i,
    /^\d{1,3}\s*$/, /^[A-Z]\s*$/, /^page\s+\d+/i,
    /^vajiram/i, /vajiramandravi\.com/i,
    /^for\s+classroom/i, /^target\s+20\d\d/i,
  ];
  return noisePatterns.some(p => p.test(s));
}

// ─── Test booklet parser (state machine Q parser) ─────────────────────────────
function parseTestBookletText(textStream) {
  const questionsMap = {};
  const streamLines = textStream.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  let activeQId = null;
  let bodyLines = [];
  let optLines = [];
  let inOptions = false;

  function flush() {
    if (activeQId === null) return;
    if (optLines.length >= 2) {
      if (!questionsMap[activeQId] || questionsMap[activeQId].options.length < optLines.length) {
        questionsMap[activeQId] = { id: activeQId, bodyLines: [...bodyLines], options: [...optLines] };
      }
    }
    activeQId = null; bodyLines = []; optLines = []; inOptions = false;
  }

  for (const line of streamLines) {
    const optMatch = line.match(/^\s*\(([a-d])\)\s+(.+)$/i);
    if (optMatch && activeQId !== null) {
      inOptions = true;
      optLines.push({ letter: optMatch[1].toLowerCase(), text: optMatch[2].trim() });
      continue;
    }

    const qMatch = line.match(/^\s*(\d{1,3})\.\s{1,6}(.+)$/);
    if (qMatch) {
      const num = parseInt(qMatch[1], 10);
      if (num >= 1 && num <= 100) {
        const isInternalStatement = (
          activeQId !== null && !inOptions &&
          num !== activeQId + 1 && num <= 6
        );
        if (!isInternalStatement || activeQId === null) {
          flush();
          activeQId = num;
          bodyLines = [qMatch[2].trim()];
          optLines = [];
          inOptions = false;
          continue;
        }
      }
    }

    if (inOptions && optLines.length > 0 && activeQId !== null) {
      if (!line.match(/^\s*\(([a-d])\)/i)) {
        optLines[optLines.length - 1].text += ' ' + line;
      }
      continue;
    }

    if (activeQId !== null && !inOptions) bodyLines.push(line);
  }
  flush();
  return questionsMap;
}

// ─── Answer key + explanations from solution PDF ──────────────────────────────
function parseSolutionText(textStream) {
  const answersMatrix = {};
  const explanationsMap = {};

  // Extract answer key: pattern "1. (a)" or "1.(a)"
  const keyRe = /\b(\d{1,3})\.\s*\(([a-d])\)/gi;
  let m;
  while ((m = keyRe.exec(textStream)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 100) answersMatrix[n] = m[2].toLowerCase();
  }

  // Extract explanations: split by "Q<num>." markers
  const blockRe = /\nQ(\d{1,3})\.\s*\n/g;
  const blocks = [];
  while ((m = blockRe.exec(textStream)) !== null) {
    blocks.push({ qNum: parseInt(m[1], 10), start: m.index + m[0].length });
  }
  for (let i = 0; i < blocks.length; i++) {
    const { qNum, start } = blocks[i];
    const end = i + 1 < blocks.length ? blocks[i + 1].start : textStream.length;
    const raw = textStream.slice(start, end);
    explanationsMap[qNum] = cleanExplanation(raw);
  }

  return { answersMatrix, explanationsMap };
}

function cleanExplanation(raw) {
  let t = raw;
  t = t.replace(/^Answer\s*:\s*[a-d]\s*$/gmi, '');
  t = t.replace(/^Explanation\s*:\s*$/gmi, '');
  t = t.replace(/Therefore[,\s]+option\s*\([a-d]\)\s*is\s*the\s*correct\s*answer\.?[^\n]*/gi, '');
  t = t.replace(/So[,\s]+option\s*\([a-d]\)\s*is\s*the\s*correct\s*answer\.?[^\n]*/gi, '');
  t = t.replace(/Therefore[,\s]+the\s*correct\s*answer[^\n]*/gi, '');
  t = t.replace(/Relevance\s*:[^\n]*/gi, '');
  t = t.replace(/^(?:Source|Ref|Reference)\s*:[^\n]*/gmi, '');
  t = t.replace(/^[\s]*[●○•▪◆▸▹→\-–—]+\s*/gm, '');
  t = t.replace(/^Q\d{1,3}\.\s*/gm, '');
  const lines = t.split('\n').map(l => l.trim()).filter(l => l.length > 2);
  return lines.join(' ').replace(/\s{2,}/g, ' ').replace(/\.\s*\./g, '.').trim();
}

// ─── Normalize roman numerals ─────────────────────────────────────────────────
function normalizeRoman(line) {
  return line.replace(
    /^\s*(I{1,3}|IV|V?I{0,3}|IX|XI{0,3})\.\s+/,
    (match, r) => {
      const map = { I:1, II:2, III:3, IV:4, V:5, VI:6, VII:7, VIII:8, IX:9, X:10, XI:11, XII:12 };
      const n = map[r.toUpperCase()];
      return n ? n + '. ' : match;
    }
  );
}

function smartJoinBodyLines(rawLines) {
  const normalized = rawLines.map(l => normalizeRoman(l.trim())).filter(l => l.length > 0);
  if (!normalized.length) return [];
  const NEW_LINE_RE = [
    /^\d{1,2}\.\s+\S/,
    /^Statement\s+[IVXLC]+\s*:/i,
    /^(Which|How\s+many|How\s+|What|Select|Arrange|In\s+how|Who\s+|Where\s+|Among\s+|Identify|Of\s+the|With\s+reference|With\s+regard|Consider|Regarding|As\s+per|According\s+to|In\s+which\s+of\s+the\s+above)/i
  ];
  const out = [];
  let buf = '';
  for (let i = 0; i < normalized.length; i++) {
    const line = normalized[i];
    const newLine = i === 0 || NEW_LINE_RE.some(r => r.test(line));
    if (newLine) {
      if (buf) out.push(buf.replace(/\s{2,}/g, ' ').trim());
      buf = line;
    } else {
      buf = (buf + ' ' + line).replace(/\s{2,}/g, ' ');
    }
  }
  if (buf) out.push(buf.replace(/\s{2,}/g, ' ').trim());
  return out;
}

function unpackOptions(rawOptions) {
  const unified = rawOptions.map(o => `(${o.letter}) ${o.text}`).join(' ');
  const get = (pat) => {
    const m = unified.match(pat);
    return m ? m[1].replace(/^\s*\(?[a-d]\)?\s*\.?\s*/i, '').trim() : '';
  };
  return [
    { letter: 'a', text: get(/\(a\)\s*([\s\S]*?)(?=\s*\(b\)|$)/i) || 'Only one' },
    { letter: 'b', text: get(/\(b\)\s*([\s\S]*?)(?=\s*\(c\)|$)/i) || 'Only two' },
    { letter: 'c', text: get(/\(c\)\s*([\s\S]*?)(?=\s*\(d\)|$)/i) || 'Only three' },
    { letter: 'd', text: get(/\(d\)\s*([\s\S]*?)$/i) || 'All four' },
  ];
}

// ─── Main export ──────────────────────────────────────────────────────────────
async function parseVajiram(testBuffer, solBuffer) {
  try {
    // Extract test PDF text
    const testData = await pdfParse(testBuffer);
    const testText = testData.text;

    // Extract solution PDF text
    const solData = await pdfParse(solBuffer);
    const solText = solData.text;

    // Parse questions from test
    const questionsMap = parseTestBookletText(testText);
    const qKeys = Object.keys(questionsMap).map(Number).sort((a, b) => a - b);

    if (qKeys.length === 0) {
      return { text: '', questionCount: 0, answersMatched: 0,
        error: 'No questions found in Test PDF. Make sure it is a text-based (not scanned) PDF.' };
    }

    // Parse answers + explanations from solution
    const { answersMatrix, explanationsMap } = parseSolutionText(solText);
    const answersCount = Object.keys(answersMatrix).length;

    // Assemble output
    const lines = [];
    let matched = 0;
    for (const k of qKeys) {
      const q = questionsMap[k];
      const ansLetter = answersMatrix[k];
      const expl = explanationsMap[k] || '';
      if (ansLetter) matched++;

      const bodyParts = smartJoinBodyLines(q.bodyLines);
      lines.push(`Q${k}. ${bodyParts[0] || ''}`);
      for (let i = 1; i < bodyParts.length; i++) lines.push(bodyParts[i]);
      lines.push('😂');

      const opts = unpackOptions(q.options);
      for (const opt of opts) {
        const mark = (ansLetter && opt.letter === ansLetter) ? ' ✅' : '';
        lines.push(opt.text + mark);
      }
      lines.push(`Ex: ${expl || '[Explanation not found]'}`);
      lines.push('');
    }

    return {
      text: lines.join('\n'),
      questionCount: qKeys.length,
      answersMatched: matched,
    };

  } catch (err) {
    console.error('parseVajiram error:', err);
    return { text: '', questionCount: 0, answersMatched: 0, error: err.message };
  }
}

module.exports = { parseVajiram };
