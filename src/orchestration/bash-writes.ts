import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { outsideWorkspaceAdvice, type WriteRoot } from "./ownership.js";

/**
 * Best-effort STATIC check of the obvious write targets of a worker bash command, so that bash and the file tools
 * (ownership.ts) follow the same policy where we can see it: writes inside the workspace are not this module's concern,
 * a scratch root is writable by every role, an extra `root` only by writing roles, and /dev/null, /dev/stdout,
 * /dev/stderr, /dev/tty and /dev/fd/N are always fine. Any other LITERAL target outside the workspace is blocked.
 *
 * This is NOT a sandbox. Only literal targets (no `$`, backtick, glob, brace or `~user`) of output redirections,
 * tee, touch, mkdir, rm/rmdir, cp/mv/install, ln, sed -i/perl -i, chmod/chown/chgrp, truncate and `dd of=` are seen;
 * dynamic or unparseable commands, interpreters (`python -c`, `bash -c`, scripts), other programs that write files and
 * relative targets after a dynamic `cd` are allowed.
 */
export type BashWritesVerdict = { allowed: true } | { allowed: false; reason: string; targets: string[] };

type Word = { text: string; dynamic: boolean };
/** `group` marks a subshell boundary `(` / `)` (no words): a `cd` inside does not outlive it. */
type Command = { words: Word[]; redirects: { op: string; target: Word }[]; group?: "(" | ")" };

const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>", ">&"]);
const KEYWORDS = new Set(["!", "if", "then", "else", "elif", "do", "while", "until", "time", "{", "}", "fi", "done", "esac", "coproc"]);
const DEVICES = /^\/dev\/(null|stdout|stderr|stdin|tty|fd\/\d+)$/;

