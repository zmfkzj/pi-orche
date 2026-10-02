/** Habitual-edit guard, NOT a sandbox. Inspection commands and trusted project checks
 * are allowed; checks execute project code and may produce caches/reports.
 * This bounded Bash subset rejects active expansions (command/arithmetic/process substitution,
 * braces, variables) and validates complete static redirection targets. Exceptions: a leading
 * `~`/`~/` (a static $HOME prefix), unquoted globs as arguments of commands whose every option
 * is read-only (see GLOB_SAFE), and a single double-quoted `$NAME` in `test -n|-z` / `[ -n|-z ]`.
 * It does not contain project scripts, Git configuration, or tool configuration.
 */
/** Optional structured hint on a blocked verdict, for building a concrete suggestion. */
export type BashHint =
  | { kind: "expansion" }
  | { kind: "leading-option"; tool: string; option?: string }
  | { kind: "git-subcommand"; subcommand?: string };
export type BashVerdict = { allowed: true } | { allowed: false; reason: string; category?: "mutation" | "unsupported"; hint?: BashHint };
type Issue = { reason: string; category: "mutation" | "unsupported"; hint?: BashHint };
/** glob: index in text of the first unquoted glob char. variable: NAME of a standalone "$NAME". */
type Word = { text: string; assignmentPrefixStatic: boolean; glob?: number; variable?: string };
const unsupported = (reason: string, hint?: BashHint): Issue => hint ? { reason, category: "unsupported", hint } : { reason, category: "unsupported" };
const mutation = (reason: string, hint?: BashHint): Issue => hint ? { reason, category: "mutation", hint } : { reason, category: "mutation" };
const GLOB_REASON = "active brace/glob/tilde expansion (quote literal patterns)";
const VAR_REASON = "active expansion or command substitution";
const expansion = (reason: string): Issue => unsupported(reason, { kind: "expansion" });
const INSPECTION = new Set("ls cat head tail wc grep egrep fgrep rg fd tree pwd echo printf true false cd sort uniq cut tr diff cmp stat file which type date basename dirname realpath readlink du df nl column jq md5sum sha1sum sha256sum test [ uname whoami id hostname printenv find".split(" "));
const RUNNERS = new Set(["tsc", "eslint", "ruff", "prettier", "jest", "vitest", "mocha", "pytest"]);
const SAFE_ENV = new Set(["CI", "NODE_ENV", "TZ", "NO_COLOR", "FORCE_COLOR"]);
const SCRIPT = /^(test|lint|typecheck|type-check|check)(:[\w:.-]+)?$/;

