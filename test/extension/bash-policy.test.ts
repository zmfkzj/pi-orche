import { describe, expect, it } from "vitest";
import { classifyBash } from "../../src/extension/bash-policy.js";

// Specimens are strings for the pure classifier ONLY, never executed as shell commands.
// pnpm, yarn, eslint, prettier, jest, mocha, pytest, go, fd, tree, python and file:
// unverified (tool absent); these specimens are policy expectations, not CLI acceptance claims.
const positives: Record<string, string[]> = {
  inspection: [
    "ls -la src", "cat package.json | head -20", "grep -rn emtpy src/", "git status --short", "git diff HEAD -- src",
    "git log --oneline -5", "git -C /tmp/x status", "git branch --show-current", "git stash list", "git config --get user.name",
    "cd src && ls", "echo 'a > b'", "grep 'x;y' file && echo ok", "sort -u names.txt", "uniq -c names.txt",
    "wc -l < file.txt", "jq .name package.json", "find . -name '*.js' -not -path './node_modules/*'",
    "git reflog", "git reflog show HEAD", "git check-ignore file", "git count-objects -v", "git worktree list --porcelain",
    "git remote -v", "git branch --list 'feature/*'", "git tag -l 'v*'", "git bundle verify archive.bundle",
    "git bundle list-heads archive.bundle", "git fsck --full", "git diff -Oorderfile", "git diff -O orderfile",
    "sort -- -output", "git diff -- --output=literal", "rg -- --pre=literal", "cat -- -filename", "prettier --check -- -write",
    "uniq -f 1 input.txt", "uniq -- -input", "git show HEAD:file",
    "file -- --compile", "file -b package.json", "hostname", "hostname -f", "printf '%s' literal", "printf -- -v",
    "sort -Tfolder input", "sort -tfoo input", "file -mCmagic input", "file -m --compile input",
    "tree -Ifoo", "tree -I -output", "date -dsunday", "date --date -s2020",
    "date +%s", "date -d 010100002020", "date --date=010100002020", "rg --pre-glob='*.txt' pattern src",
  ],
  quoting: [
    "grep '#$VAR{a,b}*?' file", 'grep "#{}" file', "echo literal#hash", "echo \\$VAR", 'echo "\\$VAR"',
    'echo "\\q"', "echo foo\\\nbar", "echo ok # 'unterminated comment\nls", "echo ok # ` $ { \nls",
    "echo ok # ignored\necho next", "grep 'a\nb' file", "git lo\\\ng --oneline", "grep \"x;y\" file",
    "echo ok &&\nls", "echo ok || echo no", "echo ok; ls", 'echo "a\\\nb"',
  ],
  redirection: [
    "npm test 2>&1 | tail -30", "npm test > /dev/null 2>&1", "echo ok > '/dev/null'", "echo ok > /dev/'null'",
    "echo ok >>/dev/null", "echo ok &>/dev/null", "echo ok &>>/dev/null", "wc -l < 'file name.txt'",
    "wc < --fix", "cat < file.txt | wc -l", "cat 0<file", "echo ok 1>/dev/null",
  ],
  checks: [
    "npm test", "npm run test:unit", "npm run lint", "yarn test", "pnpm test", "bun test", "bun run typecheck",
    "pnpm run check", "yarn lint", "npm --silent test", "pnpm --offline test", "yarn --silent test", "bun --silent test",
    "node --test", "node --test --test-reporter=spec", "node --test --test-name-pattern 'some test'",
    "npx --no-install vitest run test/foo.test.ts", "npx --no-install tsc --noEmit -p .", "bunx --no-install eslint src",
    "./node_modules/.bin/vitest run", "tsc --noEmit", "tsc --noEmit true", "tsc --noEmit true -p .",
    "python -m pytest -q", "python3 -m unittest", "cargo test", "cargo check", "cargo clippy", "cargo fmt --check",
    "go test ./...", "go vet ./...", "go list ./...", "CI=1 npm test", "NODE_ENV=test TZ=UTC node --test",
    "ruff check src", "ruff format --check src", "ruff format --diff src", "eslint --fix-dry-run src",
    "eslint --cache --output-file report.json src", "prettier --check src", "prettier -c src", "prettier -l src",
    "vitest run --coverage", "npm test -- --coverage", "bun test --coverage", "npm run lint -- --max-warnings 0",
    "tsc -p project --noEmit", "prettier --config config.json --check src",
    "CI='1' npm test", "CI=\"1\" npm test", "NODE_ENV=test TZ='UTC' node --test", "CI=\\1 npm test",
  ],
  versionsAndListing: ["node --version", "node -v", "python --version", "python3 -V", "go version", "tsc --version", "npm --version", "pnpm -v", "yarn --version", "bun --version", "cargo --version", "cargo -V", "npm run", "pnpm run", "yarn run", "bun run"],
  // Moved from negatives.grammar: intentionally allowed by the read-only false-positive fix. A glob is an
  // argument of a command whose every option is read-only (ls), and a leading `~` is a static $HOME prefix.
  // The full allow/block regression suite lives in bash-policy-readonly.test.ts.
  expansionAllowances: ["ls *.ts", "echo ~"],
};
const negatives: Record<string, string[]> = {
  grammar: [
    "echo ok # '\ntouch unexpected.txt\n#'", "echo $VAR", 'echo "$VAR"', "echo ${VAR}", "echo $(touch x)",
    "echo `touch x`", 'echo "$(touch x)"', "echo $((1+2))", "git log --{oneline,output=out.txt}",
    "echo {a,b}", "diff <(ls a) <(ls b)", "echo >(cat)", "(cd src && ls)",
    "sleep 100 &", "cat <<EOF\nhi\nEOF", "cat <<<literal", "cat <>file", "echo 'unterminated", 'echo "unterminated',
    "echo trailing\\", "ls &&", "ls ||", "ls |", "ls &&\n# comment", "| ls", "ls || | ls", "ls && ; ls", "echo \r",
    "; ls", "ls ;; ls", "ls\n| ls",
    "ls; rm x", "ls && rm x", "ls | xargs rm", "ls\nrm x", "ls\\\n; touch x", "for x in a; do echo x; done",
    "awk '{print $1}' file", "sed -n '1,20p' file", "", "   ", "# comment only",
  ],
  redirection: [
    "echo hi > out.txt", "cat a >> b", "ls &> log.txt", "echo ok >/dev/null$SUFFIX", "echo ok >/dev/null'x'",
    "echo ok >'/dev/null'junk", 'echo ok >"/dev/null$X"', "echo ok > /dev/null/foo", "echo ok > /dev/null#suffix",
    "echo ok > /dev/null{,suffix}", "echo ok > /dev/null*", "echo ok >&1", "echo ok 2>&2", "echo ok 2>&1suffix",
    "echo ok 2>&$FD", "echo ok 2>&'1'", "echo ok 3>/dev/null", "cat < $FILE", "cat < *.txt", "cat <",
    "echo ok >", "echo ok > #comment", "tsc < --noEmit", "cat <file >output",
  ],
  mutationsAndUnknown: [
    "sed -i s/a/b/ file", "rm -rf build", "mv a b", "cp a b", "touch x", "mkdir d", "tee out.txt", "chmod +x run.sh",
    "npm install left-pad", "npm publish", "npm run build", "node script.js", "node -e 'example'", "python -c 'example'",
    "curl http://example.com", "./scripts/run.sh", "/usr/bin/rm x", "env FOO=1 ls", "export A=1",
    "GIT_EXTERNAL_DIFF=./evil.sh git diff", "PAGER=./evil git log", "NODE_OPTIONS=--require=./evil.js npm test",
    "LD_PRELOAD=./x.so ls", "CI=1 GIT_PAGER=cat git log", "CI=1",
    "'CI=1' npm test", "\\CI=1 npm test", "CI\\=1 npm test", "'CI'=1 npm test", "CI''=1 npm test",
    "CI'='1 npm test", '"CI=1" npm test', "./node_modules/.bin/ls", "./node_modules/.bin/git status",
  ],
  git: [
    "git commit -am x", "git checkout main", "git reset --hard", "git add .", "git push", "git apply patch.diff", "git clean -fd",
    "git stash", "git stash pop", "git branch -D x", "git branch -l x", "git tag v1", "git config user.name x",
    "git config --get --edit", "git diff --output=out.patch", "git -c core.pager=sh diff", "git log --ext-diff",
    "git grep -Oprogram pattern", "git grep -O program pattern", "git grep --open-files-in-pager=program pattern",
    "git grep -nOprogram pattern",
    "git reflog expire --all", "git reflog delete HEAD", "git remote add x url", "git worktree add dir", "git bundle create bundle HEAD",
    "git fsck --lost-found", "git fsck --lost-found=true", "git branch --list -D x", "git tag --list -d x",
    "git diff --format -- --output=out.patch",
  ],
  options: [
    "find . -name '*.tmp' -delete", "find . -exec rm '{}' ;", "sort -o out.txt in.txt", "sort -oFILE in.txt",
    "sort -uoFILE in.txt", "sort --output=FILE", "sort --compress-program=program", "sort --compress-program program",
    "sort -T -- -oFILE", "uniq in.txt out.txt", "uniq -- in.txt out.txt", "tree -oFILE", "fd --exec=program",
    "rg --pre=./x foo", "rg --pre ./x foo", "rg --hostname-bin=program foo", "rg --hostname-bin program foo",
    "date -s2020", "date --set=2020", "tsc -p .", "tsc --noEmit false", "tsc --noEmit=false", "tsc --noEmit --noEmit false",
    "tsc --noEmit=true --noEmit=false", "tsc --noEmit --init", "tsc --noEmit --emitDeclarationOnly", "tsc --noEmit --build",
    "tsc --noEmit --outDir out", "tsc -p --noEmit", "ruff format src", "ruff check --fix src", "ruff check --fix=true",
    "ruff check --add-noqa src", "ruff clean", "ruff format --config --check src", "prettier --check --write src",
    "prettier -cw src", "prettier -c -w src", "prettier --list-different --write=true src", "prettier --config --check src",
    "prettier --config -- --write src", "eslint --fix=true src", "eslint --fix src", "vitest run -u", "jest --updateSnapshot",
    "cargo clippy --fix", "cargo fmt", "go test -exec=program", "go test -exec program", "go vet -toolexec=program",
    "go vet -vettool=program", "go vet -vettool program",
    "file -C", "file --compile", "file --compile=magic", "file -bC", "hostname new-host", "hostname -F hosts",
    "hostname -- new-host", "printf -v PATH '%s' value", "printf -vPATH value",
    "hostname -- -f", "hostname --file hosts", "hostname --file=hosts", "tsc --noEmit -b", "file -mCmagic -C", "sort -Tfolder -oout",
    "tsc --noEmit=true -p .", "tsc --noEmit=TRUE", "date 010100002020", "date -u 01010000.30", "date -- 010100002020",
    "vitest run --coverage.thresholds.autoUpdate", "vitest run --coverage.thresholds.autoUpdate=true",
    "vitest run --coverage.customProviderModule=./provider.mjs", "vitest run --coverage.customProviderModule ./provider.mjs",
  ],
  nodeInjection: [
    ...["--import=./x", "--import ./x", "--require=./x", "--require ./x", "-r./x", "-r ./x", "-eCODE", "-pCODE", "--eval=CODE", "--print=CODE", "--loader=./x", "--loader ./x", "--experimental-loader=./x", "--preload=./x"].map(flag => `node --test ${flag}`),
    "node --test-reporter --test", "node --test --test-reporter -- --import=./x",
    "node script.js --test", "node script.js --test --test-reporter=spec",
    'node --test --import=\'data:text/javascript,console.log("DATA_EXECUTED")\' ',
    "node --test -r./x.cjs", "node --test -r ./x.cjs",
  ],
  runners: [
    "npx vitest run", "bunx vitest run", "npx --package=other vitest", "npx -p other vitest", "npx --call=program",
    "npx --offline vitest run", "npm test -- --require=./program",
    "npx --no-install --package other vitest", "npx --no-install vitest@latest", "npx --no-install @scope/tool",
    "bunx --no-install --call program", "bunx --no-install vitest@latest", "npx --yes vitest", "npx --no-install prettier --write src",
    "npx --no-install --package= vitest --version", "bunx --no-install missing-tool-xyz",
    "npm test -- --coverage.customProviderModule=./provider.mjs", "npm test -- --coverage.thresholds.autoUpdate",
    ...["npm", "pnpm", "yarn", "bun"].flatMap(runner => [
      `${runner} run lint:fix`, `${runner} run test:update`, `${runner} run check:write`, `${runner} run lint:format`,
      `${runner} test -u`, `${runner} test -- --updateSnapshot`, `${runner} run lint -- --fix`, `${runner} run check --write=true`,
      `${runner} run test --update`, `${runner} --package=x test`,
    ]),
  ],
};

describe("main-session shell allowlist (mode multi)", () => {
  for (const [group, commands] of Object.entries(positives)) describe(group, () => {
    it.each(commands)("allows %s", command => expect(classifyBash(command)).toEqual({ allowed: true }));
  });
  for (const [group, commands] of Object.entries(negatives)) describe(group, () => {
    it.each(commands)("blocks %s", command => {
      const verdict = classifyBash(command);
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) {
        expect(verdict.reason.length).toBeGreaterThan(0);
        expect(["mutation", "unsupported"]).toContain(verdict.category);
      }
    });
  });
  it("distinguishes explicit mutation from unverified syntax", () => {
    expect(classifyBash("touch file")).toMatchObject({ allowed: false, category: "mutation" });
    expect(classifyBash("awk '1' file")).toMatchObject({ allowed: false, category: "unsupported" });
    expect(classifyBash("echo ok # '\ntouch unexpected.txt\n#'")).toMatchObject({ allowed: false, category: "mutation", reason: "command touch" });
  });
});
