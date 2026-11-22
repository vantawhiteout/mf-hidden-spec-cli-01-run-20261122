// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, standard library only. The trial hand-over to runner.ts is at the end.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

/** Read a file's text into lines, its line break and whether it ends with one. */
function parseFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = parts.length > 1 && parts[parts.length - 1] === '';
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; to: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  noteMove(oldPath: string, to: string): void {
    this.moves.push({ old: oldPath, to });
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5)
// ---------------------------------------------------------------------------

type Tier = 0 | 1 | 2;
const TIERS: Tier[] = [0, 1, 2];
const TIER_KEYS: Tier[] = [0, 1, 2];
/** Set by --strict: only exact line matching (tier 0) is tried. */
let strictMode = false;

function leading(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function tierKey(s: string, tier: Tier): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** All positions at which O matches the file's lines at one tier. */
function occurrences(o: string[], lines: string[], tier: Tier, from: number, strict: boolean): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const last = lines.length - o.length;
  for (let i = Math.max(0, from); i <= last; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (tierKey(o[j]!, tier) !== tierKey(lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier with an occurrence, and the occurrences at it. */
function findOccurrences(o: string[], lines: string[], from: number, endAtFileEnd = false): { tier: Tier; at: number[] } | null {
  for (const tier of strictMode ? TIER_KEYS.slice(0, 1) : TIERS) {
    const at = occurrences(o, lines, tier, from, strictMode).filter((p) => !endAtFileEnd || p + o.length === lines.length);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

interface BodyLine {
  type: ' ' | '-' | '+';
  text: string;
  oIndex: number; // index of the corresponding old line, for context lines
  bodyIndex: number;
}
type RawBody = Array<{ type: ' ' | '-' | '+' | '\\'; text: string }>;

/** Build old and new line lists from a raw body, keeping context correspondence. */
function bodyLists(body: RawBody): { o: string[]; n: BodyLine[] } {
  const o: string[] = [];
  const n: BodyLine[] = [];
  body.forEach((b, idx) => {
    if (b.type === '\\') return;
    if (b.type === '-') o.push(b.text);
    else if (b.type === ' ') {
      const oi = o.length;
      o.push(b.text);
      n.push({ type: ' ', text: b.text, oIndex: oi, bodyIndex: idx });
    } else n.push({ type: '+', text: b.text, oIndex: -1, bodyIndex: idx });
  });
  return { o, n };
}

/** A `\` body line refers to the body line just before it. */
function noEolAfter(body: RawBody, at: number): boolean {
  return at >= 0 && body[at + 1] !== undefined && body[at + 1]!.type === '\\';
}

/** Write N over the matched range: context lines use the file's own text. */
function writtenLines(n: BodyLine[], o: string[], fileLines: string[], pos: number, tier: Tier): string[] {
  const f = leading(fileLines[pos] ?? '');
  const p = leading(o.length > 0 ? o[0]! : '');
  return n.map((b) => {
    if (b.type === ' ') return fileLines[pos + b.oIndex] ?? b.text;
    let text = b.text;
    if (tier === 2 && text.trim() !== '' && text.startsWith(p)) text = f + text.slice(p.length);
    return text;
  });
}

/** Replace O at `pos` with N, returning the new lines and cursor destination. */
function spliceLines(fileLines: string[], pos: number, oLen: number, nLines: string[]): string[] {
  const out = fileLines.slice(0, pos).concat(nLines, fileLines.slice(pos + oLen));
  return out;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;

function pathAfter(line: string, prefix: string): string | null {
  let p = line.slice(prefix.length);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

interface UHunk {
  a: number;
  body: RawBody;
  o: string[];
  n: BodyLine[];
  noEol: boolean;
  lastPlusNoEol: boolean;
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  headerOld: string | null;
  headerNew: string | null;
  hasHeaderPaths: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: UHunk[];
}

function sectionOld(s: USection): string | null {
  return s.hasHeaderPaths ? s.headerOld : (s.renameFrom ?? s.gitOld);
}
function sectionNew(s: USection): string | null {
  return s.hasHeaderPaths ? s.headerNew : (s.renameTo ?? s.gitNew);
}

function isUSectionStart(lines: string[], i: number): boolean {
  const l = lines[i] ?? '';
  if (l.startsWith('diff --git ')) return true;
  return l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (HUNK_RE.test(l)) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(l)!;
      const hunk: UHunk = { a: Number(m[1]), body: [], o: [], n: [], noEol: false, lastPlusNoEol: false };
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (isUSectionStart(lines, j)) break;
        if (b === '') hunk.body.push({ type: ' ', text: '' });
        else if (b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') hunk.body.push({ type: b[0] as ' ' | '-' | '+' | '\\', text: b.slice(1) });
        else break;
        j += 1;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.type === ' ' && hunk.body[hunk.body.length - 1]!.text === '') hunk.body.pop();
      const lists = bodyLists(hunk.body);
      hunk.o = lists.o;
      hunk.n = lists.n;
      if (hunk.n.length > 0) hunk.noEol = noEolAfter(hunk.body, hunk.n[hunk.n.length - 1]!.bodyIndex);
      const plus = hunk.body.map((b, idx) => (b.type === '+' ? idx : -1)).filter((idx) => idx >= 0);
      if (plus.length > 0) hunk.lastPlusNoEol = noEolAfter(hunk.body, plus[plus.length - 1]!);
      cur.hunks.push(hunk);
      i = j;
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (l.startsWith('diff --git ')) {
      const m = GIT_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        gitOld: m[1]!, gitNew: m[2]!, headerOld: null, headerNew: null, hasHeaderPaths: false,
        renameFrom: null, renameTo: null, creation: false, deletion: false, hunks: [],
      };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0) {
        cur.headerOld = pathAfter(l, '--- ');
        cur.headerNew = pathAfter(lines[i + 1]!, '+++ ');
        cur.hasHeaderPaths = true;
      } else {
        cur = {
          gitOld: null, gitNew: null, headerOld: pathAfter(l, '--- '), headerNew: pathAfter(lines[i + 1]!, '+++ '),
          hasHeaderPaths: true, renameFrom: null, renameTo: null, creation: false, deletion: false, hunks: [],
        };
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.creation = true;
      else if (l.startsWith('deleted file mode')) cur.deletion = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s));
}

function unifiedEdit(s: USection): Edit {
  const oldPath = sectionOld(s);
  const newPath = sectionNew(s);
  const creation = s.creation || oldPath === null;
  const deletion = s.deletion || newPath === null;
  return (tree) => {
    // Every path named by the edit is checked before anything else.
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (creation) {
      const to = newPath ?? oldPath!;
      if (tree.get(to) !== null) throw new Fail('exists', to);
      const out: string[] = [];
      let noEol = false;
      for (const h of s.hunks) for (const b of h.body) if (b.type === '+') out.push(b.text);
      const lastHunk = [...s.hunks].reverse().find((x) => x.body.some((b) => b.type === '+'));
      if (lastHunk !== undefined) {
        const idx = lastHunk.body.map((b, k) => (b.type === '+' ? k : -1)).filter((k) => k >= 0).pop()!;
        noEol = noEolAfter(lastHunk.body, idx);
      }
      tree.now.set(to, joinFile({ lines: out, br: '\n', final: out.length > 0 && !noEol }));
      return;
    }
    if (deletion) {
      const from = oldPath ?? newPath!;
      if (tree.get(from) === null) throw new Fail('missing', from);
      tree.now.set(from, null);
      return;
    }
    const from = oldPath!;
    const to = newPath!;
    const moving = from !== to;
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (moving && tree.get(to) !== null) throw new Fail('exists', to);
    let f = parseFile(before);
    let d = 0;
    let failed: Fail | null = null;
    for (const h of s.hunks) {
      const target = h.a - 1 + d;
      let pos: number;
      let tier: Tier = 0;
      if (h.o.length > 0) {
        const found = findOccurrences(h.o, f.lines, 0);
        if (found === null) {
          failed = new Fail('no-match', from);
          break;
        }
        tier = found.tier;
        let best = found.at[0]!;
        for (const at of found.at) if (Math.abs(at - target) < Math.abs(best - target)) best = at;
        pos = best;
      } else {
        pos = Math.max(0, Math.min(f.lines.length, target >= 0 ? target + 1 : 0));
      }
      const atEnd = h.o.length > 0 ? pos + h.o.length === f.lines.length : pos === f.lines.length;
      const nLines = writtenLines(h.n, h.o, f.lines, pos, tier);
      f.lines = spliceLines(f.lines, pos, h.o.length, nLines);
      if (atEnd) f.final = !h.noEol;
      d += h.n.length - h.o.length;
    }
    if (failed !== null) throw failed;
    const result = joinFile(f);
    if (moving) {
      tree.now.set(to, result);
      tree.now.set(from, null);
      tree.noteMove(from, to);
    } else tree.now.set(from, result);
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  o: string[];
  n: string[];
}

function searchReplaceEdits(lines: string[]): Edit[] {
  const blocks: SRBlock[] = [];
  let previous: string | null = null;
  let regionStart = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const search = i;
    let eq = -1;
    let repl = -1;
    for (let j = search + 1; j < lines.length; j += 1) {
      if (eq < 0 && lines[j]!.trimEnd() === '=======') eq = j;
      else if (eq < 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        // A REPLACE marker before any ======= means there is no "======= and then REPLACE after it".
        throw new Exit2(`error: parse ${search + 1}`);
      } else if (eq >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        repl = j;
        break;
      }
    }
    if (eq < 0 || repl < 0) throw new Exit2(`error: parse ${search + 1}`);
    // The nearest path line before SEARCH, after the previous block's REPLACE.
    let path: string | null = null;
    for (let j = search - 1; j >= regionStart; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trimStart().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = previous;
    if (path === null) throw new Exit2(`error: parse ${search + 1}`);
    blocks.push({ path, o: lines.slice(search + 1, eq), n: lines.slice(eq + 1, repl) });
    previous = path;
    regionStart = repl + 1;
    i = repl + 1;
  }
  return blocks.map((b) => searchReplaceEdit(b));
}

function searchReplaceEdit(b: SRBlock): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.o.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, joinFile({ lines: b.n, br: '\n', final: b.n.length > 0 }));
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = parseFile(before);
    const found = findOccurrences(b.o, f.lines, 0);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.at.length > 1) throw new Fail('ambiguous', b.path);
    const nLines = writtenLines(b.n.map((text, idx) => ({ type: '+', text, oIndex: -1, bodyIndex: idx })), b.o, f.lines, found.at[0]!, found.tier);
    f.lines = spliceLines(f.lines, found.at[0]!, b.o.length, nLines);
    tree.now.set(b.path, joinFile(f));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  body: Array<{ type: ' ' | '-' | '+'; text: string }>;
  o: string[];
  n: BodyLine[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
  headerLine: number;
}

const V_START = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];

function isVStart(l: string): boolean {
  return V_START.some((p) => l.startsWith(p));
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  const lastFilled = (() => {
    let n = lines.length;
    while (n > 0 && blank(lines[n - 1]!)) n -= 1;
    return n - 1;
  })();
  if (lastFilled < 0 || lines[lastFilled]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < lastFilled) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const header = lines[i]!;
    if (!isVStart(header)) throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    const start = i + 1;
    let end = start;
    while (end < lastFilled && !isVStart(lines[end]!)) end += 1;
    let content = lines.slice(start, end).map((text, k) => ({ text, line: start + k + 1 }));
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    const kind: 'add' | 'delete' | 'update' = header.startsWith('*** Add File: ')
      ? 'add'
      : header.startsWith('*** Delete File: ')
        ? 'delete'
        : 'update';
    const path = header.slice(header.indexOf(': ') + 2).trim();
    const s: VSection = { kind, path, moveTo: null, lines: [], chunks: [], headerLine };
    let k = 0;
    if (kind === 'add') {
      for (; k < content.length; k += 1) {
        const c = content[k]!;
        if (c.text === '') s.lines.push('');
        else if (c.text.startsWith('+')) s.lines.push(c.text.slice(1));
        else throw new Exit2(`error: parse ${c.line}`);
      }
    } else if (kind === 'delete') {
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.line}`);
    } else {
      if (k < content.length && content[k]!.text.startsWith('*** Move to: ')) {
        s.moveTo = content[k]!.text.slice(13).trim();
        k += 1;
      }
      let chunk: VChunk | null = null;
      // SPEC.md section 8: a chunk starts at an `@@` line or, for the first chunk only, at a body
      // line. Once a chunk has ended (`*** End of File`), a bare body line cannot start another one.
      let seenChunk = false;
      while (k < content.length) {
        const c = content[k]!;
        const t = c.text;
        if (t.startsWith('@@')) {
          if (chunk !== null) {
            finishChunk(chunk, s);
            chunk = null;
          }
          chunk = { anchor: t.slice(2).trim() || null, body: [], o: [], n: [], eof: false };
          seenChunk = true;
          k += 1;
          continue;
        }
        if (t === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${c.line}`);
          chunk.eof = true;
          finishChunk(chunk, s);
          chunk = null;
          k += 1;
          continue;
        }
        if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
          if (chunk === null) {
            if (seenChunk) throw new Exit2(`error: parse ${c.line}`);
            chunk = { anchor: null, body: [], o: [], n: [], eof: false };
            seenChunk = true;
          }
          chunk.body.push({ type: (t[0] ?? ' ') as ' ' | '-' | '+', text: t === '' ? '' : t.slice(1) });
          k += 1;
          continue;
        }
        throw new Exit2(`error: parse ${c.line}`);
      }
      if (chunk !== null) finishChunk(chunk, s);
      if (s.chunks.length === 0 && s.moveTo === null) throw new Exit2(`error: parse ${s.headerLine}`);
    }
    sections.push(s);
    i = end;
  }
  return sections.map((s) => v4aEdit(s));
}

