// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
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

/** SPEC.md sections 5 to 8: three-tier line matching, unified diffs, SEARCH/REPLACE blocks and V4A patches. */

interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.final ? p.br : '');
}

const rtrimWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWs(a) === rtrimWs(b);
  return trimWs(a) === trimWs(b);
}

function findOccurrences(o: string[], f: string[], tier: number, from: number): number[] {
  const occ: number[] = [];
  for (let i = from; i + o.length <= f.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(o[j]!, f[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) occ.push(i);
  }
  return occ;
}

/** The first tier at which O occurs in F at or after `from`, with its positions, or null. */
function findTier(o: string[], f: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = findOccurrences(o, f, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface NItem {
  text: string;
  ctx: boolean;
  ctxIdx: number;
}

/** The lines N becomes at a match: context lines are the file's own matched lines; at tier 2 the other
 * lines are re-indented from O's first line's leading whitespace to the file's first matched line's. */
function buildNew(items: NItem[], o: string[], f: string[], pos: number, tier: number): string[] {
  if (tier < 2) return items.map((it) => (it.ctx ? f[pos + it.ctxIdx]! : it.text));
  const leadF = leadWs(f[pos]!);
  const leadP = leadWs(o[0]!);
  return items.map((it) => {
    if (it.ctx) return f[pos + it.ctxIdx]!;
    const t = it.text;
    if (t === '' || t.trim() === '') return t;
    if (t.startsWith(leadP)) return leadF + t.slice(leadP.length);
    return t;
  });
}

interface HunkItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noNL: boolean;
}

interface Hunk {
  a: number;
  items: HunkItem[];
}

/** Split a hunk's (or a V4A chunk's) body items into the old lines O and the new lines N. */
function splitBody(items: HunkItem[]): { oTexts: string[]; nItems: NItem[] } {
  const oTexts: string[] = [];
  const nItems: NItem[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      nItems.push({ text: it.text, ctx: true, ctxIdx: oTexts.length });
      oTexts.push(it.text);
    } else if (it.kind === 'old') {
      oTexts.push(it.text);
    } else {
      nItems.push({ text: it.text, ctx: false, ctxIdx: -1 });
    }
  }
  return { oTexts, nItems };
}

/** Whether a `\` line follows the body's last context or `+` line. */
function lastNoNL(items: HunkItem[]): boolean {
  let v = false;
  for (const it of items) {
    if (it.kind === 'ctx' || it.kind === 'new') v = it.noNL;
  }
  return v;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  created: boolean;
  deleted: boolean;
  pairSet: boolean;
  hunks: Hunk[];
}

function unifiedPath(raw: string): string {
  let s = raw.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

/** The old start A of a hunk header line, or null when the line is not a hunk header. */
function hunkHead(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
  if (m === null) return null;
  return parseInt(m[1]!, 10);
}

function hunkBody(lines: string[], i: number): { items: HunkItem[]; next: number } {
  const items: HunkItem[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      if (l.startsWith('\\')) {
        const prev = items[items.length - 1];
        if (prev !== undefined) prev.noNL = true;
      } else if (l === '') items.push({ kind: 'ctx', text: '', noNL: false });
      else if (l.startsWith(' ')) items.push({ kind: 'ctx', text: l.slice(1), noNL: false });
      else if (l.startsWith('-')) items.push({ kind: 'old', text: l.slice(1), noNL: false });
      else items.push({ kind: 'new', text: l.slice(1), noNL: false });
      i++;
    } else break;
  }
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === 'ctx' && last.text === '' && !last.noNL) items.pop();
    else break;
  }
  return { items, next: i };
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { oTexts, nItems } = splitBody(h.items);
    if (oTexts.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > f.lines.length) pos = f.lines.length;
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...nItems.map((it) => it.text));
      if (atEnd) f.final = !lastNoNL(h.items);
      d += nItems.length;
      continue;
    }
    const found = findTier(oTexts, f.lines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.occ[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        pos = p;
        best = dist;
      }
    }
    const touchedEnd = pos + oTexts.length === f.lines.length;
    const repl = buildNew(nItems, oTexts, f.lines, pos, found.tier);
    f.lines.splice(pos, oTexts.length, ...repl);
    if (touchedEnd) f.final = !lastNoNL(h.items);
    d += nItems.length - oTexts.length;
  }
  return joinFile(f);
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.oldPath ?? s.newPath;
    const newP = s.newPath ?? s.oldPath;
    if (oldP === null || newP === null) return;
    const isCreate = oldP === '/dev/null' || s.created;
    const isDelete = newP === '/dev/null' || s.deleted;
    if (isCreate) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: HunkItem[] = [];
      for (const h of s.hunks) for (const it of h.items) if (it.kind === 'new') plus.push(it);
      let text = '';
      if (plus.length > 0) {
        text = plus.map((it) => it.text).join('\n') + '\n';
        if (plus[plus.length - 1]!.noNL) text = plus.map((it) => it.text).join('\n');
      }
      tree.now.set(newP, text);
      return;
    }
    if (isDelete) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const isMove = oldP !== newP;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (isMove && !safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const result = applyHunks(before, s.hunks, strict, oldP);
    if (isMove) {
      tree.now.set(newP, result);
      tree.now.set(oldP, null);
      tree.recordMove(oldP, newP);
    } else {
      tree.now.set(oldP, result);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const fresh = (): Section => ({ oldPath: null, newPath: null, created: false, deleted: false, pairSet: false, hunks: [] });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l === 'diff --git' || l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.oldPath = m[1]!;
      cur.newPath = m[2]!;
      sections.push(cur);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.pairSet) {
        cur = fresh();
        sections.push(cur);
      }
      cur.oldPath = unifiedPath(l);
      cur.newPath = unifiedPath(lines[i + 1]!);
      cur.pairSet = true;
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0 && l.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = hunkHead(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const body = hunkBody(lines, i + 1);
      cur.hunks.push({ a, items: body.items });
      i = body.next;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('rename from ')) cur.oldPath = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.newPath = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.created = true;
      else if (l.startsWith('deleted file mode')) cur.deleted = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(oldLines, f.lines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length !== 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const repl = buildNew(newLines.map((t) => ({ text: t, ctx: false, ctxIdx: -1 })), oldLines, f.lines, pos, found.tier);
    f.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinFile(f));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const cand = lines[j]!;
      if (!blank(cand) && !cand.trim().startsWith('```')) {
        path = cand.trim();
        break;
      }
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srEdit(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: HunkItem[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null && c.anchor !== '') {
        const found = findTier([c.anchor], f.lines, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      const { oTexts, nItems } = splitBody(c.items);
      if (oTexts.length === 0) {
        const pos = c.eof ? f.lines.length : cursor;
        f.lines.splice(pos, 0, ...nItems.map((it) => it.text));
        cursor = pos + nItems.length;
        continue;
      }
      const found = findTier(oTexts, f.lines, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let pos: number | null = null;
      for (const p of found.occ) {
        if (c.eof && p + oTexts.length !== f.lines.length) continue;
        pos = p;
        break;
      }
      if (pos === null) throw new Fail('no-match', path);
      const repl = buildNew(nItems, oTexts, f.lines, pos, found.tier);
      f.lines.splice(pos, oTexts.length, ...repl);
      cursor = pos + repl.length;
    }
    const result = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, result);
      tree.now.set(path, null);
      tree.recordMove(path, moveTo);
    } else {
      tree.now.set(path, result);
    }
  };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim();
      const raw: number[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        raw.push(j);
        j++;
      }
      while (raw.length > 0 && blank(lines[raw[raw.length - 1]!]!)) raw.pop();
      const fileLines: string[] = [];
      for (const k of raw) {
        const rl = lines[k]!;
        if (rl.startsWith('+')) fileLines.push(rl.slice(1));
        else if (blank(rl)) fileLines.push('');
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(17).trim();
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      edits.push(v4aDeleteEdit(path));
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice(17).trim();
      const updateLine = i;
      const raw: number[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        raw.push(j);
        j++;
      }
      while (raw.length > 0 && blank(lines[raw[raw.length - 1]!]!)) raw.pop();
      let moveTo: string | null = null;
      let k = 0;
      if (k < raw.length && lines[raw[k]!]!.startsWith('*** Move to: ')) {
        moveTo = lines[raw[k]!]!.slice(13).trim();
        k++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let started = false;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; k < raw.length; k++) {
        const idx = raw[k]!;
        const rl = lines[idx]!;
        if (rl.startsWith('@@')) {
          closeChunk();
          cur = { anchor: rl.slice(2).trim(), eof: false, items: [] };
          started = true;
          continue;
        }
        if (rl.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
          cur.eof = true;
          closeChunk();
          continue;
        }
        if (rl.startsWith('***')) throw new Exit2(`error: parse ${idx + 1}`);
        if (cur === null) {
          if (started) throw new Exit2(`error: parse ${idx + 1}`);
          cur = { anchor: null, eof: false, items: [] };
          started = true;
        }
        if (rl === '') cur.items.push({ kind: 'ctx', text: '', noNL: false });
        else if (rl.startsWith(' ')) cur.items.push({ kind: 'ctx', text: rl.slice(1), noNL: false });
        else if (rl.startsWith('-')) cur.items.push({ kind: 'old', text: rl.slice(1), noNL: false });
        else if (rl.startsWith('+')) cur.items.push({ kind: 'new', text: rl.slice(1), noNL: false });
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

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
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      for (const m of beforeMoves) tree.moves.push(m);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const moved = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.has(newP) && tree.now.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      moved.add(oldP);
      moved.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
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
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
