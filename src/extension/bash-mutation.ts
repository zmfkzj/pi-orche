/**
 * Which Bash invocations the safety review (bash-review.ts) looks at: those that write or plausibly mutate something. A best-effort
 * static reading of the command text, separate from the main-mode permission policy (bash-policy.ts), which answers a different
 * question (what main may run itself while delegating).
 *
 * Read-only, so not reviewed: commands from a fixed list of pure readers and queries (ls, cat, grep, rg, find without actions,
 * git status/log/diff and other read subcommands, sed/awk without in-place or file-writing commands, curl without upload or
 * output file, ...), any command run with only `--version` or `--help`, plain assignments and shell builtins without file effects,
 * through wrappers such as sudo, env, timeout, nice or xargs, in pipelines, lists and subshells, with variables, globs, `~` and
 * command or process substitutions (whose inner commands are judged the same way), redirections from files, here-documents and
 * redirections to /dev/null, /dev/stdout, /dev/stderr or another descriptor.
 *
 * Everything else may write and is reviewed: redirections to files, writing commands (rm, mv, cp, tee, mkdir, chmod, ...), writing
 * options of the readers above (find -delete/-exec, sed -i, sort -o, git branch -d, curl -o or -d, ...), every program the list does
 * not know (interpreters, shells, build tools, package managers and their scripts such as npm test or make, test runners,
 * compilers, formatters, docker, ssh, ...), a command name built from a variable or substitution, `eval`, `source`, `trap`, and any
 * text this reader cannot follow. It never runs anything and cannot see what scripts or programs do inside.
 */

interface Word {
  /** The word with quotes removed and expansions kept as written. */
  text: string;
  /** Contains a parameter expansion or a command, arithmetic or process substitution. */
  dynamic: boolean;
  /** Contains an unquoted glob character. */
  glob: boolean;
  /** Contains any quoting. */
  quoted: boolean;
  /** Starts like `NAME=` or `NAME+=` before any quoting or expansion. */
  assignment: boolean;
}
interface Segment { words: Word[]; redirects: { op: string; target: Word }[] }
interface Parsed { segments: Segment[]; inner: string[] }

const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
const HARMLESS_TARGET = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

/** Capture from the `(` at `open` to its matching `)`, honouring quotes; [inner text, index after `)`]. */
function captureParen(src: string, open: number): [string, number] | undefined {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (c === "'") { const end = src.indexOf("'", i + 1); if (end < 0) return undefined; i = end; continue; }
    if (c === "\"") {
      for (i++; i < src.length && src[i] !== "\""; i++) if (src[i] === "\\") i++;
      if (i >= src.length) return undefined;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return [src.slice(open + 1, i), i + 1];
  }
  return undefined;
}

