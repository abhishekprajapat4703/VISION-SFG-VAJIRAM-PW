/**
 * TXT File Fixer
 * Adds 😂 emoji between question body and options in existing .txt files
 * where it's missing. Matches the ForumIAS .txt format.
 *
 * Ported from the HTML bot's TXT fixer feature.
 *
 * Input : text string (content of .txt file)
 * Output: { text, questionsFixed, total, error? }
 */

'use strict';

/**
 * Detects if a line is a question start.
 * Matches: Q1. / Q.1. / Q1) etc.
 */
function isQStart(line) {
  return /^Q\.?\s*\d+[.)]/i.test(line.trim());
}

/**
 * Detects if a line is an option line (plain text option without (a) prefix).
 * In the expected format, options are bare text lines (not prefixed with a./b.)
 * after the 😂 separator.
 * We detect "option-like" lines by checking if they're short and
 * appear after a question body.
 */
function isOptionLike(line) {
  const t = line.trim();
  if (!t) return false;
  // Option lines are typically short (under 120 chars) and don't start with Q/Ex:
  if (/^Q\.?\s*\d+/i.test(t)) return false;
  if (/^Ex:/i.test(t)) return false;
  if (t === '😂') return false;
  return true;
}

/**
 * Main fixer function.
 * Logic:
 * 1. Split by Q\d. markers to get question blocks
 * 2. For each block, check if 😂 is present
 * 3. If missing, detect where body ends and options start, insert 😂
 * 4. Reassemble
 */
function fixTxtFile(text) {
  try {
    if (!text || !text.trim()) return { text: '', questionsFixed: 0, total: 0, error: 'Empty file' };

    const lines = text.split('\n');
    const output = [];
    let questionsFixed = 0;
    let total = 0;

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (isQStart(line)) {
        total++;
        // Collect this question block
        const block = [line];
        i++;
        while (i < lines.length && !isQStart(lines[i])) {
          block.push(lines[i]);
          i++;
        }

        // Check if 😂 already present
        const hasEmoji = block.some(l => l.trim() === '😂');

        if (!hasEmoji) {
          // Need to insert 😂.
          // Heuristic: 😂 should go before the first option-like line
          // that appears after the question stem/body.
          // We look for where body ends:
          // - Body: question text, numbered statements, directive line
          // - Then: options (4 short lines), then Ex:
          // Strategy: find "Ex:" and back-trace 4-5 lines for options
          const exIdx = block.findIndex(l => /^Ex:/i.test(l.trim()));
          if (exIdx > 0) {
            // The 4 options are just before Ex:
            const optCount = Math.min(4, exIdx);
            const insertAt = exIdx - optCount;
            block.splice(insertAt, 0, '😂');
            questionsFixed++;
          } else {
            // No Ex: line — try to insert after last "body" line
            // Body line = not a short answer-like line
            let lastBodyIdx = 0;
            for (let j = 1; j < block.length; j++) {
              const t = block[j].trim();
              if (!t) continue;
              // If line is under 80 chars and looks like an answer option
              // (no sub-numbering, no question text patterns), it's an option
              if (t.length < 80 && !/^\d+\./.test(t) && !/^(Which|How|Select|Consider|In which|With reference)/i.test(t)) {
                lastBodyIdx = j - 1;
                break;
              }
            }
            block.splice(Math.max(1, lastBodyIdx + 1), 0, '😂');
            questionsFixed++;
          }
        }

        output.push(...block);
      } else {
        output.push(line);
        i++;
      }
    }

    return { text: output.join('\n'), questionsFixed, total };
  } catch (err) {
    console.error('fixTxtFile error:', err);
    return { text: '', questionsFixed: 0, total: 0, error: err.message };
  }
}

module.exports = { fixTxtFile };