/** A whole word that is exactly one double-quoted simple variable: "$NAME". */
const SIMPLE_VAR = /"\$([A-Za-z_][A-Za-z0-9_]*)"(?![^ \t\n;|&<>])/y;
/** No expansion evaluation. Quote removal happens only here, before option parsing. Globs and "$NAME" words are only FLAGGED here; expansionIssue() decides per command. */
function tokenize(command: string): { segments: Word[][] } | Issue {
  const segments: Word[][] = [];
  let words: Word[] = [], word = "", started = false, quoted = false, assignmentPrefixStatic = true;
  let glob = -1, variable: string | undefined;
  let redirect: { op: string; fd: string } | undefined;
  let required = false;
  const endWord = (): Issue | undefined => {
    if (!started) return;
    if (redirect) {
      // Ambiguous/unknown redirect targets are never accepted, whatever the command.
      if (glob >= 0 || variable !== undefined) return expansion(variable !== undefined ? VAR_REASON : GLOB_REASON);
      const { op, fd } = redirect;
      if (op === ">" || op === ">>" || op === "&>" || op === "&>>") {
        if (word !== "/dev/null") return mutation("output redirection outside static /dev/null");
      } else if (op === ">&") {
        if (fd !== "2" || word !== "1" || quoted) return unsupported("unsupported file descriptor redirection (only 2>&1)");
      } else if (op !== "<") return unsupported("unsupported redirection");
      redirect = undefined;
    } else words.push({ text: word, assignmentPrefixStatic, ...(glob >= 0 ? { glob } : {}), ...(variable !== undefined ? { variable } : {}) });
    word = ""; started = quoted = false; assignmentPrefixStatic = true; glob = -1; variable = undefined;
  };
  const endSegment = (): Issue | undefined => {
    const issue = endWord();
    if (issue) return issue;
    if (redirect) return unsupported("missing redirection target");
    if (words.length) { segments.push(words); words = []; required = false; }
  };
  for (let i = 0; i < command.length;) {
    const ch = command[i]!;
    if (ch === "#" && !started) {
      while (i < command.length && command[i] !== "\n") i++;
      continue;
    }
    if (ch === '"' && !started) {
      SIMPLE_VAR.lastIndex = i;
      const m = SIMPLE_VAR.exec(command);
      if (m) { word = `$${m[1]}`; variable = m[1]; started = quoted = true; assignmentPrefixStatic = false; i += m[0].length; continue; }
    }
    if (ch === "'" || ch === '"') {
      if (!word.includes("=")) assignmentPrefixStatic = false;
      started = quoted = true;
      const quote = ch;
      i++;
      let closed = false;
      while (i < command.length) {
        const c = command[i]!;
        if (c === quote) { i++; closed = true; break; }
        if (quote === '"') {
          if (c === "$" || c === "`") return expansion(VAR_REASON);
          if (c === "\\") {
            const next = command[i + 1];
            if (next === undefined) return unsupported("unterminated quote");
            if (next === "\n") { i += 2; continue; }
            if ('\\$`"'.includes(next)) { word += next; i += 2; continue; }
            // Bash preserves a double-quoted backslash before any other character.
          }
        }
        word += c; i++;
      }
      if (!closed) return unsupported("unterminated quote");
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= command.length) return unsupported("trailing backslash");
      if (command[i + 1] !== "\n") {
        if (!word.includes("=")) assignmentPrefixStatic = false;
        word += command[i + 1]; started = quoted = true;
      }
      i += 2; continue;
    }
    if (ch === " " || ch === "\t") {
      const issue = endWord(); if (issue) return issue;
      i++; continue;
    }
    if (ch === "\n" || ch === ";" || ch === "|" || (ch === "&" && command[i + 1] === "&")) {
      const chain = ch === "|" || ch === "&";
      const hadCommand = words.length > 0 || (started && !redirect);
      const issue = endSegment(); if (issue) return issue;
      if ((chain || ch === ";") && !hadCommand) return unsupported("missing command in chain");
      if (ch !== "\n") required = chain;
      i += (ch === "|" && command[i + 1] === "|") || ch === "&" ? 2 : 1;
      continue;
    }
    if (ch === "<" || ch === ">" || (ch === "&" && command[i + 1] === ">")) {
      if (redirect) return unsupported("missing redirection target");
      if (command[i + 1] === "(" || (ch === "<" && ["<", "&", ">"].includes(command[i + 1] ?? ""))) return unsupported("heredoc or process substitution / unsupported redirection");
      let fd = "";
      if (started && !quoted && /^\d+$/.test(word)) { fd = word; word = ""; started = false; }
      const issue = endWord(); if (issue) return issue;
      if (fd && !["0", "1", "2"].includes(fd)) return unsupported("unsupported file descriptor");
      let op = ch; i++;
      if (ch === "&") { op += ">"; i++; }
      if (command[i] === ">" && op.endsWith(">")) { op += ">"; i++; }
      else if (command[i] === "&" && op === ">") { op += "&"; i++; }
      redirect = { op, fd }; continue;
    }
    if (ch === "&") return unsupported("background job");
    if (ch === "(" || ch === ")") return unsupported("subshell or process substitution");
    if (ch === "$" || ch === "`") return expansion(VAR_REASON);
    if (ch === "{" || ch === "}") return expansion(GLOB_REASON);
    if (ch === "~") {
      // A leading unquoted `~` or `~/...` is a deterministic $HOME prefix. `~user`, `~+`, `~-` and a non-leading `~` stay unsupported.
      const next = command[i + 1];
      if (started || !(next === undefined || next === "/" || " \t\n;|&<>".includes(next))) return expansion(GLOB_REASON);
      word += ch; started = true; i++; continue;
    }
    if ("*?[]".includes(ch)) { if (glob < 0) glob = word.length; word += ch; started = true; i++; continue; }
    if (ch === "\r" || ch === "\0") return unsupported("unsupported control character");
    word += ch; started = true; i++;
  }
  const issue = endSegment();
  if (issue) return issue;
  if (required) return unsupported("missing command in chain");
  if (!segments.length) return unsupported("empty command");
  return { segments };
}