/** Lenient shell tokenizer: commands with quote-removed words and redirections; undefined when unparseable. */
function tokenize(command: string, home: string): Command[] | undefined {
  const commands: Command[] = [];
  let current: Command = { words: [], redirects: [] };
  let text = "", started = false, dynamic = false, quoted = false;
  let redirect: string | undefined;
  const heredocs: { delimiter: string; strip: boolean }[] = [];
  const n = command.length;

  const finishWord = () => {
    if (!started) return;
    const word = { text, dynamic };
    if (redirect !== undefined) {
      if (redirect === "<<" || redirect === "<<-") heredocs.push({ delimiter: text, strip: redirect === "<<-" });
      else if (WRITE_REDIRECTS.has(redirect)) {
        // `>&2`, `2>&1`, `>&-`: descriptor duplication, not a file.
        if (!(redirect === ">&" && /^(\d+-?|-)$/.test(text))) current.redirects.push({ op: redirect, target: word });
      }
      redirect = undefined;
    } else current.words.push(word);
    text = ""; started = dynamic = quoted = false;
  };
  const finishCommand = () => {
    finishWord();
    redirect = undefined;
    if (current.words.length || current.redirects.length) commands.push(current);
    current = { words: [], redirects: [] };
  };
  /** Index after the `close` matching an opening at `i` (exclusive of nested quotes), or -1. */
  const skipBalanced = (i: number, open: string, close: string): number => {
    let depth = 0;
    for (; i < n; i++) {
      const c = command[i]!;
      if (c === "\\") { i++; continue; }
      if (c === "'") { const end = command.indexOf("'", i + 1); if (end < 0) return -1; i = end; continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return i + 1;
    }
    return -1;
  };
  const inTest = () => current.words[0]?.text === "[[" && !current.words.some(word => word.text === "]]");

  for (let i = 0; i < n;) {
    const ch = command[i]!;
    if (ch === "\n") {
      finishCommand();
      i++;
      // Skip the bodies of heredocs started on this line.
      while (heredocs.length) {
        const { delimiter, strip } = heredocs.shift()!;
        for (;;) {
          if (i >= n) break;
          const end = command.indexOf("\n", i);
          const line = command.slice(i, end < 0 ? n : end);
          i = end < 0 ? n : end + 1;
          if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) break;
        }
      }
      continue;
    }
    if (ch === "#" && !started) {
      while (i < n && command[i] !== "\n") i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") { finishWord(); i++; continue; }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return undefined;
      text += command.slice(i + 1, end); started = quoted = true; i = end + 1;
      continue;
    }
    if (ch === '"') {
      started = quoted = true; i++;
      let closed = false;
      while (i < n) {
        const c = command[i]!;
        if (c === '"') { closed = true; i++; break; }
        if (c === "\\" && i + 1 < n) {
          const next = command[i + 1]!;
          if (next !== "\n") text += '\\$`"'.includes(next) ? next : `\\${next}`;
          i += 2; continue;
        }
        if (c === "$" && command[i + 1] === "(") {
          const end = skipBalanced(i + 1, "(", ")");
          if (end < 0) return undefined;
          dynamic = true; text += command.slice(i, end); i = end; continue;
        }
        if (c === "`") {
          const end = command.indexOf("`", i + 1);
          if (end < 0) return undefined;
          dynamic = true; text += command.slice(i, end + 1); i = end + 1; continue;
        }
        if (c === "$") dynamic = true;
        text += c; i++;
      }
      if (!closed) return undefined;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= n) return undefined;
      if (command[i + 1] !== "\n") { text += command[i + 1]; started = quoted = true; }
      i += 2; continue;
    }
    if (ch === "$") {
      dynamic = started = true;
      const next = command[i + 1];
      if (next === "(" || next === "{") {
        const end = skipBalanced(i + 1, next, next === "(" ? ")" : "}");
        if (end < 0) return undefined;
        text += command.slice(i, end); i = end; continue;
      }
      if (next === "'") {
        let j = i + 2;
        while (j < n && command[j] !== "'") j += command[j] === "\\" ? 2 : 1;
        if (j >= n) return undefined;
        text += command.slice(i, j + 1); i = j + 1; continue;
      }
      text += ch; i++; continue;
    }
    if (ch === "`") {
      const end = command.indexOf("`", i + 1);
      if (end < 0) return undefined;
      dynamic = started = true; text += command.slice(i, end + 1); i = end + 1; continue;
    }
    if (ch === "(" && !started && current.words.length === 0 && command[i + 1] === "(") {
      // Arithmetic command (( ... )): no redirections inside.
      const end = command.indexOf("))", i + 2);
      if (end < 0) return undefined;
      finishCommand(); i = end + 2; continue;
    }
    if ((ch === "<" || ch === ">") && inTest()) { finishWord(); current.words.push({ text: ch, dynamic: false }); i++; continue; }
    if (ch === "<" || ch === ">" || (ch === "&" && command[i + 1] === ">")) {
      if (command[i + 1] === "(" && ch !== "&") { finishWord(); i++; continue; } // process substitution: `(` separates the inner command
      // A leading descriptor number (`2>`) is not a word of the command.
      if (started && !quoted && !dynamic && /^\d+$/.test(text)) { text = ""; started = false; }
      finishWord();
      let op: string;
      if (ch === "&") op = command[i + 2] === ">" ? "&>>" : "&>";
      else if (ch === ">") op = command[i + 1] === ">" ? ">>" : command[i + 1] === "|" ? ">|" : command[i + 1] === "&" ? ">&" : ">";
      else op = command.startsWith("<<<", i) ? "<<<" : command.startsWith("<<-", i) ? "<<-" : command[i + 1] === "<" ? "<<" : command[i + 1] === ">" ? "<>" : command[i + 1] === "&" ? "<&" : "<";
      redirect = op; i += op.length;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")") {
      finishCommand();
      if (ch === "(" || ch === ")") commands.push({ words: [], redirects: [], group: ch });
      i += (ch === "&" && command[i + 1] === "&") || (ch === "|" && (command[i + 1] === "|" || command[i + 1] === "&")) || (ch === ";" && command[i + 1] === ";") ? 2 : 1;
      continue;
    }
    if (ch === "~" && !started) {
      const next = command[i + 1];
      if (next === undefined || next === "/" || " \t\n;|&<>()".includes(next)) { text += home; started = true; i++; continue; }
      dynamic = true;
    }
    if ("*?[{~".includes(ch) && !(ch === "{" && !started && " \t\n".includes(command[i + 1] ?? " "))) dynamic = true;
    text += ch; started = true; i++;
  }
  finishCommand();
  return commands;
}

type Parsed = { operands: Word[]; options: { name: string; value?: Word }[] };
/**
 * GNU-style option parsing: `--` ends options, `-abc` bundles, short letters in `valued` take the rest of the argument or
 * the next one, letters in `attached` take only the rest of the argument, `long` options take `=value` or the next word.
 */
