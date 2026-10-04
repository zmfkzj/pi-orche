function fail(code) {
  throw Object.assign(new Error(code), { code });
}

/**
 * Four parser states make quote boundaries explicit:
 * - start: opening quote is legal and empty separators are significant;
 * - plain: all bytes except structural delimiters are literal;
 * - quoted: newlines are data and doubled quotes decode in place;
 * - closed: only field/record separators or EOF may follow.
 *
 * Field and record flushing are separate so a trailing delimiter retains an
 * empty field without creating a phantom record after a trailing newline.
 * CRLF consumption happens only outside quotes. Inside quotes each byte is
 * appended independently, preserving CRLF, LF and lone CR exactly.
 * A leading BOM is a transport marker, not a field byte. Interior BOMs remain.
 * Record widths are intentionally not enforced here: tabular schemas live in
 * separate metadata modules and do not constrain this low-level parser.
 * Parsing is synchronous and has no ambient locale or stream state.
 */
export function parseCsv(input, { delimiter = ',' } = {}) {
  if (typeof input !== 'string') fail('CSV_INPUT');
  if (typeof delimiter !== 'string' || delimiter.length !== 1 ||
      /["\r\n]/.test(delimiter)) fail('CSV_DELIMITER');
  const text = input.startsWith('\uFEFF') ? input.slice(1) : input;
  if (!text.length) return [];
  const records = [];
  let row = [];
  let field = '';
  let mode = 'start';
  let ended = false;
  const endField = () => {
    row.push(field);
    field = '';
    mode = 'start';
  };
  const endRow = () => {
    endField();
    records.push(row);
    row = [];
    ended = true;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    ended = false;
    if (mode === 'quoted') {
      if (ch !== '"') {
        field += ch;
      } else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        mode = 'closed';
      }
      continue;
    }
    if (ch === delimiter) {
      endField();
      continue;
    }
    if (ch === '\n') {
      endRow();
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] !== '\n') fail('CSV_NEWLINE');
      i++;
      endRow();
      continue;
    }
    if (mode === 'closed') fail('CSV_QUOTE');
    if (ch === '"') {
      if (mode !== 'start') fail('CSV_QUOTE');
      mode = 'quoted';
      continue;
    }
    field += ch;
    mode = 'plain';
  }
  if (mode === 'quoted') fail('CSV_QUOTE');
  if (!ended) endRow();
  return records;
}