// Option checks stop at --. Forwarded project-check flags intentionally do NOT.
const VALUE_OPTIONS: Record<string, string[]> = {
  tsc: ["-p", "--project", "--target", "-t", "--module", "-m", "--lib", "--types", "--moduleResolution", "--jsx"],
  prettier: ["--config", "--ignore-path", "--parser", "--log-level", "--plugin", "--cache-location"],
  ruff: ["--config", "--target-version", "--output-format", "--output-file", "--select", "--ignore", "--extend-select", "--exclude", "--cache-dir"],
  eslint: ["--config", "-c", "--format", "-f", "--output-file", "-o", "--cache-location", "--parser", "--plugin", "--rule"],
  node: ["--test-reporter", "--test-reporter-destination", "--test-name-pattern", "--test-skip-pattern", "--test-concurrency", "--test-shard"],
  git: ["--format", "--pretty", "--date", "--author", "--grep", "--max-count", "-n", "-O", "--order-file", "--skip", "--since", "--until"],
  sort: ["-k", "--key", "-t", "--field-separator", "-T", "--temporary-directory", "-S", "--buffer-size"],
  file: ["-m", "--magic-file", "-f", "--files-from", "-e", "--exclude", "--exclude-quiet", "-P", "--parameter", "-F", "--separator"],
  date: ["-d", "--date", "-f", "--file", "-r", "--reference"],
  tree: ["-L", "-P", "-I", "--charset", "--timefmt", "--sort"],
};
function options(args: readonly string[], tool = ""): string[] {
  const result: string[] = [];
  const values = VALUE_OPTIONS[tool] ?? [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    result.push(arg);
    // A value equal to -- is not the end-of-options delimiter.
    if (values.includes(arg)) i++;
  }
  return result;
}
const long = (arg: string, names: readonly string[]) => names.some(name => arg === name || arg.startsWith(`${name}=`));
function short(arg: string, letters: string, valueLetters = ""): boolean {
  if (!/^-[^-]/.test(arg)) return false;
  for (const c of arg.slice(1)) {
    if (letters.includes(c)) return true;
    // The rest of a value-taking short option is data, not bundled flags.
    if (valueLetters.includes(c)) break;
  }
  return false;
}
const writeFlag = (arg: string) => long(arg, ["--fix", "--write", "--update", "--updateSnapshot", "--update-snapshots", "--update-snapshot", "--add-noqa"]) || short(arg, "uw");

function checkTool(tool: string, args: readonly string[]): Issue | undefined {
  const opts = options(args, tool);
  if (args.length === 1 && ["--version", "-v", "--help", "-h"].includes(args[0]!)) return;
  if (["vitest", "jest", "pytest", "mocha"].includes(tool)) {
    if (opts.some(writeFlag)) return mutation(`${tool} snapshot update / source modification flag`);
    if (tool === "vitest" && opts.some(a => long(a, ["--coverage.thresholds.autoUpdate"]))) return mutation("vitest coverage threshold configuration update");
    if (opts.some(a => long(a, ["--require", "--import", "--loader", "--eval", "--setupFiles", "--setupFilesAfterEnv", ...(tool === "vitest" ? ["--coverage.customProviderModule"] : [])]) || (tool === "mocha" && short(a, "r")))) return unsupported(`${tool} execution injection option`);
    return;
  }
  if (tool === "tsc") {
    if (opts.some(a => long(a.toLowerCase(), ["--init", "--build", "--emitdeclarationonly", "--out", "--outfile", "--outdir", "--declarationdir"]) || a === "-b")) return mutation("tsc deliberate emit/init option");
    // TypeScript rejects =true/=false; boolean values are separate arguments.
    if (opts.some(a => /^--noemit=/i.test(a))) return unsupported("tsc --noEmit=value is not accepted; use --noEmit or --noEmit true");
    const flags = opts.filter(a => /^--noemit$/i.test(a));
    if (flags.length !== 1) return mutation("tsc without --noEmit (or repeated/overriding flag)");
    const next = opts[opts.indexOf(flags[0]!) + 1];
    if (next === "false") return mutation("tsc --noEmit false");
    return;
  }
  if (tool === "eslint") return opts.some(a => long(a, ["--fix"])) ? mutation("eslint --fix") : undefined;
  if (tool === "ruff") {
    if (opts.some(a => long(a, ["--fix", "--fix-only", "--add-noqa", "--unsafe-fixes"]))) return mutation("ruff source modification flag");
    if (args[0] === "check") return;
    if (args[0] === "format" && opts.some(a => ["--check", "--diff"].includes(a))) return;
    return ["format", "clean"].includes(args[0] ?? "") ? mutation("ruff format write mode / clean") : unsupported("unverified ruff subcommand");
  }
  if (tool === "prettier") {
    if (opts.some(a => long(a, ["--write"]) || short(a, "w"))) return mutation("prettier --write");
    if (opts.some(a => ["--check", "--list-different"].includes(a) || short(a, "cl"))) return;
    return unsupported("prettier without --check: unverified invocation");
  }
  return unsupported(`unverified check tool ${tool}`);
}