function finishChunk(chunk: VChunk, s: VSection): void {
  const lists = bodyLists(chunk.body);
  chunk.o = lists.o;
  chunk.n = lists.n;
  s.chunks.push(chunk);
}

function v4aEdit(s: VSection): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, joinFile({ lines: s.lines, br: '\n', final: true }));
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    let f = parseFile(before);
    let cursor = 0;
    for (const chunk of s.chunks) {
      let from = cursor;
      let tier: Tier = 0;
      if (chunk.anchor !== null) {
        let found: { tier: Tier; at: number } | null = null;
        for (const t of strictMode ? TIER_KEYS.slice(0, 1) : TIERS) {
          const at = f.lines.findIndex((l, idx) => idx >= cursor && tierKey(l, t) === tierKey(chunk.anchor!, t));
          if (at >= 0) {
            found = { tier: t, at };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', s.path);
        cursor = found.at + 1;
        from = cursor;
        tier = found.tier;
      }
      let pos: number;
      if (chunk.o.length === 0) {
        pos = chunk.eof ? f.lines.length : from;
      } else {
        const found = findOccurrences(chunk.o, f.lines, from, chunk.eof);
        if (found === null) throw new Fail('no-match', s.path);
        tier = found.tier;
        pos = found.at[0]!;
      }
      const nLines = writtenLines(chunk.n, chunk.o, f.lines, pos, tier);
      f.lines = spliceLines(f.lines, pos, chunk.o.length, nLines);
      cursor = pos + nLines.length;
    }
    const result = joinFile(f);
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, result);
      tree.now.set(s.path, null);
      tree.noteMove(s.path, s.moveTo);
    } else tree.now.set(s.path, result);
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Invocation, output and atomicity (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  strictMode = strict;
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else edits = v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      tree.moves.length = 0;
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const bytes = (s: string): Buffer => Buffer.from(s, 'utf8');
  const renamed = new Set<string>();
  const renameOf = new Map<string, string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.to) === null && tree.get(m.to) !== null) {
      renamed.add(m.old);
      renameOf.set(m.to, `${m.old} -> ${m.to}`);
    }
  }
  type Row = { key: string; line: string };
  const rows: Row[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(bytes(a), bytes(b)))) {
    if (renamed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const rename = renameOf.get(p);
    if (rename !== undefined) rows.push({ key: p, line: `R ${rename}` });
    else rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(bytes(a.key), bytes(b.key)));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(bytes(a), bytes(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
