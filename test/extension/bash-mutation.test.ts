import { describe, expect, it } from "vitest";
import { bashMayWrite } from "../../src/extension/bash-mutation.js";
import { classifyBash } from "../../src/extension/bash-policy.js";
import { needsBashReview } from "../../src/extension/bash-review.js";

/** Heuristic write detection for the Bash safety review: recognised reads are false, writes and anything opaque are true. */
const reads = (commands: string[]) => { for (const command of commands) expect(bashMayWrite(command), command).toBe(false); };
const writes = (commands: string[]) => { for (const command of commands) expect(bashMayWrite(command), command).toBe(true); };

describe("bashMayWrite", () => {
  it("treats ordinary read queries as reads, including ones main's permission policy does not allow", () => {
    reads([
      "ls -la", "cat README.md", "git status", "git log --oneline -5", "rg TODO src", "grep -rn foo .", "find . -name '*.ts'",
      "head -n 20 a.txt | tail -5", "wc -l src/*.ts", "du -sh node_modules", "ps aux | grep node", "which node", "node --version",
      "python3 --help", "sed -n '1,20p' file", "sed 's/a/b/g' file", "awk '{print $1}' file", "awk '$3 > 100 {n++} END {print n}' f",
      "jq .version package.json", "curl -s https://example.com/api", "curl -sSL -H 'Accept: x' https://e.x", "git branch", "git branch -a",
      "git tag --list", "git remote -v", "git stash list", "git config --get user.name", "git config user.email", "git -C ../other log -1",
      "git --no-pager diff HEAD~1", "env", "sudo cat /var/log/syslog", "sudo -u postgres psql --version", "timeout 5 ls", "env LC_ALL=C sort a.txt",
      "find . -type f | xargs grep foo", "xargs -n1 echo < list.txt", "date +%s", "hostname", "uniq -c counts.txt", "tee", "sort -u words.txt",
      "wget --spider https://e.x", "wget -qO- https://e.x", "/usr/bin/ls -l", "for f in *.ts; do wc -l \"$f\"; done", "if [ -f x ]; then cat x; fi",
      "[[ -d src ]] && ls src", "(cd sub && ls)", "{ ls; pwd; }", "set -e; ls", "export PATH=\"$PATH:/opt/bin\"; which tool", "X=1 Y=2",
      "# just a comment",
    ]);
  });

  it("allows harmless variables, globs, tilde and substitutions in arguments without running anything", () => {
    reads([
      "cat \"$FILE\"", "printf '%s\\n' \"$HOME\"", "ls ${DIR:-.}", "ls ~", "ls $HOME/*.log", "echo \"$(date)\"", "grep -c x $(git ls-files)",
      "diff <(sort a) <(sort b)", "echo `pwd`", "echo $((1 + 2))", "cat <<EOF\nrm -rf /\nEOF", "cat <<'EOF'\n$(rm -rf x)\nEOF", "grep x <<< \"$TEXT\"",
      "wc -l < input.txt", "ls 2>/dev/null", "ls > /dev/null 2>&1", "cmd_output=$(ls)", "ls &> /dev/null", "ls >&2",
    ]);
  });

  it("keeps quoted text quoted: write-looking words inside strings are not writes", () => {
    reads(["echo 'rm -rf /'", "echo \"rm -rf / > x\"", "grep -n 'echo x > y' notes.md", "printf 'a > b\\n'", "rg \"\\brm -rf\" src", "echo a\\>b"]);
  });

  it("flags writes, redirections to files and mixed read/write compounds", () => {
    writes([
      "rm -rf build", "rm -rf \"$DIR/\"*", "mv a b", "cp -r src dst", "mkdir -p x", "touch x", "chmod -R 755 .", "ln -s a b", "truncate -s0 f",
      "echo x > out.txt", "printf x >> log.txt", "ls > files.txt", "ls 2> err.log", "ls &> all.log", "cat a >| b", "exec 3<> f", "ls > \"$OUT\"",
      "ls && touch x", "git status; git commit -m x", "cat a | tee b", "ls || rm x", "(cd sub && rm -rf dist)", "for f in *; do rm \"$f\"; done",
      "if true; then echo x > y; fi", "cat <<EOF > out.txt\nhello\nEOF",
    ]);
  });

  it("flags writing options of otherwise reading commands", () => {
    writes([
      "sed -i 's/a/b/' f", "sed -i.bak s/a/b/ f", "sed -ni p f", "sed -n '/x/w out.txt' f", "sed 's/a/b/w out' f", "sed -f script.sed f",
      "awk '{print > \"out\"}' f", "awk 'BEGIN{system(\"rm x\")}'", "gawk -i inplace '{print}' f", "find . -name '*.o' -delete", "find . -exec rm {} +",
      "find . -fprint list.txt", "fd -x rm", "sort -o out.txt in.txt", "uniq in.txt out.txt", "tee out.txt", "tee -a log.txt", "yq -i .a=1 f.yaml",
      "date -s '2020-01-01'", "hostname newname", "rg --pre ./decompress x", "curl -o out https://e.x", "curl -O https://e.x/f", "curl -sSLo f https://e.x",
      "curl -d a=1 https://e.x", "curl -X POST https://e.x", "curl -XDELETE https://e.x", "curl --data-binary @f https://e.x", "wget https://e.x/f",
      "git branch -D old", "git branch feature", "git tag v1", "git tag -d v1", "git remote add o url", "git stash", "git stash pop", "git config user.name x",
      "git push", "git commit -am x", "git reset --hard", "git checkout .", "git clean -fdx", "git diff --output=patch.diff", "git worktree add ../w",
      "git reflog expire --all", "git -C ../other push",
    ]);
  });

  it("flags project checks, scripts and other programs whose effects it cannot see, even when main's policy allows them", () => {
    const checks = ["npm test", "npm run lint", "npx --no-install vitest run", "vitest run", "tsc --noEmit", "eslint .", "prettier --check ."];
    for (const command of checks) expect(classifyBash(command).allowed, `main policy allows ${command}`).toBe(true);
    writes(["npx tsc --noEmit",
      ...checks, "node --test", "python -m pytest", "cargo check", "go build ./...", "make", "make clean", "./build.sh", "bash scripts/x.sh", "sh -c 'ls'",
      "python3 -c 'print(1)'", "node -e 'require(\"fs\").rmSync(\"x\")'", "perl -pi -e s/a/b/ f", "npm install", "docker ps", "ssh host ls", "rsync -a a b",
      "source env.sh", ". ./env.sh", "eval \"$CMD\"", "trap 'rm -f x' EXIT", "unknown-tool --flag",
    ]);
  });

  it("flags dynamic or wrapped command names and wrappers around writes", () => {
    writes([
      "$CMD file", "\"$EDITOR\" f", "$(which rm) x", "./*.sh", "sudo rm -rf /var/tmp/x", "sudo -s", "sudo -i", "env FOO=1 rm x", "env -S 'rm x'",
      "timeout 5 rm x", "nice -n 5 make", "xargs rm < list", "ls | xargs rm", "find . | xargs -I{} mv {} /tmp", "command rm x", "exec rm x", "nohup ./run.sh",
    ]);
  });

  it("judges command and process substitutions by their inner commands", () => {
    writes(["echo \"$(rm -rf x)\"", "x=$(touch f)", "cat <(git clean -fdx)", "ls `rm x`", "tee >(gzip > out.gz) < in", "cat <<EOF\n$(rm x)\nEOF"]);
  });

  it("treats text it cannot follow as a possible write", () => {
    writes(["echo 'unterminated", "echo \"open", "ls >", "cat <<EOF\nno end", "echo $(ls"]);
  });
});

describe("independent of main's permission policy", () => {
  it("an allowed check can need review while a rejected read can skip it", () => {
    expect(classifyBash("npm test").allowed).toBe(true);
    expect(needsBashReview("npm test")).toBe(true);
    expect(classifyBash("cat \"$FILE\"").allowed).toBe(false);
    expect(needsBashReview("cat \"$FILE\"")).toBe(false);
    expect(classifyBash("ps aux | grep node").allowed).toBe(false);
    expect(needsBashReview("ps aux | grep node")).toBe(false);
  });
});