const GIT_READ_PLAIN = "status diff log show rev-parse rev-list ls-files ls-tree blame grep shortlog describe cat-file name-rev merge-base diff-tree show-ref for-each-ref whatchanged check-ignore count-objects".split(" ");
/** Git subcommands usable read-only from the main session (some only in a read form: branch/tag list, stash list/show, config get, submodule status, ...). */
export const READ_ONLY_GIT_SUBCOMMANDS: readonly string[] = [
  "status", "diff", "log", "show", "branch", "tag", "blame", "grep", "ls-files", "ls-tree", "ls-remote", "rev-parse", "rev-list", "describe",
  "shortlog", "cat-file", "name-rev", "merge-base", "diff-tree", "show-ref", "for-each-ref", "whatchanged", "check-ignore", "count-objects",
  "reflog", "worktree", "remote", "bundle", "fsck", "stash", "config", "submodule", "help",
];
/** `git <builtin> -h|--help` only prints usage/man page. Unknown names could be aliases or external `git-<name>` programs, so they are not covered. */
const GIT_BUILTINS = new Set("add am archive bisect blame branch bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick clean clone column commit commit-graph commit-tree config count-objects credential describe diff diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id grep hash-object help hook index-pack init interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-redundant pack-refs patch-id prune prune-packed pull push range-diff read-tree rebase receive-pack reflog refs remote repack replace replay rerere reset restore rev-list rev-parse revert rm send-pack shortlog show show-branch show-index show-ref sparse-checkout stash status stripspace submodule switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info upload-archive upload-pack var verify-commit verify-pack verify-tag version whatchanged worktree write-tree".split(" "));

/** `git help [topic]`: -w/--web (browser) and -i/--info are not accepted. */
function gitHelpReadOnly(rest: readonly string[]): boolean {
  const flags = ["-a", "--all", "-g", "--guides", "-c", "--config", "-m", "--man", "--verbose", "--no-verbose", "--external-commands", "--no-external-commands", "--aliases", "--no-aliases", "--user-interfaces", "--developer-interfaces"];
  let topics = 0;
  return rest.every(a => flags.includes(a) || (!a.startsWith("-") && ++topics <= 1));
}

/** Branch list mode only. Positional names are accepted only together with an explicit --list (they are patterns then). */
function gitBranchReadOnly(rest: readonly string[]): boolean {
  const flags = ["-a", "-r", "-v", "-vv", "--show-current", "--all", "--remotes"];
  const required = ["--points-at", "--format", "--sort"], optional = ["--contains", "--no-contains", "--merged", "--no-merged"];
  let listing = false, positionals = 0;
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k]!;
    if (flags.includes(a)) continue;
    if (a === "--list") { listing = true; continue; }
    if (/^--[a-z-]+=/.test(a) && [...required, ...optional].includes(a.split("=")[0]!)) continue;
    // Mirrors git's parser: a required value is the next argument whatever it looks like; an optional one only when it is not an option.
    if (required.includes(a)) { if (k + 1 >= rest.length) return false; k++; continue; }
    if (optional.includes(a)) { if (rest[k + 1] !== undefined && !rest[k + 1]!.startsWith("-")) k++; continue; }
    if (a.startsWith("-")) return false; // -d -D -m -M -c -C -u --set-upstream* --unset-upstream --edit-description ...
    positionals++;
  }
  return positionals === 0 || listing;
}

