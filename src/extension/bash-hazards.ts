/**
 * Static accident check of the Bash safety review (bash-review.ts), next to Jev: a non-executing reading of the command text
 * (the parser of bash-mutation.ts) for a few destructive commands whose target can be read from the text. It never runs, expands
 * or rehearses anything, and it does not see the environment.
 *
 * Known facts it uses: literal paths, `~`, `$HOME` (the reviewing process's home), the tool's cwd, and variables assigned a literal
 * (including an empty one, `DIR=` or `DIR=''`) unconditionally earlier in the same command (at the top level, after `;` or a newline,
 * not inside if/while/for/case or after `&&`, `||`, `|` or `(`). Everything else is unknown: a variable not assigned in the command
 * may be inherited from the environment, so it is never taken as empty; conditional assignments, `cd` and `$PWD` after a `cd`
 * are approximations.
 *
 * Commands looked at: `rm`, `mv` (its sources), `chmod`/`chown`/`chgrp -R`, `find ... -delete` or `-exec rm`, through wrappers
 * (sudo, env, timeout, ...), in lists, pipelines, subshells, command substitutions and `bash -c` / `sh -c` scripts.
 *
 * - **block** (the command does not run and Jev is not asked; the agent rewrites it): from known facts alone, the target is the
 *   filesystem root, a top-level system directory (/usr, /etc, /var, /home, ...), the whole home directory, or their contents
 *   (`/*`, `~/*`). Examples: `rm -rf ~`, `rm -rf /*`, `sudo rm -rf /usr`, `DIR=''; rm -rf "$DIR/"*`, `mv ~ /tmp/x`, `chmod -R 777 /`,
 *   `find / -delete`, `rm -rf *` with the tool's cwd at home. A recursive chmod/chown of the home directory and a `find` with name
 *   or path filters only warn.
 * - **warn** (passed to Jev as `staticFindings`, which decides): such a target that depends on an unknown value (`rm -rf "$DIR/"*`
 *   with DIR from the environment, a relative target after `cd ~`), the whole working directory or one of its parents, or a path
 *   produced by a command substitution.
 *
 * Everything else (other commands, paths inside a project, /tmp, ssh remote commands, scripts and programs) gets no finding and
 * is left to Jev. Not a proof of safety: a command with no finding can still be destructive.
 */
import { posix } from "node:path";
import { commandName, KEYWORDS, parse, SYNTAX, unwrap, WRAPPERS, type Word } from "./bash-mutation.js";

export interface BashHazard { level: "block" | "warn"; message: string }
export interface BashHazardContext { cwd: string; home: string }

const SYSTEM_DIRS = new Set(["/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64", "/libx32", "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/usr", "/var"]);
const FIND_FILTERS = /^-(i?name|i?path|i?wholename|i?regex|i?lname|newer\w*|[amc](time|min)|size|user|group|uid|gid|perm|empty|links|inum|samefile|nouser|nogroup|prune)$/;
const SHELLS = new Set(["bash", "sh", "dash", "zsh", "ksh"]);
const VARIABLE = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*|[0-9])\}|([A-Za-z_][A-Za-z0-9_]*|[0-9]))(\/.*)?$/;

/**
 * What a target word can be said to point at. `unknownVar`: only that path if this variable (unknown here) is empty;
 * `emptyVar`: a variable proven empty in this command made it so; `afterCd`: resolved against a cwd from a `cd`.
 */
interface Resolved { path: string; contents: boolean; unknownVar?: string; emptyVar?: string; afterCd?: boolean }
/** `vars`: a string is a known value (possibly empty), undefined an assignment whose value is unknown. `nest`: if/loop/case depth. */
interface State { cwd: string | undefined; cwdFromCd: boolean; vars: Map<string, string | undefined>; context: BashHazardContext; out: BashHazard[]; depth: number; nest: number }

const describe = (path: string, home: string) => path === "/" ? "the filesystem root" : path === home ? "your whole home directory" : `the system directory ${path}`;
const shown = (word: Word) => word.text.length > 60 ? `${word.text.slice(0, 57)}...` : word.text;