/** Split shell text into simple commands; undefined when it cannot be followed (unbalanced quotes, a dangling redirection, ...). */
function parse(src: string): Parsed | undefined {
  const segments: Segment[] = [];
  const inner: string[] = [];
  let current: Segment = { words: [], redirects: [] };
  let word: Word | undefined;
  let pending: string | undefined;
  const heredocs: { delimiter: string; strip: boolean; quoted: boolean }[] = [];
  let heredocNext: { strip: boolean } | undefined;
  const start = (): Word => (word ??= { text: "", dynamic: false, glob: false, quoted: false, assignment: false });
  const flush = (): boolean => {
    if (!word) return true;
    const done = word;
    word = undefined;
    if (heredocNext) { heredocs.push({ delimiter: done.text, strip: heredocNext.strip, quoted: done.quoted }); heredocNext = undefined; return true; }
    if (pending) { current.redirects.push({ op: pending, target: done }); pending = undefined; return true; }
    current.words.push(done);
    return true;
  };
  const end = (): boolean => {
    flush();
    if (pending || heredocNext) return false;
    if (current.words.length || current.redirects.length) segments.push(current);
    current = { words: [], redirects: [] };
    return true;
  };
  /** `$(`, `<(`, `>(` or `$((` at i (the `(` at i+1): record the inner command; returns the index after `)`. */
  const substitution = (i: number): number | undefined => {
    const captured = captureParen(src, i + 1);
    if (!captured) return undefined;
    const w = start();
    w.dynamic = true;
    w.text += src.slice(i, captured[1]);
    // `$((...))` is arithmetic: no command inside.
    if (!(src[i] === "$" && src[i + 2] === "(")) inner.push(captured[0]);
    return captured[1];
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\" && src[i + 1] === "\n") { i += 2; continue; }
    if (c === " " || c === "\t") { flush(); i++; continue; }
    if (c === "\n") {
      if (!end()) return undefined;
      i++;
      // Here-document bodies are data. An unquoted delimiter expands substitutions in the body: those count as inner commands.
      for (const doc of heredocs.splice(0)) {
        for (;;) {
          if (i >= src.length) return undefined;
          const eol = src.indexOf("\n", i);
          const line = src.slice(i, eol < 0 ? src.length : eol);
          i = eol < 0 ? src.length : eol + 1;
          if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
          if (!doc.quoted && /\$\(|`/.test(line)) return undefined;
        }
      }
      continue;
    }
    if (c === "#" && !word) { const eol = src.indexOf("\n", i); i = eol < 0 ? src.length : eol; continue; }
    if (c === "&" && src[i + 1] === ">") {
      flush();
      pending = src[i + 2] === ">" ? "&>>" : "&>";
      i += pending.length;
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      if (!end()) return undefined;
      i++;
      continue;
    }
    if (c === "<" || c === ">") {
      if (src[i + 1] === "(") { const next = substitution(i); if (next === undefined) return undefined; i = next; continue; }
      // A leading descriptor number (`2>`) belongs to the operator.
      if (word && /^\d+$/.test(word.text) && !word.quoted && !word.dynamic) word = undefined;
      else flush();
      if (pending || heredocNext) return undefined;
      if (src.startsWith("<<<", i)) { pending = "<<<"; i += 3; continue; }
      if (src.startsWith("<<", i)) { i += 2; const strip = src[i] === "-"; if (strip) i++; heredocNext = { strip }; continue; }
      const two = src.slice(i, i + 2);
      const op = [">>", ">|", ">&", "<>", "<&"].includes(two) ? two : c;
      pending = op;
      i += op.length;
      continue;
    }
    if (c === "'") {
      const close = src.indexOf("'", i + 1);
      if (close < 0) return undefined;
      const w = start();
      w.quoted = true;
      w.text += src.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (c === "\"") {
      const w = start();
      w.quoted = true;
      i++;
      for (;;) {
        if (i >= src.length) return undefined;
        const d = src[i]!;
        if (d === "\"") { i++; break; }
        if (d === "\\") { w.text += src[i + 1] ?? ""; i += 2; continue; }
        if (d === "$" && src[i + 1] === "(") { const next = substitution(i); if (next === undefined) return undefined; i = next; continue; }
        if (d === "`") {
          const close = src.indexOf("`", i + 1);
          if (close < 0) return undefined;
          inner.push(src.slice(i + 1, close));
          w.dynamic = true; w.text += src.slice(i, close + 1); i = close + 1; continue;
        }
        if (d === "$" && /[A-Za-z_0-9@*#?$!{-]/.test(src[i + 1] ?? "")) w.dynamic = true;
        w.text += d;
        i++;
      }
      continue;
    }
    if (c === "$" && src[i + 1] === "(") { const next = substitution(i); if (next === undefined) return undefined; i = next; continue; }
    if (c === "`") {
      const close = src.indexOf("`", i + 1);
      if (close < 0) return undefined;
      inner.push(src.slice(i + 1, close));
      const w = start(); w.dynamic = true; w.text += src.slice(i, close + 1); i = close + 1; continue;
    }
    if (c === "\\") { const w = start(); w.quoted = true; w.text += src[i + 1] ?? ""; i += 2; continue; }
    const w = start();
    if (c === "$" && /[A-Za-z_0-9@*#?$!{-]/.test(src[i + 1] ?? "")) w.dynamic = true;
    if (c === "*" || c === "?" || c === "[") w.glob = true;
    if (c === "=" && !w.quoted && !w.dynamic && /^[A-Za-z_][A-Za-z0-9_]*\+?$/.test(w.text)) w.assignment = true;
    w.text += c;
    i++;
  }
  if (!end() || heredocs.length) return undefined;
  return { segments, inner };
}

/** Shell keywords that open a compound command: the command proper follows them. */
const KEYWORDS = new Set(["!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "{", "}", "time"]);
/** Segments that are syntax rather than a command run on arguments (`for x in ...`, `function f`, `case x in`, `esac`). */
const SYNTAX = new Set(["for", "select", "function", "case", "esac", "in"]);

/** Read-only whatever their arguments (only their own exec-like options are checked, see EXEC_LIKE). */
const READERS = new Set((
  "ls cat tac head tail wc grep egrep fgrep zgrep zcat bzcat xzcat rg ag ack fd tree pwd echo printf true false : cd pushd popd dirs "
  + "cut tr diff cmp comm paste join fold fmt rev nl column expand unexpand seq yes stat file which whereis type basename dirname realpath "
  + "readlink du df jq md5sum sha1sum sha224sum sha256sum sha384sum sha512sum b2sum cksum base64 base32 od hexdump strings test [ [[ uname "
  + "whoami id groups hostname printenv locale tty getent uptime free nproc lscpu lsblk ps pgrep pidof lsof ss netstat ping dig nslookup "
  + "host less more man cal sleep wait read export unset set shopt local declare typeset readonly let shift return exit break continue "
  + "umask ulimit jobs hash bat expr bc locate date sort uniq xxd yq tee awk gawk mawk nawk sed find curl wget git"
).split(" "));
/** Options that make a reader run another program. */
const EXEC_LIKE = /^--(pre|exec|exec-batch|hostname-bin|open-files-in-pager|pager)(=|$)/;
const FIND_ACTIONS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

const SYSTEM_BIN = /^\/(usr\/(local\/)?)?s?bin\/[^/]+$/;
const commandName = (word: Word): string => SYSTEM_BIN.test(word.text) ? word.text.slice(word.text.lastIndexOf("/") + 1) : word.text;

/** Short-option cluster check: does `-abc` (not `--long`) contain one of `letters`? */
const hasShort = (args: readonly string[], letters: string) => args.some(arg => /^-[^-]/.test(arg) && [...arg.slice(1)].some(letter => letters.includes(letter)));
const hasLong = (args: readonly string[], names: readonly string[]) => args.some(arg => names.some(name => arg === name || arg.startsWith(`${name}=`)));
const positionals = (args: readonly string[], valued = ""): string[] => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") { out.push(...args.slice(i + 1)); break; }
    if (/^-[^-]/.test(arg)) { const last = arg[arg.length - 1]!; if (arg.length === 2 && valued.includes(last)) i++; continue; }
    if (arg.startsWith("--")) continue;
    out.push(arg);
  }
  return out;
};

/** The command after a wrapper's own options; undefined when the wrapper runs nothing (it then only reads). */
function unwrap(name: string, args: readonly Word[]): readonly Word[] | "opaque" | undefined {
  const texts = args.map(arg => arg.text);
  let i = 0;
  const skipOptions = (valued: string, longValued: readonly string[] = []) => {
    while (i < texts.length) {
      const arg = texts[i]!;
      if (arg === "--") { i++; return; }
      if (!arg.startsWith("-") || arg === "-") return;
      if (longValued.includes(arg)) i += 2;
      else if (/^-[^-]$/.test(arg) && valued.includes(arg[1]!)) i += 2;
      else i++;
    }
  };
  switch (name) {
    case "sudo": case "doas":
      if (hasShort(texts.filter(arg => /^-[^-]/.test(arg)), "sieE") || hasLong(texts, ["--shell", "--login", "--edit"])) return "opaque";
      skipOptions("ugCDhprtTU", ["--user", "--group", "--chdir", "--host", "--prompt", "--role", "--type", "--other-user", "--close-from"]);
      break;
    case "env":
      if (hasShort(texts, "S") || hasLong(texts, ["--split-string"])) return "opaque";
      for (;;) {
        skipOptions("uC", ["--unset", "--chdir"]);
        if (i < texts.length && args[i]!.assignment) { i++; continue; }
        break;
      }
      break;
    case "nice": skipOptions("n", ["--adjustment"]); break;
    case "ionice": skipOptions("cnp", ["--class", "--classdata", "--pid"]); break;
    case "timeout": skipOptions("sk", ["--signal", "--kill-after"]); i++; break;
    case "stdbuf": skipOptions("ioe", ["--input", "--output", "--error"]); break;
    case "nohup": case "time": case "builtin": case "exec": skipOptions("a"); break;
    case "command":
      if (hasShort(texts, "vV")) return undefined;
      skipOptions("");
      break;
    case "xargs":
      skipOptions("IiLlnPdEesa", ["--replace", "--max-lines", "--max-args", "--max-procs", "--delimiter", "--eof", "--max-chars", "--arg-file", "--process-slot-var"]);
      break;
    default: return args;
  }
  return i < args.length ? args.slice(i) : undefined;
}
const WRAPPERS = new Set(["sudo", "doas", "env", "nice", "ionice", "timeout", "stdbuf", "nohup", "time", "builtin", "exec", "command", "xargs"]);

const GIT_READ = new Set((
  "status diff log show rev-parse rev-list ls-files ls-tree blame grep shortlog describe cat-file name-rev merge-base diff-tree diff-index "
  + "diff-files show-ref for-each-ref whatchanged check-ignore check-attr count-objects ls-remote var version help cherry range-diff show-branch"
).split(" "));
const GIT_GLOBAL_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
function gitMayWrite(args: readonly string[]): boolean {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += GIT_GLOBAL_VALUED.has(args[i]!) ? 2 : 1;
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined) return false;
  if (hasLong(rest, ["--output"])) return true;
  const first = positionals(rest)[0];
  const flagsOnly = rest.every(arg => arg.startsWith("-"));
  switch (sub) {
    case "branch":
      if (hasShort(rest, "dDmMcCuf") || hasLong(rest, ["--delete", "--move", "--copy", "--force", "--set-upstream-to", "--unset-upstream", "--edit-description", "--track", "--no-track"])) return true;
      return !(flagsOnly || hasShort(rest, "l") || hasLong(rest, ["--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--format", "--sort"]));
    case "tag":
      if (hasShort(rest, "dfasumF") || hasLong(rest, ["--delete", "--force", "--annotate", "--sign", "--local-user", "--message", "--file"])) return true;
      return !(flagsOnly || hasShort(rest, "l") || hasLong(rest, ["--list", "--contains", "--points-at", "--merged", "--no-merged"]));
    case "remote": return !(flagsOnly || first === "show" || first === "get-url");
    case "stash": return !(first === "list" || first === "show");
    case "worktree": return first !== "list";
    case "submodule": return !(flagsOnly || first === "status" || first === "summary");
    case "notes": return !(first === "list" || first === "show");
    case "reflog": return first === "expire" || first === "delete" || first === "drop";
    case "config":
      if (hasLong(rest, ["--unset", "--unset-all", "--add", "--replace-all", "--rename-section", "--remove-section", "--edit"]) || hasShort(rest, "e")) return true;
      if (first === "get" || first === "list" || hasLong(rest, ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "--get-color", "--get-colorbool"]) || hasShort(rest, "l")) return false;
      return positionals(rest, "f").length !== 1;
    default: return !GIT_READ.has(sub);
  }
}

function sedMayWrite(args: readonly string[]): boolean {
  if (hasLong(args, ["--in-place", "--file"]) || hasShort(args.filter(arg => /^-[^-]/.test(arg) && arg !== "-e"), "iIf")) return true;
  const scripts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-e" || args[i] === "--expression") scripts.push(args[++i] ?? "");
    else if (args[i]!.startsWith("--expression=")) scripts.push(args[i]!.slice(13));
  }
  if (!scripts.length) { const first = positionals(args, "l")[0]; if (first !== undefined) scripts.push(first); }
  return scripts.some(script => /(^|[;{}\n/0-9$])[gpIiMm0-9]*\s*[wWe](\s|;|$)/.test(script));
}
function awkMayWrite(args: readonly string[]): boolean {
  if (hasShort(args, "if") || hasLong(args, ["--include", "--file", "--exec"])) return true;
  const program = positionals(args, "vF")[0] ?? "";
  return /system\s*\(|\bprintf?\b[^;}\n]*(>|\|)|\|\s*getline|\bclose\s*\(/.test(program);
}
function curlMayWrite(args: readonly string[]): boolean {
  if (hasLong(args, ["--output", "--remote-name", "--remote-name-all", "--upload-file", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--form", "--form-string", "--json", "--config", "--cookie-jar", "--dump-header", "--trace", "--trace-ascii", "--libcurl", "--stderr", "--output-dir", "--create-dirs"])) return true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--request" || arg.startsWith("--request=")) {
      const method = arg.includes("=") ? arg.slice(10) : args[i + 1] ?? "";
      if (!/^(GET|HEAD)$/i.test(method)) return true;
    }
    if (!/^-[^-]/.test(arg)) continue;
    for (let k = 1; k < arg.length; k++) {
      const letter = arg[k]!;
      if ("oOTdFcDK".includes(letter)) return true;
      if (letter === "X") { const method = arg.slice(k + 1) || args[i + 1] || ""; if (!/^(GET|HEAD)$/i.test(method)) return true; break; }
      if ("HAeuxmwbEykrtUzQYCP".includes(letter)) break;
    }
  }
  return false;
}

/** Does this one command (name and arguments, wrappers followed) plausibly write? */
function commandMayWrite(words: readonly Word[]): boolean {
  const head = words[0];
  if (!head) return false;
  // `[` and `[[` (test) are glob characters only by spelling.
  if (head.dynamic || (head.glob && !/^\[\[?$/.test(head.text))) return true;
  const name = commandName(head);
  const rest = words.slice(1);
  const args = rest.map(word => word.text);
  if (args.length === 1 && (args[0] === "--version" || args[0] === "--help")) return false;
  if (WRAPPERS.has(name)) {
    const inner = unwrap(name, rest);
    if (inner === "opaque") return true;
    return inner ? commandMayWrite(inner) : false;
  }
  if (!READERS.has(name)) return true;
  if (args.some(arg => EXEC_LIKE.test(arg))) return true;
  switch (name) {
    case "find": return args.some(arg => FIND_ACTIONS.has(arg));
    case "fd": return hasShort(args, "xX");
    case "tee": return positionals(args).some(path => !HARMLESS_TARGET.test(path));
    case "sort": return hasShort(args, "o") || hasLong(args, ["--output"]);
    case "uniq": return positionals(args, "fsw").length > 1;
    case "xxd": return positionals(args, "cglosn").length > 1;
    case "tree": return hasShort(args, "o");
    case "date": return hasShort(args, "s") || hasLong(args, ["--set"]);
    case "hostname": return positionals(args).length > 0 || hasShort(args, "F") || hasLong(args, ["--file"]);
    case "file": return hasShort(args, "C") || hasLong(args, ["--compile"]);
    case "yq": return hasShort(args, "i") || hasLong(args, ["--inplace"]);
    case "sed": return sedMayWrite(args);
    case "awk": case "gawk": case "mawk": case "nawk": return awkMayWrite(args);
    case "curl": return curlMayWrite(args);
    case "wget": return !(args.includes("--spider") || args.some((arg, k) => /^-q?O-$/.test(arg) || arg === "--output-document=-" || (/^-q?O$/.test(arg) && args[k + 1] === "-")));
    case "git": return gitMayWrite(args);
    default: return false;
  }
}

function segmentMayWrite(segment: Segment): boolean {
  for (const { op, target } of segment.redirects) {
    if (op === ">&" && /^(\d+|-)$/.test(target.text)) continue;
    if (WRITE_REDIRECTS.has(op) || op === ">&") {
      if (target.dynamic || target.glob || !HARMLESS_TARGET.test(target.text)) return true;
    }
  }
  let words = segment.words;
  while (words[0] && !words[0].quoted && KEYWORDS.has(words[0].text)) words = words.slice(1);
  while (words[0]?.assignment) words = words.slice(1);
  if (!words.length) return false;
  if (!words[0]!.quoted && SYNTAX.has(words[0]!.text)) return false;
  return commandMayWrite(words);
}

/** True when the command writes or plausibly mutates something (see the module comment); false only for recognised reads. */
export function bashMayWrite(command: string, depth = 0): boolean {
  if (depth > 8) return true;
  const parsed = parse(command);
  if (!parsed) return true;
  return parsed.segments.some(segmentMayWrite) || parsed.inner.some(text => bashMayWrite(text, depth + 1));
}