/** Option whitelist (no abbreviations): --upload-pack/--exec/-u run a program. A `<transport>::<address>` remote can too. */
function gitLsRemoteReadOnly(rest: readonly string[]): boolean {
  const flags = ["-q", "--quiet", "-t", "--tags", "-h", "--heads", "--refs", "--get-url", "--symref", "--exit-code"];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k]!;
    if (flags.includes(a) || /^--(sort|server-option)=./.test(a)) continue;
    if (["--sort", "--server-option", "-o"].includes(a)) { if (k + 1 >= rest.length) return false; k++; continue; }
    if (a.startsWith("-") || a.includes("::")) return false;
  }
  return true;
}

/** `git submodule status|summary` with their read-only options; every other verb (foreach, update, init, sync, add, ...) is rejected. */
function gitSubmoduleReadOnly(rest: readonly string[]): boolean {
  const verb = rest[0];
  const flags = verb === "status" ? ["--cached", "--recursive", "-q", "--quiet"] : verb === "summary" ? ["--cached", "--files"] : undefined;
  if (!flags) return false;
  let literal = false;
  for (let k = 1; k < rest.length; k++) {
    const a = rest[k]!;
    if (literal || !a.startsWith("-")) continue; // paths / commit
    if (a === "--") { literal = true; continue; }
    if (flags.includes(a)) continue;
    if (verb === "summary") {
      if (/^--summary-limit=\d+$/.test(a) || /^-n\d+$/.test(a)) continue;
      if ((a === "-n" || a === "--summary-limit") && /^\d+$/.test(rest[k + 1] ?? "")) { k++; continue; }
    }
    return false;
  }
  return true;
}

/** Lookups only: read-only flags plus a --get/--get-all/--get-regexp/--list action anywhere, or no action and exactly one key. Write/edit/unset flags are simply not in the whitelist. */
function gitConfigReadOnly(rest: readonly string[]): boolean {
  const flags = ["--show-origin", "--show-scope", "--null", "-z", "--name-only", "--global", "--system", "--local", "--worktree", "--includes", "--no-includes"];
  let action: string | undefined, positionals = 0;
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k]!;
    if (flags.includes(a)) continue;
    if (["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(a)) { action = a; continue; }
    if (["--type", "--file", "-f"].includes(a)) { if (k + 1 >= rest.length) return false; k++; continue; }
    if (/^--(type|file)=./.test(a)) continue;
    if (a.startsWith("-")) return false;
    positionals++;
  }
  if (action === "--list" || action === "-l") return positionals === 0;
  return action ? positionals >= 1 && positionals <= 2 : positionals === 1; // key [value-pattern] / bare key; key + value is a write
}

function checkGit(args: readonly string[]): Issue | undefined {
  let i = 0;
  while (args[i]?.startsWith("-")) {
    const a = args[i]!;
    if (args.length === 1 && ["--version", "--help"].includes(a)) return;
    if (a === "-C" && args[i + 1]) { i += 2; continue; }
    if (["--no-pager", "-P"].includes(a) || /^--(git-dir|work-tree)=.+/.test(a)) { i++; continue; }
    return unsupported(`git option ${a}`, { kind: "leading-option", tool: "git", option: a });
  }
  const sub = args[i], rest = args.slice(i + 1), opts = options(rest, "git");
  const hint: BashHint = sub ? { kind: "git-subcommand", subcommand: sub } : { kind: "git-subcommand" };
  if (opts.some(a => long(a, ["--output"]))) return mutation(`git ${sub} --output`, hint);
  if (opts.some(a => long(a, ["--ext-diff", "--textconv"]) || (sub === "grep" && (short(a, "O") || long(a, ["--open-files-in-pager"]))))) return unsupported(`git ${sub} execution hook/pager option`, hint);
  if (sub && GIT_BUILTINS.has(sub) && rest.length === 1 && (rest[0] === "-h" || rest[0] === "--help")) return; // usage only; `git commit -h -m x` is NOT covered
  if (new Set(GIT_READ_PLAIN).has(sub ?? "")) return;
  if (sub === "help" && gitHelpReadOnly(rest)) return;
  if (sub === "ls-remote" && gitLsRemoteReadOnly(rest)) return;
  if (sub === "submodule" && gitSubmoduleReadOnly(rest)) return;
  if (sub === "reflog" && (!rest.length || rest[0] === "show" || rest[0]?.startsWith("-")) && !rest.some(a => ["expire", "delete", "--expire", "--expire-unreachable"].includes(a.split("=")[0]!))) return;
  if (sub === "worktree" && rest[0] === "list" && rest.slice(1).every(a => ["--porcelain", "-z", "-v"].includes(a))) return;
  if (sub === "remote" && rest.every(a => ["-v", "--verbose"].includes(a))) return;
  if (sub === "bundle" && ["verify", "list-heads"].includes(rest[0] ?? "")) return;
  if (sub === "fsck" && !opts.some(a => long(a, ["--lost-found"]))) return;
  if (sub === "branch" && gitBranchReadOnly(rest)) return;
  if (sub === "tag") {
    const listing = rest.some(a => a === "--list" || a === "-l");
    if (rest.every(a => ["-l", "--list", "-n"].includes(a) || (listing && !a.startsWith("-")))) return;
  }
  if (sub === "stash" && ["list", "show"].includes(rest[0] ?? "")) return;
  if (sub === "config" && gitConfigReadOnly(rest)) return;
  const writes = new Set("add commit checkout switch reset clean push pull fetch apply merge rebase cherry-pick restore init clone gc prune".split(" "));
  return writes.has(sub ?? "") ? mutation(`git ${sub}`, hint) : unsupported(`unverified git ${sub ?? "subcommand"}`, hint);
}