/** Strip a trailing `/*`, `/.*`, `*` or `.*` (all contents; only when the `*` is an unquoted glob) and normalize; undefined for other globs. */
function contentsOf(path: string, glob: boolean): { path: string; contents: boolean } | undefined {
  let contents = false;
  let base = path;
  const match = glob ? /^(.*?)(?:^|\/)\.?\*$/.exec(base) : null;
  if (match) { contents = true; base = match[1] === "" && path.startsWith("/") ? "/" : match[1] || "."; }
  if (/[*?[]/.test(base)) return undefined;
  return { path: base, contents };
}
const normal = (path: string) => { const out = posix.normalize(path); return out.length > 1 ? out.replace(/\/+$/, "") : out; };

function resolve(word: Word, state: State): Resolved | "substitution" | undefined {
  const { home } = state.context;
  let text = word.text;
  let unknownVar: string | undefined;
  let emptyVar: string | undefined;
  let afterCd = false;
  if (word.tilde) {
    if (!/^~(\/|$)/.test(text)) return undefined;
    text = home + text.slice(1);
  } else if (word.dynamic) {
    if (/^(\$\(|`)/.test(text)) return "substitution";
    const variable = VARIABLE.exec(text);
    if (!variable) return undefined;
    const name = (variable[1] ?? variable[2])!;
    const rest = variable[3] ?? "";
    if (name === "HOME") text = home + rest;
    else if (name === "PWD") { if (!state.cwd) return undefined; text = state.cwd + rest; afterCd = state.cwdFromCd; }
    else {
      const value = state.vars.get(name);
      if (value === undefined) {
        // Unknown: not assigned here (maybe inherited from the environment) or assigned something not known statically.
        if (!rest) return undefined;
        unknownVar = name;
        text = rest;
      } else {
        if (value === "") emptyVar = name;
        text = value + rest;
      }
    }
  }
  const base = contentsOf(text, word.glob);
  if (!base) return undefined;
  if (!base.path.startsWith("/")) {
    if (!state.cwd) return undefined;
    base.path = posix.join(state.cwd, base.path);
    afterCd ||= state.cwdFromCd;
  }
  return { path: normal(base.path), contents: base.contents, ...(unknownVar ? { unknownVar } : {}), ...(emptyVar ? { emptyVar } : {}), ...(afterCd ? { afterCd } : {}) };
}

/**
 * Findings for one target of a destructive command. `strong`: deleting or moving (vs a recursive chmod/chown). `filtered`: a
 * `find` with name/path filters, so only a critical target is mentioned, as a warning.
 */
function judge(command: string, word: Word, state: State, strong: boolean, filtered = false): void {
  const { home } = state.context;
  const target = resolve(word, state);
  const add = (level: BashHazard["level"], message: string): void => { state.out.push({ level, message }); };
  if (target === "substitution") return add("warn", `${command} target ${shown(word)} comes from a command substitution; if it prints nothing or something unexpected the target changes`);
  if (!target) return;
  const what = `${target.contents ? "everything in " : ""}${describe(target.path, home)}`;
  const critical = SYSTEM_DIRS.has(target.path) || target.path === home;
  if (critical) {
    // Block only on known facts; a target that depends on an unknown value or a `cd` is a warning for Jev.
    const level = (target.path === home && !strong) || filtered || target.unknownVar || target.afterCd ? "warn" : "block";
    if (target.unknownVar) return add(level, `${command} ${shown(word)}: if $${target.unknownVar} is empty or unset the target is ${what} (its value is not known here: it may come from the environment or a conditional assignment)`);
    if (target.emptyVar) return add(level, `${command} ${shown(word)}: $${target.emptyVar} is assigned an empty value in this command, so the target is ${what}`);
    if (target.afterCd) return add(level, `${command} ${shown(word)} targets ${what} if the preceding cd succeeds`);
    return add(level, `${command} ${shown(word)} targets ${what}`);
  }
  if (target.unknownVar || !state.cwd || filtered) return;
  if (target.path === state.cwd) return add("warn", `${command} ${shown(word)} targets ${target.contents ? "everything in " : ""}the whole working directory ${state.cwd}`);
  if (state.cwd.startsWith(`${target.path}/`)) add("warn", `${command} ${shown(word)} targets ${target.contents ? "everything in " : ""}${target.path}, a parent of the working directory`);
}

const operands = (words: readonly Word[]): Word[] => {
  const out: Word[] = [];
  let options = true;
  for (const word of words) {
    if (options && word.text === "--" && !word.quoted) { options = false; continue; }
    if (options && word.text.startsWith("-") && word.text.length > 1 && !word.dynamic) continue;
    out.push(word);
  }
  return out;
};

function command(words: readonly Word[], state: State): void {
  const head = words[0];
  if (!head || head.dynamic) return;
  const name = commandName(head);
  const rest = words.slice(1);
  const texts = rest.map(word => word.text);
  if (WRAPPERS.has(name)) {
    const inner = unwrap(name, rest);
    // `env -C dir` / `sudo -D dir` run the command elsewhere: relative targets are then unknown.
    const chdir = (name === "env" && texts.some(text => /^(-C|--chdir)/.test(text))) || ((name === "sudo" || name === "doas") && texts.some(text => /^(-D|--chdir)/.test(text)));
    if (inner && inner !== "opaque") command(inner, chdir ? { ...state, cwd: undefined } : state);
    return;
  }
  if (SHELLS.has(name)) {
    const flag = texts.findIndex(text => /^-[a-z]*c[a-z]*$/.test(text));
    const script = flag >= 0 ? rest[flag + 1] : undefined;
    // The child shell sees only exported variables: its variables are unknown here.
    if (script) scan(script.text, { ...state, vars: new Map(), depth: state.depth + 1, nest: 0 });
    return;
  }
  const recursive = texts.some(text => /^-[a-zA-Z]*R/.test(text) || text === "--recursive");
  switch (name) {
    case "rm": for (const word of operands(rest)) judge("rm", word, state, true); return;
    case "mv": {
      const targetDir = texts.some(text => text === "-t" || /^--target-directory/.test(text));
      const all = operands(rest);
      for (const word of targetDir ? all.filter(word => word.text !== rest[texts.indexOf("-t") + 1]?.text) : all.slice(0, -1)) judge("mv", word, state, true);
      return;
    }
    case "chmod": case "chown": case "chgrp": {
      if (!recursive) return;
      const all = operands(rest);
      for (const word of texts.some(text => text.startsWith("--reference")) ? all : all.slice(1)) judge(`${name} -R`, word, state, false);
      return;
    }
    case "find": {
      const destructive = texts.includes("-delete") || texts.some((text, k) => ["-exec", "-execdir", "-ok", "-okdir"].includes(text) && /^(\/(usr\/)?bin\/)?(rm|shred|unlink)$/.test(texts[k + 1] ?? ""));
      if (!destructive) return;
      const roots: Word[] = [];
      for (const word of rest) {
        if (["-H", "-L", "-P"].includes(word.text) && !roots.length) continue;
        if (/^[-(!]/.test(word.text)) break;
        roots.push(word);
      }
      const filtered = texts.some(text => FIND_FILTERS.test(text));
      for (const root of roots.length ? roots : [{ text: ".", dynamic: false, glob: false, quoted: false, assignment: false }]) judge("find -delete", root, state, true, filtered);
      return;
    }
    case "cd": case "pushd": {
      const target = operands(rest)[0];
      state.cwdFromCd = true;
      if (!target) { state.cwd = state.context.home; return; }
      const resolved = target.text === "-" ? undefined : resolve(target, state);
      state.cwd = resolved && typeof resolved === "object" && !resolved.contents && !resolved.unknownVar ? resolved.path : undefined;
      return;
    }
    case "popd": state.cwd = undefined; return;
    default: return;
  }
}

function scan(text: string, state: State): void {
  if (state.depth > 8) return;
  const parsed = parse(text);
  if (!parsed) return;
  for (const segment of parsed.segments) {
    let words = segment.words;
    for (; words[0] && !words[0].quoted && KEYWORDS.has(words[0].text); words = words.slice(1)) {
      if (["if", "while", "until"].includes(words[0].text)) state.nest++;
      else if (["fi", "done"].includes(words[0].text)) state.nest = Math.max(0, state.nest - 1);
    }
    const first = words[0];
    // An assignment is a known fact only when it surely runs before what follows: top level, after `;`, a newline or the start.
    const unconditional = state.nest === 0 && ["", ";", "\n"].includes(segment.after ?? "");
    const assign = (word: Word) => {
      const eq = word.text.indexOf("=");
      const value = word.text.slice(eq + 1);
      state.vars.set(word.text.slice(0, eq).replace(/\+$/, ""), unconditional && !word.dynamic && !word.text.slice(0, eq).endsWith("+") ? value : undefined);
    };
    if (first && !first.quoted && SYNTAX.has(first.text)) {
      if (["for", "select", "case"].includes(first.text)) state.nest++;
      else if (first.text === "esac") state.nest = Math.max(0, state.nest - 1);
      // `for NAME in a b c`: NAME is never empty when every item is a non-empty literal (taken as its first item).
      if (first.text === "for" && words[1] && words[2]?.text === "in") state.vars.set(words[1].text, undefined);
      if (first.text === "for" && words[1] && words[2]?.text === "in" && words.slice(3).length && words.slice(3).every(word => word.text && !word.dynamic && !word.glob)) state.vars.set(words[1].text, words[3]!.text);
      continue;
    }
    let k = 0;
    for (; words[k]?.assignment; k++) {
      // Only a standalone assignment sets the variable for later commands (`X=1 cmd` does not change cmd's expansions).
      if (words.every(word => word.assignment)) assign(words[k]!);
    }
    if (first?.text === "export" || first?.text === "local" || first?.text === "declare" || first?.text === "readonly") {
      for (const word of words.slice(1)) {
        const eq = word.text.indexOf("=");
        if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word.text.slice(0, eq))) assign(word);
      }
      continue;
    }
    command(words.slice(k), state);
  }
  // Substitutions are scanned after the whole list, so they get no variable facts and no cwd from a cd (either could come later).
  for (const inner of parsed.inner) scan(inner, { ...state, vars: new Map(), cwd: state.cwdFromCd ? undefined : state.cwd, depth: state.depth + 1, nest: 0 });
}

/** Static findings for a Bash command (see the module comment); empty when nothing is recognised. Never executes anything. */
export function findBashHazards(command: string, context: BashHazardContext): BashHazard[] {
  const state: State = { cwd: normal(context.cwd), cwdFromCd: false, vars: new Map(), context: { cwd: normal(context.cwd), home: normal(context.home) }, out: [], depth: 0, nest: 0 };
  scan(command, state);
  const seen = new Set<string>();
  return state.out.filter(hazard => !seen.has(hazard.message) && seen.add(hazard.message));
}
