/** Habitual-edit guard, NOT a sandbox. Inspection commands and trusted project checks
 * are allowed; checks execute project code and may produce caches/reports.
 * This bounded Bash subset rejects ALL active expansions, including bare globs
 * (quote file patterns), and validates complete static redirection targets.
 * It does not contain project scripts, Git configuration, or tool configuration.
 */
export type BashVerdict = { allowed: true } | { allowed: false; reason: string; category?: "mutation" | "unsupported" };
type Issue = { reason: string; category: "mutation" | "unsupported" };
type Word = { text: string; assignmentPrefixStatic: boolean };
const unsupported = (reason: string): Issue => ({ reason, category: "unsupported" });
const mutation = (reason: string): Issue => ({ reason, category: "mutation" });
const INSPECTION = new Set("ls cat head tail wc grep egrep fgrep rg fd tree pwd echo printf true false cd sort uniq cut tr diff cmp stat file which type date basename dirname realpath readlink du df nl column jq md5sum sha1sum sha256sum test [ uname whoami id hostname printenv find".split(" "));
const RUNNERS = new Set(["tsc", "eslint", "ruff", "prettier", "jest", "vitest", "mocha", "pytest"]);
const SAFE_ENV = new Set(["CI", "NODE_ENV", "TZ", "NO_COLOR", "FORCE_COLOR"]);
const SCRIPT = /^(test|lint|typecheck|type-check|check)(:[\w:.-]+)?$/;