function checkScript(command: string, args: readonly string[]): Issue | undefined {
  if (args.length === 1 && ["--version", "-v", "--help", "-h"].includes(args[0]!)) return;
  let i = 0;
  // Runner-specific leading options only; no arbitrary option skipping.
  const safe = command === "npm" ? ["--silent", "--ignore-scripts"] : command === "pnpm" ? ["--silent", "--offline"] : command === "yarn" ? ["--silent", "--offline"] : ["--silent"];
  // Working-directory selection only (`cd <dir> && npm run x` is already accepted): the script check below still applies to the verb that follows.
  const dirOptions = command === "npm" ? ["--prefix"] : command === "pnpm" ? ["-C", "--dir"] : command === "yarn" ? ["--cwd"] : [];
  for (;;) {
    const a = args[i] ?? "", value = args[i + 1];
    if (safe.includes(a)) i++;
    else if (dirOptions.includes(a) && value !== undefined && value !== "" && !value.startsWith("-")) i += 2;
    else if (a.startsWith("--") && dirOptions.some(o => a.startsWith(`${o}=`) && a.length > o.length + 1)) i++;
    else break;
  }
  const verb = args[i];
  if (["install", "i", "add", "remove", "uninstall", "publish", "update", "upgrade"].includes(verb ?? "")) return mutation(`${command} ${verb}`);
  if (verb === "run" && args.length === i + 1) return; // script listing
  let script: string | undefined;
  if (["run", "run-script"].includes(verb ?? "")) script = args[++i];
  else if (["test", "t"].includes(verb ?? "")) script = "test";
  else if (["yarn", "pnpm", "bun"].includes(command)) script = verb;
  if (script && /(?:^|[:.-])(fix|write|update|format)(?:$|[:.-])/i.test(script)) return mutation(`${command} mutating script ${script}`);
  if (!script || !SCRIPT.test(script)) return unsupported(`${command} ${verb ?? ""}: unverified project command`, verb?.startsWith("-") ? { kind: "leading-option", tool: command, option: verb } : undefined);
  const forwarded = args.slice(i + 1);
  if (forwarded.some(a => writeFlag(a) || (command === "npm" && long(a, ["--coverage.thresholds.autoUpdate"])))) return mutation(`${command} forwarded update/fix/write flag`);
  if (forwarded.some(a => long(a, ["--eval", "--require", "--import", "--loader", "--experimental-loader", ...(command === "npm" ? ["--coverage.customProviderModule"] : [])]))) return unsupported(`${command} forwarded execution injection flag`);
  // Other options are trusted project-check arguments, not a guarantee of read-only execution.
}