function parseArgs(args: readonly Word[], valued = "", long: readonly string[] = [], attached = ""): Parsed {
  const result: Parsed = { operands: [], options: [] };
  let literal = false;
  for (let k = 0; k < args.length; k++) {
    const arg = args[k]!;
    if (literal || arg.dynamic || !arg.text.startsWith("-") || arg.text === "-") { result.operands.push(arg); continue; }
    if (arg.text === "--") { literal = true; continue; }
    if (arg.text.startsWith("--")) {
      const eq = arg.text.indexOf("=");
      const name = eq < 0 ? arg.text : arg.text.slice(0, eq);
      if (eq >= 0) result.options.push({ name, value: { text: arg.text.slice(eq + 1), dynamic: false } });
      else if (long.includes(name) && k + 1 < args.length) result.options.push({ name, value: args[++k]! });
      else result.options.push({ name });
      continue;
    }
    for (let c = 1; c < arg.text.length; c++) {
      const letter = arg.text[c]!, rest = arg.text.slice(c + 1);
      if (valued.includes(letter)) {
        const value = rest ? { text: rest, dynamic: false } : args[k + 1];
        if (!rest) k++;
        result.options.push({ name: `-${letter}`, ...(value ? { value } : {}) });
        break;
      }
      if (attached.includes(letter)) { result.options.push({ name: `-${letter}`, value: { text: rest, dynamic: false } }); break; }
      result.options.push({ name: `-${letter}` });
    }
  }
  return result;
}
const option = (parsed: Parsed, ...names: string[]) => parsed.options.find(o => names.includes(o.name));

/** Skip a wrapper's options (`sudo -u x`, `env -i A=b`, `timeout 5`, ...) and return the index of the wrapped command. */
const WRAPPERS: Record<string, { valued: string; long?: string[]; positional?: number }> = {
  sudo: { valued: "ugCDhprtU", long: ["--user", "--group", "--chdir", "--host", "--prompt", "--role", "--type", "--other-user", "--close-from"] },
  doas: { valued: "uC" },
  env: { valued: "uSC", long: ["--unset", "--chdir", "--split-string"] },
  nohup: { valued: "" }, command: { valued: "" }, builtin: { valued: "" }, exec: { valued: "a" },
  nice: { valued: "n", long: ["--adjustment"] },
  stdbuf: { valued: "ioe", long: ["--input", "--output", "--error"] },
  timeout: { valued: "ks", long: ["--kill-after", "--signal"], positional: 1 },
  xargs: { valued: "IiLlnPsdEa", long: ["--max-args", "--max-procs", "--max-chars", "--delimiter", "--arg-file", "--max-lines", "--replace", "--eof"] },
};
function commandStart(words: readonly Word[]): number {
  let i = 0;
  for (;;) {
    const word = words[i];
    if (!word) return i;
    if (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(word.text)) { i++; continue; }
    if (KEYWORDS.has(word.text) && !word.dynamic) { i++; continue; }
    const wrapper = !word.dynamic ? WRAPPERS[basename(word.text)] : undefined;
    if (!wrapper) return i;
    i++;
    while (i < words.length && words[i]!.text.startsWith("-") && !words[i]!.dynamic) {
      const text = words[i]!.text;
      i++;
      if (text === "--") break;
      if (text.startsWith("--") ? !text.includes("=") && (wrapper.long ?? []).includes(text) : text.length === 2 && wrapper.valued.includes(text[1]!)) i++;
    }
    if (basename(word.text) === "env") while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!.text)) i++;
    i += wrapper.positional ?? 0;
  }
}