/** No expansion evaluation. Quote removal happens only here, before option parsing. */
function tokenize(command: string): { segments: Word[][] } | Issue {
  const segments: Word[][] = [];
  let words: Word[] = [], word = "", started = false, quoted = false, assignmentPrefixStatic = true;
  let redirect: { op: string; fd: string } | undefined;
  let required = false;
  const endWord = (): Issue | undefined => {
    if (!started) return;
    if (redirect) {
      const { op, fd } = redirect;
      if (op === ">" || op === ">>" || op === "&>" || op === "&>>") {
        if (word !== "/dev/null") return mutation("output redirection outside static /dev/null");
      } else if (op === ">&") {
        if (fd !== "2" || word !== "1" || quoted) return unsupported("unsupported file descriptor redirection (only 2>&1)");
      } else if (op !== "<") return unsupported("unsupported redirection");
      redirect = undefined;
    } else words.push({ text: word, assignmentPrefixStatic });
    word = ""; started = quoted = false; assignmentPrefixStatic = true;
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
          if (c === "$" || c === "`") return unsupported("active expansion or command substitution");
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
    if (ch === "$" || ch === "`") return unsupported("active expansion or command substitution");
    if ("{}*?[]~".includes(ch)) return unsupported("active brace/glob/tilde expansion (quote literal patterns)");
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
  if (args.length === 1 && ["--version", "-v"].includes(args[0]!)) return;
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

function checkGit(args: readonly string[]): Issue | undefined {
  let i = 0;
  while (args[i]?.startsWith("-")) {
    const a = args[i]!;
    if (args.length === 1 && ["--version", "--help"].includes(a)) return;
    if (a === "-C" && args[i + 1]) { i += 2; continue; }
    if (["--no-pager", "-P"].includes(a) || /^--(git-dir|work-tree)=.+/.test(a)) { i++; continue; }
    return unsupported(`git option ${a}`);
  }
  const sub = args[i], rest = args.slice(i + 1), opts = options(rest, "git");
  if (opts.some(a => long(a, ["--output"]))) return mutation(`git ${sub} --output`);
  if (opts.some(a => long(a, ["--ext-diff", "--textconv"]) || (sub === "grep" && (short(a, "O") || long(a, ["--open-files-in-pager"]))))) return unsupported(`git ${sub} execution hook/pager option`);
  if (new Set("status diff log show rev-parse rev-list ls-files ls-tree blame grep shortlog describe cat-file name-rev merge-base diff-tree show-ref for-each-ref whatchanged check-ignore count-objects".split(" ")).has(sub ?? "")) return;
  if (sub === "reflog" && (!rest.length || rest[0] === "show" || rest[0]?.startsWith("-")) && !rest.some(a => ["expire", "delete", "--expire", "--expire-unreachable"].includes(a.split("=")[0]!))) return;
  if (sub === "worktree" && rest[0] === "list" && rest.slice(1).every(a => ["--porcelain", "-z", "-v"].includes(a))) return;
  if (sub === "remote" && rest.every(a => ["-v", "--verbose"].includes(a))) return;
  if (sub === "bundle" && ["verify", "list-heads"].includes(rest[0] ?? "")) return;
  if (sub === "fsck" && !opts.some(a => long(a, ["--lost-found"]))) return;
  if (sub === "branch" || sub === "tag") {
    const listing = rest.some(a => a === "--list" || (sub === "tag" && a === "-l"));
    const safe = sub === "branch" ? ["-a", "-r", "-v", "-vv", "--list", "--show-current", "--all", "--remotes"] : ["-l", "--list", "-n"];
    if (rest.every(a => safe.includes(a) || (listing && !a.startsWith("-")))) return;
  }
  if (sub === "stash" && ["list", "show"].includes(rest[0] ?? "")) return;
  if (sub === "config" && ["--get", "--list", "-l", "--get-all"].includes(rest[0] ?? "") && rest.every(a => !a.startsWith("-") || ["--get", "--list", "-l", "--get-all", "--show-origin", "--show-scope"].includes(a))) return;
  const writes = new Set("add commit checkout switch reset clean push pull fetch apply merge rebase cherry-pick restore init clone gc prune".split(" "));
  return writes.has(sub ?? "") ? mutation(`git ${sub}`) : unsupported(`unverified git ${sub ?? "subcommand"}`);
}

function checkScript(command: string, args: readonly string[]): Issue | undefined {
  if (args.length === 1 && ["--version", "-v"].includes(args[0]!)) return;
  let i = 0;
  // Runner-specific leading options only; no arbitrary option skipping.
  const safe = command === "npm" ? ["--silent", "--ignore-scripts"] : command === "pnpm" ? ["--silent", "--offline"] : command === "yarn" ? ["--silent", "--offline"] : ["--silent"];
  while (safe.includes(args[i] ?? "")) i++;
  const verb = args[i];
  if (["install", "i", "add", "remove", "uninstall", "publish", "update", "upgrade"].includes(verb ?? "")) return mutation(`${command} ${verb}`);
  if (verb === "run" && args.length === i + 1) return; // script listing
  let script: string | undefined;
  if (["run", "run-script"].includes(verb ?? "")) script = args[++i];
  else if (["test", "t"].includes(verb ?? "")) script = "test";
  else if (["yarn", "pnpm", "bun"].includes(command)) script = verb;
  if (script && /(?:^|[:.-])(fix|write|update|format)(?:$|[:.-])/i.test(script)) return mutation(`${command} mutating script ${script}`);
  if (!script || !SCRIPT.test(script)) return unsupported(`${command} ${verb ?? ""}: unverified project command`);
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
    const local = ["--no-install"];
    if (!local.includes(args[0] ?? "")) return unsupported(`${command} requires explicit local/no-install invocation`);
    let k = 0; while (local.includes(args[k] ?? "")) k++;
    const tool = args[k];
    if (!tool || !RUNNERS.has(tool)) return unsupported(`${command} unverified local runner/package spec`);
    return checkTool(tool, args.slice(k + 1));
  }
  if (command === "node") {
    if (args.length === 1 && ["--version", "-v"].includes(args[0]!)) return;
    if (opts.some(a => long(a, ["--import", "--require", "--eval", "--print", "--loader", "--experimental-loader", "--preload"]) || short(a, "rep"))) return unsupported("node other than --test: execution injection option");
    const testIndex = opts.indexOf("--test");
    const operandIndex = opts.findIndex(a => !a.startsWith("-"));
    return testIndex >= 0 && (operandIndex < 0 || testIndex < operandIndex) ? undefined : unsupported("node other than --test before script operands");
  }
  if (["python", "python3"].includes(command)) {
    if (args.length === 1 && ["--version", "-V"].includes(args[0]!)) return;
    if (args[0] === "-m" && ["pytest", "unittest"].includes(args[1] ?? "")) return checkTool("pytest", args.slice(2));
    return unsupported(`${command} other than -m pytest/unittest`);
  }
  if (command === "cargo") {
    if (args.length === 1 && ["--version", "-V"].includes(args[0]!)) return;
    if (opts.some(writeFlag)) return mutation("cargo source modification flag");
    if (["test", "check", "clippy"].includes(args[0] ?? "")) return;
    if (args[0] === "fmt" && opts.includes("--check")) return;
    return unsupported(`cargo ${args[0] ?? ""}`);
  }
  if (command === "go") {
    if (args[0] === "version" && args.length === 1) return;
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

export function classifyBash(command: string): BashVerdict {
  if (typeof command !== "string" || !command.trim()) return { allowed: false, ...unsupported("empty or invalid command") };
  const tokens = tokenize(command);
  if ("reason" in tokens) return { allowed: false, ...tokens };
  for (const segment of tokens.segments) {
    const issue = checkSegment(segment);
    if (issue) return { allowed: false, ...issue };
  }
  return { allowed: true };
}
