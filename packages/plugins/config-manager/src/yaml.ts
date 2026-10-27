/**
 * Minimal YAML subset parser (zero dependencies).
 *
 * Supports what config files need: block mappings and sequences nested by
 * indentation (including `- key: value` items), plain/quoted scalars, numbers,
 * booleans, null, flow sequences of scalars (`[a, b]`), `{}` and comments.
 * Anchors, multi-line strings, tags and multiple documents are not supported.
 */

interface Line {
  indent: number;
  text: string;
  lineNo: number;
}

export class YamlError extends Error {
  constructor(message: string, lineNo?: number) {
    super(lineNo === undefined ? message : `${message} (line ${lineNo})`);
    this.name = 'YamlError';
  }
}

/**
 * Parse a YAML document into plain JavaScript values
 */
export function parseYaml(content: string): unknown {
  const lines = tokenize(content);
  const first = lines[0];
  if (!first) {
    return {};
  }

  const [value, next] = parseBlock(lines, 0, first.indent);
  assertConsumed(lines, next, -1);
  return value;
}

function tokenize(content: string): Line[] {
  const lines: Line[] = [];
  const rawLines = content.split(/\r?\n/);

  for (const [i, raw] of rawLines.entries()) {
    const lineNo = i + 1;
    const indentMatch = raw.slice(0, raw.length - raw.trimStart().length);
    if (indentMatch.includes('\t')) {
      throw new YamlError('Tabs are not allowed for indentation', lineNo);
    }

    const text = stripComment(raw).trim();
    if (text === '' || text === '---') {
      continue;
    }
    lines.push({ indent: indentMatch.length, text, lineNo });
  }

  return lines;
}

/**
 * Remove a trailing comment: `#` at line start or after whitespace, outside quotes
 */
function stripComment(line: string): string {
  let quote: string | undefined;
  let escaped = false;
  let previous = ' ';
  // Index by UTF-16 unit so slice() cuts at the right place; quotes and # are ASCII
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\' && quote === '"') escaped = true;
      else if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && /\s/.test(previous)) {
      return line.slice(0, i);
    }
    previous = ch;
  }
  return line;
}

function isSequenceItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

/**
 * Split `key: value` (or `key:`) outside quotes; undefined if the line is not a mapping entry
 */
function splitKey(text: string): { key: string; rest: string } | undefined {
  const match = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^"'#][^:]*?)\s*:(?:\s+(.*)|)$/.exec(text);
  if (!match) {
    return undefined;
  }
  const rawKey = match[1] ?? '';
  const key = rawKey.startsWith('"') || rawKey.startsWith("'") ? (parseScalar(rawKey) as string) : rawKey;
  return { key, rest: (match[2] ?? '').trim() };
}

function parseBlock(lines: Line[], i: number, indent: number): [unknown, number] {
  const line = lines[i];
  return line && isSequenceItem(line.text) ? parseSequence(lines, i, indent) : parseMapping(lines, i, indent);
}

/**
 * After a block at `indent`, the next line must be shallower (it belongs to a parent)
 */
function assertConsumed(lines: Line[], i: number, indent: number): void {
  const line = lines[i];
  if (line && line.indent > indent) {
    throw new YamlError('Unexpected indentation', line.lineNo);
  }
}

function parseMapping(lines: Line[], start: number, indent: number): [Record<string, unknown>, number] {
  const result: Record<string, unknown> = {};
  let i = start;

  for (let line = lines[i]; line && line.indent === indent; line = lines[i]) {
    if (isSequenceItem(line.text)) {
      throw new YamlError('Unexpected list item in a mapping', line.lineNo);
    }

    const entry = splitKey(line.text);
    if (!entry) {
      throw new YamlError(`Expected "key: value", got "${line.text}"`, line.lineNo);
    }
    if (Object.prototype.hasOwnProperty.call(result, entry.key)) {
      throw new YamlError(`Duplicate key "${entry.key}"`, line.lineNo);
    }
    i++;

    const next = lines[i];
    if (entry.rest !== '') {
      result[entry.key] = parseScalar(entry.rest, line.lineNo);
    } else if (next && next.indent > indent) {
      [result[entry.key], i] = parseBlock(lines, i, next.indent);
    } else if (next && next.indent === indent && isSequenceItem(next.text)) {
      // YAML allows a sequence at the same indentation as its parent key
      [result[entry.key], i] = parseSequence(lines, i, indent);
    } else {
      result[entry.key] = null;
    }
  }

  assertConsumed(lines, i, indent);
  return [result, i];
}

function parseSequence(lines: Line[], start: number, indent: number): [unknown[], number] {
  const result: unknown[] = [];
  let i = start;

  for (let line = lines[i]; line && line.indent === indent && isSequenceItem(line.text); line = lines[i]) {
    const rest = line.text.slice(1).trimStart();

    if (rest === '') {
      const next = lines[i + 1];
      if (next && next.indent > indent) {
        let value: unknown;
        [value, i] = parseBlock(lines, i + 1, next.indent);
        result.push(value);
      } else {
        result.push(null);
        i++;
      }
    } else if (isSequenceItem(rest) || splitKey(rest)) {
      // `- key: value` / `- - x`: the item is a nested block starting at the column of `rest`
      const column = indent + (line.text.length - rest.length);
      const copy = lines.slice();
      copy[i] = { indent: column, text: rest, lineNo: line.lineNo };
      let value: unknown;
      [value, i] = parseBlock(copy, i, column);
      result.push(value);
    } else {
      result.push(parseScalar(rest, line.lineNo));
      i++;
    }
  }

  assertConsumed(lines, i, indent);
  return [result, i];
}

function parseScalar(value: string, lineNo?: number): unknown {
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) throw new YamlError('Unterminated string', lineNo);
    return JSON.parse(value) as string;
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw new YamlError('Unterminated string', lineNo);
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw new YamlError('Unterminated flow sequence', lineNo);
    const inner = value.slice(1, -1).trim();
    return inner === '' ? [] : splitFlow(inner).map((item) => parseScalar(item, lineNo));
  }
  if (value === '{}') {
    return {};
  }
  if (value.startsWith('{')) {
    throw new YamlError('Flow mappings are not supported, use an indented block', lineNo);
  }

  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(value)) return parseFloat(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;

  return value;
}

/**
 * Split flow sequence items on commas outside quotes
 */
function splitFlow(inner: string): string[] {
  const items: string[] = [];
  let quote: string | undefined;
  let current = '';
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ',') {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  items.push(current.trim());
  return items;
}