/** Literal write targets of one command (its redirections plus the file operands of known writing commands). */
function commandTargets(cmd: Command): Word[] {
  const targets = cmd.redirects.map(r => r.target);
  const start = commandStart(cmd.words);
  const head = cmd.words[start];
  if (!head || head.dynamic) return targets;
  const name = basename(head.text), args = cmd.words.slice(start + 1);
  const destination = (parsed: Parsed): Word[] => {
    const dir = option(parsed, "-t", "--target-directory");
    if (dir) return dir.value ? [dir.value] : [];
    return parsed.operands.length >= 2 ? [parsed.operands.at(-1)!] : [];
  };
  switch (name) {
    case "tee": targets.push(...parseArgs(args).operands); break;
    case "touch": targets.push(...parseArgs(args, "rdt", ["--reference", "--date"]).operands); break;
    case "mkdir": targets.push(...parseArgs(args, "m", ["--mode"]).operands); break;
    case "rm": case "rmdir": case "unlink": case "shred": targets.push(...parseArgs(args, name === "shred" ? "ns" : "", name === "shred" ? ["--iterations", "--size", "--random-source"] : []).operands); break;
    case "truncate": targets.push(...parseArgs(args, "rs", ["--reference", "--size"]).operands); break;
    case "cp": case "mv": case "ln": targets.push(...destination(parseArgs(args, "tS", ["--target-directory", "--suffix", "--sparse", "--no-preserve"]))); break;
    case "install": {
      const parsed = parseArgs(args, "gmoSt", ["--group", "--mode", "--owner", "--suffix", "--target-directory", "--strip-program"]);
      targets.push(...(option(parsed, "-d", "--directory") ? parsed.operands : destination(parsed)));
      break;
    }
    case "sed": {
      const parsed = parseArgs(args, "efl", ["--expression", "--file", "--line-length"], "i");
      if (!option(parsed, "-i", "--in-place")) break;
      targets.push(...parsed.operands.slice(option(parsed, "-e", "-f", "--expression", "--file") ? 0 : 1));
      break;
    }
    case "perl": {
      // Perl switches: -i[ext] and -e/-E CODE; other value-taking switches keep the rest of their argument.
      let inPlace = false, script = false, k = 0;
      for (; k < args.length; k++) {
        const arg = args[k]!;
        if (arg.dynamic || !arg.text.startsWith("-") || arg.text === "-") break;
        if (arg.text === "--") { k++; break; }
        for (let c = 1; c < arg.text.length; c++) {
          const letter = arg.text[c]!;
          if (letter === "e" || letter === "E") { script = true; if (c + 1 === arg.text.length) k++; break; }
          if (letter === "i") { inPlace = true; break; }
          if ("IMmxdDF0lCV".includes(letter)) break;
        }
      }
      if (inPlace) targets.push(...args.slice(k + (script ? 0 : 1)));
      break;
    }
    case "chmod": {
      const options = args.filter(a => !a.dynamic && (/^-[RcfvHLP]+$/.test(a.text) || a.text.startsWith("--")));
      const operands = args.filter(a => !options.includes(a));
      targets.push(...operands.slice(options.some(o => o.text.startsWith("--reference=")) ? 0 : 1));
      break;
    }
    case "chown": case "chgrp": {
      const parsed = parseArgs(args);
      targets.push(...parsed.operands.slice(option(parsed, "--reference") ? 0 : 1));
      break;
    }
    case "dd":
      for (const arg of args) if (arg.text.startsWith("of=")) targets.push({ text: arg.text.slice(3), dynamic: arg.dynamic });
      break;
  }
  return targets;
}

function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return !rel || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
}

/**
 * Check the literal write targets of a worker bash command against the workspace (`cwd`) and the extra write roots.
 * `readOnly` roles may write only their scratch roots outside the workspace. Never throws.
 */
export function checkBashWrites(command: string, options: { cwd: string; roots: readonly WriteRoot[]; readOnly: boolean }): BashWritesVerdict {
  if (typeof command !== "string" || !command.trim()) return { allowed: true };
  const home = process.env.HOME || homedir();
  const commands = tokenize(command, home);
  if (!commands) return { allowed: true };
  const workspace = resolve(options.cwd);
  const roots = options.roots.filter(root => isAbsolute(root.path));
  const blocked: string[] = [];
  let readOnlyRoot: string | undefined;
  // Effective directory for relative targets; undefined after a cd we cannot follow.
  let dir: string | undefined = workspace;
  const saved: (string | undefined)[] = [];
  for (const cmd of commands) {
    if (cmd.group === "(") { saved.push(dir); continue; }
    if (cmd.group === ")") { if (saved.length) dir = saved.pop(); continue; }
    for (const target of commandTargets(cmd)) {
      if (target.dynamic || !target.text) continue;
      if (DEVICES.test(target.text)) continue;
      if (!isAbsolute(target.text) && dir === undefined) continue;
      const path = resolve(dir ?? workspace, target.text);
      if (inside(workspace, path)) continue;
      const matching = roots.filter(root => inside(resolve(root.path), path));
      if (matching.some(root => root.kind === "scratch" || !options.readOnly)) continue;
      if (matching.length) readOnlyRoot ??= matching[0]!.path;
      if (!blocked.includes(path)) blocked.push(path);
    }
    const start = commandStart(cmd.words), head = cmd.words[start];
    if (head && !head.dynamic && (head.text === "cd" || head.text === "pushd")) {
      const arg = cmd.words.slice(start + 1).find(word => word.dynamic || !word.text.startsWith("-") || word.text === "-");
      if (!arg) dir = head.text === "cd" ? home : undefined;
      else if (arg.dynamic || arg.text === "-") dir = undefined;
      else dir = isAbsolute(arg.text) ? resolve(arg.text) : dir === undefined ? undefined : resolve(dir, arg.text);
    } else if (head && !head.dynamic && head.text === "popd") dir = undefined;
  }
  if (!blocked.length) return { allowed: true };
  const readOnlyText = readOnlyRoot ? ` ${readOnlyRoot} is an extra write root, but this assignment is read-only: only the scratch directory is writable.` : "";
  return {
    allowed: false,
    targets: blocked,
    reason: `Blocked: this bash command writes outside the workspace (${blocked.join(", ")}).${readOnlyText} ${outsideWorkspaceAdvice(blocked[0]!, roots)}`,
  };
}
