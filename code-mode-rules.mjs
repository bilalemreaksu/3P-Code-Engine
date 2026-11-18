import os from 'node:os';
import path from 'node:path';

// Permission rules follow the native Claude Code schema, verified against
// https://code.claude.com/docs/en/permissions.md:
//   - deny/ask: a statement (subcommand) matching any rule triggers.
//   - allow:    the WHOLE command must be covered: parseable, every statement
//               simple (no substitution/parens/redirects), and each statement
//               either pattern-matched or on the documented read-only list.
// This module is text matching, not a shell sandbox; allow rules never cover
// compound, redirected or unparseable commands (fail-closed).

const glob = (pattern, text) => new RegExp('^' + pattern.split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*') + '$', 's').test(text);

// Split on the documented separators outside quotes: ; & && | |& newline.
// `complete=false` marks unparseable input: an unclosed quote, a leading
// separator, an empty statement, or a trailing separator ("cmd &&").
export function splitStatements(command) {
  const statements = [];
  if (typeof command !== 'string') return { statements, complete: false };
  let quote = '', start = 0, complete = true;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '\\') { i++; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === ';' || char === '&' || char === '|') {
      const next = command[i + 1];
      const length = (char === '&' && next === '&') || (char === '|' && next === '&') ? 2 : 1;
      const part = command.slice(start, i).trim();
      if (!part) { complete = false; break; }
      statements.push(part);
      i += length - 1;
      start = i + 1;
    } else if (char === '\n' || char === '\r') {
      const part = command.slice(start, i).trim();
      if (part) statements.push(part);
      start = i + 1;
    }
  }
  if (quote) complete = false;
  const tail = command.slice(start).trim();
  if (tail) statements.push(tail);
  else if (statements.length > 0 && !quote && /[;&|]$/.test(command.trimEnd())) complete = false;
  return { statements, complete };
}

// The subcommands of the command (the whole command when it has none).
export function commandSegments(command) {
  const { statements } = splitStatements(command);
  if (statements.length === 0) return [command.trim()];
  return [...new Set(statements)];
}

// A statement is simple when, outside quotes, it carries none of the
// constructs we refuse to reason about: redirects, substitution, backticks,
// or parentheses. Anything else is "unparseable" for allow matching.
function isSimpleStatement(statement) {
  let quote = '';
  for (let i = 0; i < statement.length; i++) {
    const char = statement[i];
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '\\') { i++; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if ('<>`()'.includes(char)) return false;
    if (char === '$' && statement[i + 1] === '(') return false;
  }
  return true;
}

// Quoted-aware token list. Escaped characters and quoted text do not count as
// unquoted globs.
function tokenize(statement) {
  const tokens = [];
  let token = '', quote = '', inToken = false, unquotedGlob = false;
  for (let i = 0; i < statement.length; i++) {
    const char = statement[i];
    if (quote) { if (char === quote) quote = ''; else token += char; inToken = true; continue; }
    if (char === '\\') { token += statement[i + 1] ?? ''; inToken = true; i++; continue; }
    if (char === '"' || char === "'") { quote = char; inToken = true; continue; }
    if (/\s/.test(char)) { if (inToken) { tokens.push(token); token = ''; inToken = false; } continue; }
    token += char;
    inToken = true;
    if ('*?['.includes(char)) unquotedGlob = true;
  }
  if (quote) return { tokens: [], unquotedGlob, invalid: true };
  if (inToken) tokens.push(token);
  return { tokens, unquotedGlob, invalid: false };
}

// Documented read-only command set (no prompt in any mode): ordinary
// inspection commands plus PowerShell cmdlets and their common aliases —
// the same grammar, no per-shell special cases.
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'echo', 'pwd', 'head', 'tail', 'grep', 'which', 'diff', 'stat', 'du', 'wc', 'type', 'dir',
  'Get-ChildItem', 'gci', 'Get-Content', 'Get-Item', 'gi', 'Get-ItemProperty', 'gp',
  'Get-Location', 'gl', 'Test-Path', 'tp', 'Select-Object', 'where', 'Where-Object',
  'Measure-Object', 'group', 'Group-Object', 'gps', 'Get-Process', 'gsv', 'Get-Service',
  'Get-Command', 'Get-Date', 'Get-Random', 'Write-Host', 'Write-Output',
]);

const GIT_READ_ONLY = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'tag', 'remote', 'describe',
  'rev-parse', 'ls-files', 'shortlog', 'reflog',
]);

const FIND_UNSAFE = new Set([
  '-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprintf',
]);

function gitReadOnly(tokens, unquotedGlob) {
  if (unquotedGlob) return false;
  for (const token of tokens.slice(1)) {
    if (token.startsWith('-')) return false; // any flag before the subcommand: -c, -C, --git-dir
    if (GIT_READ_ONLY.has(token.toLowerCase())) return true;
    return false;
  }
  return false;
}

function findReadOnly(tokens, unquotedGlob) {
  if (unquotedGlob) return false;
  return !tokens.slice(1).some(token => FIND_UNSAFE.has(token) || token === '+');
}