function checkSegment(tokens: readonly Word[]): Issue | undefined {
  const words = tokens.map(word => word.text);
  let i = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) {
    if (!tokens[i]!.assignmentPrefixStatic) return unsupported("quoted or escaped environment assignment prefix / executable");
    const name = words[i]!.split("=")[0]!;
    if (!SAFE_ENV.has(name)) return unsupported(`environment assignment ${name}`);
    i++;
  }
  const first = words[i];
  if (!first) return unsupported("missing executable");
  const localRunner = first.startsWith("./node_modules/.bin/") ? first.slice("./node_modules/.bin/".length) : undefined;
  const command = localRunner && RUNNERS.has(localRunner) ? localRunner : first;
  const args = words.slice(i + 1), opts = options(args, command);
  if (command.includes("/")) return unsupported(`command path ${first}`);
  if (RUNNERS.has(command)) return checkTool(command, args);
  if (["npm", "pnpm", "yarn", "bun"].includes(command)) return checkScript(command, args);
  if (command === "git") return checkGit(args);
  if (command === "npx" || command === "bunx") {
    if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) return; // usage only
    const local = ["--no-install"];
    if (!local.includes(args[0] ?? "")) return unsupported(`${command} requires explicit local/no-install invocation`);
    let k = 0; while (local.includes(args[k] ?? "")) k++;
    const tool = args[k];
    if (!tool || !RUNNERS.has(tool)) return unsupported(`${command} unverified local runner/package spec`);
    return checkTool(tool, args.slice(k + 1));
  }
  if (command === "node") {
    if (args.length === 1 && ["--version", "-v", "--help", "-h"].includes(args[0]!)) return;
    if (opts.some(a => long(a, ["--import", "--require", "--eval", "--print", "--loader", "--experimental-loader", "--preload"]) || short(a, "rep"))) return unsupported("node other than --test: execution injection option");
    const testIndex = opts.indexOf("--test");
    const operandIndex = opts.findIndex(a => !a.startsWith("-"));
    return testIndex >= 0 && (operandIndex < 0 || testIndex < operandIndex) ? undefined : unsupported("node other than --test before script operands");
  }
  if (["python", "python3"].includes(command)) {
    if (args.length === 1 && ["--version", "-V", "--help", "-h"].includes(args[0]!)) return;
    if (args[0] === "-m" && ["pytest", "unittest"].includes(args[1] ?? "")) return checkTool("pytest", args.slice(2));
    return unsupported(`${command} other than -m pytest/unittest`);
  }
  if (command === "cargo") {
    if (args.length === 1 && ["--version", "-V", "--help", "-h"].includes(args[0]!)) return;
    if (opts.some(writeFlag)) return mutation("cargo source modification flag");
    if (["test", "check", "clippy"].includes(args[0] ?? "")) return;
    if (args[0] === "fmt" && opts.includes("--check")) return;
    return unsupported(`cargo ${args[0] ?? ""}`);
  }
  if (command === "go") {
    if ((args[0] === "version" && args.length === 1) || (args.length === 1 && ["--help", "-h"].includes(args[0]!))) return;
    if (opts.some(a => /^-{1,2}(exec|toolexec|vettool)(=|$)/.test(a))) return unsupported("go execution injection option");
    return ["test", "vet", "list"].includes(args[0] ?? "") ? undefined : unsupported(`go ${args[0] ?? ""}`);
  }
  if (!INSPECTION.has(command)) return new Set(["rm", "mv", "cp", "touch", "mkdir", "tee", "chmod", "chown", "truncate"]).has(command) ? mutation(`command ${command}`) : unsupported(`command ${command}`);
  if (command === "file" && opts.some(a => long(a, ["--compile"]) || short(a, "C", "mfePF"))) return mutation("file magic database compile");
  if (command === "printf" && opts.some(a => short(a, "v"))) return mutation("printf -v shell variable assignment");
  if (command === "hostname") {
    let literal = false;
    for (const arg of args) {
      if (!literal && arg === "--") { literal = true; continue; }
      if (literal || !arg.startsWith("-") || long(arg, ["--file"]) || short(arg, "F")) return mutation("hostname setter operand / file");
      if (!["-a", "--alias", "-A", "--all-fqdns", "-d", "--domain", "-f", "--fqdn", "--long", "-i", "--ip-address", "-I", "--all-ip-addresses", "-s", "--short", "-h", "--help", "-V", "--version"].includes(arg)) return unsupported("unverified hostname option");
    }
  }
  if (command === "find" && args.some(a => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls"].includes(a) || a.startsWith("-fprint"))) return mutation("find with an action");
  if (command === "sort" && opts.some(a => long(a, ["--output", "--compress-program"]) || short(a, "o", "ktTS"))) return mutation("sort -o / execution hook");
  if (command === "tree" && opts.some(a => short(a, "o", "LPI"))) return mutation("tree -o");
  if (command === "fd" && opts.some(a => long(a, ["--exec", "--exec-batch"]) || short(a, "xX"))) return unsupported("fd --exec");
  if (command === "rg" && opts.some(a => long(a, ["--pre", "--hostname-bin"]))) return unsupported("rg --pre / --hostname-bin execution hook");
  if (command === "date") {
    if (opts.some(a => long(a, ["--set"]) || short(a, "s", "dfr"))) return mutation("date --set");
    // GNU date also sets the clock with a numeric operand, including after --.
    let literal = false;
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!;
      if (!literal && a === "--") { literal = true; continue; }
      if (!literal && VALUE_OPTIONS.date!.includes(a)) { k++; continue; }
      if (/^\d{8}(?:\d{2}){0,2}(?:\.\d{2})?$/.test(a)) return mutation("date numeric clock-setting operand");
    }
  }
  if (command === "uniq") {
    let operands = 0, literal = false;
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!;
      if (!literal && a === "--") { literal = true; continue; }
      if (!literal && a.startsWith("-")) { if (["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"].includes(a)) k++; continue; }
      operands++;
    }
    if (operands > 1) return mutation("uniq with an output file");
  }
}

/**
 * Unquoted globs expand to filenames chosen by the filesystem, and a file called `-x` or
 * `--pre=./evil` becomes an OPTION of the command. So a glob is accepted only as an ARGUMENT
 * (never the command word, an assignment or a redirect target) of commands whose every option
 * is read-only and non-executing. git (-c/--output), find (-delete/-exec), rg (--pre), sed (-i),
 * tar, npm, rm, mv, sort -o, and `file` (-C writes magic.mgc) stay rejected. The one exception is
 * the value part of --include=/--exclude=: the option name is literal, so an expansion can only
 * vary a file-selection pattern (it can never turn into another option).
 */
const GLOB_SAFE = new Set(["ls", "cat", "head", "tail", "wc", "stat", "du", "grep", "egrep", "fgrep"]);
const GREP_LIKE = new Set(["grep", "egrep", "fgrep"]);
const EXEC_LIKE = /^--(pre|exec|exec-batch|hostname-bin|open-files-in-pager|pager)(=|$)/;

/** Runs for every segment BEFORE the per-command checks, so rejected expansions keep their original reason. */
function expansionIssue(tokens: readonly Word[]): Issue | undefined {
  const flagged = (w: Word) => w.glob !== undefined || w.variable !== undefined;
  if (!tokens.some(flagged)) return;
  const words = tokens.map(w => w.text);
  let i = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) i++;
  const command = words[i] ?? "", last = tokens.length - 1;
  // `[ ... ]`: the bare `[` and `]` words are glob-flagged but cannot match any file.
  const bracket = command === "[" && tokens[i]!.glob === 0 && last > i && words[last] === "]" && tokens[last]!.glob === 0;
  const testLike = bracket || (command === "test" && !flagged(tokens[i]!));
  const inner = tokens.slice(i + 1, bracket ? last : undefined);
  // Narrow, side-effect-free form: test -n|-z "$NAME" (one double-quoted simple variable).
  const narrowVariable = testLike && inner.length === 2 && ["-n", "-z"].includes(inner[0]!.text) && !flagged(inner[0]!) ? inner[1] : undefined;
  for (let k = 0; k < tokens.length; k++) { // from 0: globs in assignment values are rejected too
    const w = tokens[k]!;
    if (!flagged(w) || (bracket && (k === i || k === last))) continue;
    if (w.variable !== undefined) { if (w === narrowVariable) continue; return expansion(VAR_REASON); }
    if (k > i) {
      const range = /^--(?:include|exclude)=/.exec(w.text);
      if (range && w.glob! >= range[0].length && (GREP_LIKE.has(command) || command === "rg")) continue;
      if (GLOB_SAFE.has(command) && !(GREP_LIKE.has(command) && options(words.slice(i + 1), command).some(a => EXEC_LIKE.test(a)))) continue;
    }
    return expansion(GLOB_REASON);
  }
}

export function classifyBash(command: string): BashVerdict {
  if (typeof command !== "string" || !command.trim()) return { allowed: false, ...unsupported("empty or invalid command") };
  const tokens = tokenize(command);
  if ("reason" in tokens) return { allowed: false, ...tokens };
  for (const segment of tokens.segments) {
    const issue = expansionIssue(segment);
    if (issue) return { allowed: false, ...issue };
  }
  for (const segment of tokens.segments) {
    const issue = checkSegment(segment);
    if (issue) return { allowed: false, ...issue };
  }
  return { allowed: true };
}