// A directory change latches `moved`: a later `git` in the compound command
// prompts (git can run hooks of the directory it now runs in), while a
// `cd` that stays in the same directory is a no-op.
function statementReadOnly(statement, effectiveDir, cwd, moved) {
  if (!isSimpleStatement(statement)) return { readOnly: false, dir: null, moved };
  const { tokens, unquotedGlob, invalid } = tokenize(statement);
  if (invalid || tokens.length === 0) return { readOnly: false, dir: null, moved };
  const program = tokens[0];
  // Network paths reach another computer (and on Windows can send
  // credentials): a read-only command with one prompts, per the docs.
  if (/\\\\[^\\]+\\/.test(statement) || tokens.some(t => t === '/net' || t.startsWith('/net/'))) {
    return { readOnly: false, dir: null, moved };
  }
  if (program === 'cd') {
    const rest = tokens.slice(1);
    if (rest.length !== 1 || unquotedGlob || rest[0].includes('$')) return { readOnly: false, dir: null, moved };
    const resolved = path.resolve(effectiveDir, rest[0]);
    const inside = resolved === cwd || resolved.startsWith(cwd + path.sep);
    if (!inside) return { readOnly: false, dir: null, moved };
    return { readOnly: true, dir: resolved, moved: moved || resolved !== effectiveDir };
  }
  if (program === 'git') return { readOnly: !moved && gitReadOnly(tokens, unquotedGlob), dir: null, moved };
  if (program === 'find') return { readOnly: findReadOnly(tokens, unquotedGlob), dir: null, moved };
  if (program === 'which') {
    // Documented: lookup/display flags only (-a is fine; -i/--read-alias prompt).
    return { readOnly: tokens.slice(1).filter(t => t.startsWith('-')).every(flag => flag === '-a'), dir: null, moved };
  }
  return { readOnly: READ_ONLY_COMMANDS.has(program), dir: null, moved };
}

// True when every statement of a complete, short command is read-only.
// `cd` statements move the effective directory; leaving the working directory
// makes the command non-read-only (it would prompt).
export function commandIsReadOnly(command, cwd) {
  const { statements, complete } = splitStatements(command);
  if (typeof command !== 'string' || !complete || statements.length === 0 || command.length > 10000) return false;
  const base = path.resolve(cwd);
  let effective = base, moved = false;
  for (const statement of statements) {
    const result = statementReadOnly(statement, effective, base, moved);
    if (!result.readOnly) return false;
    if (result.dir) effective = result.dir;
    moved = result.moved;
  }
  return true;
}

// Command pattern: `:*` is equivalent to ` *`; a trailing " * " (the only
// wildcard) also matches the bare command ("npm run *" matches "npm run").
// The `:` character is literal anywhere else.
function commandPatternMatcher(pattern) {
  const p = pattern.replace(/:\*$/, ' *');
  const escaped = p.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  const regex = new RegExp(`^${escaped}$`, 's');
  const bare = p.match(/ .*\*$/) && p.split(' ').slice(0, -1).join(' ') === p.replace(/ .*\*$/, '') ? p.replace(/ .*\*$/, '') : null;
  const singleTrailingStar = p.endsWith(' *') && p.includes('*') && p.slice(0, -2).includes('*') === false;
  return (text) => regex.test(text) || (singleTrailingStar && text === p.slice(0, -2));
}

function bashMatches(pattern, input, cwd, kind) {
  const command = input?.command;
  if (typeof command !== 'string') return false;
  const match = commandPatternMatcher(pattern);
  const { statements, complete } = splitStatements(command);
  if (kind !== 'allow') return statements.some(statement => match(statement));
  // Allow coverage requires a command we can fully reason about: parseable,
  // and no statement may carry a construct outside the pattern's control —
  // redirects and substitution are never covered by a command pattern.
  if (!complete || statements.length === 0 || command.length > 10000) return false;
  const base = path.resolve(cwd);
  let effective = base, moved = false;
  for (const statement of statements) {
    if (!isSimpleStatement(statement)) return false;
    if (match(statement)) continue;
    const result = statementReadOnly(statement, effective, base, moved);
    if (!result.readOnly) return false;
    if (result.dir) effective = result.dir;
    moved = result.moved;
  }
  return true;
}

// ── File patterns (gitignore-like, per the permissions docs) ────────────────
// Anchors:  //path  absolute (Windows C:\ stored as /c/), ~ /  home, /path
// anchored to the settings source (here: the cwd), a bare path relative to
// the cwd.  `*` matches within one segment, `**` across segments, and bare
// filenames match at any depth.  Unanchored single-directory-segment
// patterns (src/**) match only under the cwd for allow rules but at any
// depth for deny/ask rules (native: the allow form is anchored).
function posixPath(p) { return p.split(path.sep).join('/'); }

function posixAbs(p) {
  if (process.platform === 'win32') {
    const drive = /^([A-Za-z]):[\\/](.*)$/.exec(p);
    if (drive) return `/${drive[1].toLowerCase()}/${posixPath(drive[2])}`;
  }
  return posixPath(p);
}

function segmentRegex(segment) {
  let out = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const close = segment.indexOf(']', i + 1);
      if (close > i + 1) {
        let body = segment.slice(i + 1, close);
        if (body[0] === '!') body = '^' + body.slice(1);
        out += `[${body}]`;
        i = close;
      } else out += '\\[';
    }
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

function filePatternForms(pattern) {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let anchor = 'cwd', anchored = false, body = p;
  if (p.startsWith('//')) { anchor = 'abs'; body = p.slice(2).replace(/^\/+/, ''); }
  else if (p === '~' || p.startsWith('~/')) { anchor = 'home'; body = p === '~' ? '' : p.slice(2); }
  else if (p.startsWith('/')) { anchored = true; body = p.slice(1); }
  body = body.replace(/\/+$/, '');
  if (body === '') return { anchor, anchored, bare: true, singleDir: false, segs: [] };
  const segs = body.split('/');
  const bare = segs.length === 1;
  const first = segs[0];
  const singleDir = segs.length === 2 && !/[*\?\[]/.test(first);
  let regexes = [];
  if (bare) {
    // A bare filename (or a single-segment glob) matches at any depth;
    // `**` on its own matches any path.
    regexes = [segs[0] === '**' ? new RegExp('^.+$') : new RegExp(`^(.*/)?${segmentRegex(segs[0])}$`)];
  } else {
    let built = '';
    let i = 0;
    while (i < segs.length) {
      if (segs[i] === '**') {
        if (i === segs.length - 1) {
          const base = built; // ends with '/'
          regexes = [new RegExp(`^${base}.+$`), new RegExp(`^${base.slice(0, -1)}$`)];
          break;
        }
        built += '(?:[^/]+/)*';
      } else {
        built += segmentRegex(segs[i]);
        if (i < segs.length - 1) built += '/';
      }
      i++;
    }
    if (!regexes.length) regexes = [new RegExp(`^${built}$`)];
  }
  const widened = regexes.map(re => new RegExp(`^(.*/)?${re.source.slice(1)}`));
  return { anchor, anchored, bare, singleDir, regexes, widened };
}

export function filePatternMatches(pattern, file, cwd, kind) {
  const forms = filePatternForms(pattern);
  if (!forms.regexes.length) return false;
  const resolved = path.resolve(file);
  const candidates = [];
  if (forms.anchor === 'abs') {
    candidates.push(posixAbs(resolved).replace(/^\//, ''));
  } else if (forms.anchor === 'home') {
    const home = path.resolve(os.homedir());
    if (resolved === home) candidates.push('');
    else if (resolved.startsWith(home + path.sep)) candidates.push(posixPath(path.relative(home, resolved)));
  } else {
    const base = path.resolve(cwd);
    if (resolved === base) candidates.push('');
    else if (resolved.startsWith(base + path.sep)) candidates.push(posixPath(path.relative(base, resolved)));
  }
  for (const candidate of candidates) {
    if (forms.regexes.some(re => re.test(candidate))) return true;
    if (kind !== 'allow' && forms.singleDir && !forms.anchored && candidate) {
      if (forms.widened.some(re => re.test(candidate))) return true;
    }
  }
  return false;
}

// Native schema: an Edit(path) rule also covers Write; a Write(path) rule is
// this project's documented extension and applies to Write only. Read rules
// apply to Read only (a Read deny also blocks edit/write in native, which we
// leave to explicit rules and document as a remaining difference).
function toolFamilyMatches(name, tool) {
  const n = name.toLowerCase();
  if (n === 'edit') return tool === 'Edit' || tool === 'Write';
  if (n === 'read') return tool === 'Read';
  return name === tool;
}

function fileRuleMatches(name, tool, pattern, input, cwd, kind) {
  const n = name.toLowerCase();
  if (tool === 'Edit' && n !== 'edit') return false;
  if (tool === 'Write' && n !== 'edit' && n !== 'write') return false;
  if (tool === 'Read' && n !== 'read') return false;
  const file = input?.file_path;
  if (typeof file !== 'string' || !file) return false;
  return filePatternMatches(pattern, file, cwd, kind);
}

// kind: 'allow' → whole-command coverage; 'deny'/'ask' → statement match.
export function matchesRule(rule, tool, input, cwd, kind = 'deny') {
  const parsed = /^([^()]+)(?:\((.*)\))?$/s.exec(rule);
  if (!parsed) return false;
  const [, name, pattern] = parsed;
  // An Edit rule targets the whole file-editing family (Edit and Write);
  // a Write rule (project extension) targets Write only.
  if (name.includes('*')) {
    if (!glob(name, tool)) return false;
  } else if (!toolFamilyMatches(name, tool)) return false;
  if (pattern === undefined) return true;
  if (name.includes('*')) return tool === 'Bash' && bashMatches(pattern, input, cwd, kind);
  if (tool === 'Bash') return bashMatches(pattern, input, cwd, kind);
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write') return fileRuleMatches(name, tool, pattern, input, cwd, kind);
  return false;
}
