import { describe, expect, it } from "vitest";
import { classifyBash, READ_ONLY_GIT_SUBCOMMANDS } from "../../src/extension/bash-policy.js";

// Regression suite for read-only commands that used to be false-positive blocks, and for the neighbours that must stay blocked.
// Specimens are pure string data: nothing here is executed.
const allowed = (command: string) => expect(classifyBash(command), command).toEqual({ allowed: true });
const blocked = (command: string) => expect(classifyBash(command).allowed, command).toBe(false);

describe("read-only commands that must be allowed", () => {
  it.each([
    // git: usage / help only
    "git commit -h",
    "git commit --help",
    "git help",
    "git help commit",
    "git help -a",
    "git -C x commit -h",
    // git branch list mode
    "git branch -r --contains HEAD",
    "git branch --merged",
    // git ls-remote (network read, no local mutation)
    "git ls-remote origin",
    // git submodule read verbs
    "git submodule status",
    "git submodule summary",
    // git config lookups
    "git config --get remote.origin.url",
    "git config remote.origin.url",
    "git config --get-regexp ^remote",
    "git config --show-origin --get user.name",
    "git config --file .gitmodules --get submodule.x.path",
    // working-directory selection for script runners
    "npm --prefix x run typecheck",
    "npm --prefix=x run typecheck",
    "pnpm -C x test",
    "pnpm --dir x run lint",
    "yarn --cwd x test",
    // leading `~` is a static $HOME prefix
    "ls ~/.pi",
    "ls ~",
    "cat ~/x",
    // globs as arguments of commands whose every option is read-only
    "grep -rn --include=*.ts pattern src",
    "rg --include=*.ts foo",
    "ls /home/x/.pi/agent/sessions/*/",
    "cat *.md",
    // a single double-quoted $NAME in test -n|-z
    "test -n \"$VAR\"",
    "[ -z \"$VAR\" ]",
    "[ -n \"$VAR\" ]",
    "test -z \"$VAR\"",
    "[ -f foo ]",
    // `file --help` only prints usage (it is the glob form that is rejected, see below)
    "file --help",
  ])("allows %s", command => allowed(command));
});

describe("mutation and execution must stay blocked", () => {
  it.each([
    // git
    "git commit -m x",
    "git commit -h -m x",
    "git push",
    "git help -w commit",
    "git help --web commit",
    "git help -i git",
    "git submodule foreach ls",
    "git submodule update",
    "git submodule",
    "git config user.name foo",
    "git config --unset x",
    "git ls-remote --upload-pack=evil origin",
    "git ls-remote -u evil origin",
    "git ls-remote --exec=evil origin",
    "git ls-remote ext::sh origin",
    "git branch -D x",
    "git branch newname",
    "git branch --contains HEAD newname",
    "git evil -h",
    // runners
    "npm --prefix x install",
    "npm --prefix x run fix",
    "npx foo",
    "node -e 1",
    "curl http://x",
    // globs where an option could write or execute
    "find * -delete",
    "rm *",
    "git log *",
    "sed -i s/a/b/ *",
    "rg *.ts",
    "file *",
    // other expansions
    "cat $(echo x)",
    "ls ~user",
    "tail -f ~root/x",
    "test -n \"$(id)\"",
    "test ! -n \"$A\"",
    "CI=* npm test",
  ])("blocks %s", command => blocked(command));

  it("keeps the verdict category: mutation for explicit writes, unsupported for the rest", () => {
    expect(classifyBash("git commit -m x")).toMatchObject({ allowed: false, category: "mutation" });
    expect(classifyBash("git push")).toMatchObject({ allowed: false, category: "mutation" });
    expect(classifyBash("npm --prefix x run fix")).toMatchObject({ allowed: false, category: "mutation" });
    expect(classifyBash("git submodule update")).toMatchObject({ allowed: false, category: "unsupported" });
    expect(classifyBash("git branch newname")).toMatchObject({ allowed: false, category: "unsupported" });
    expect(classifyBash("rm *")).toMatchObject({ allowed: false, category: "unsupported" });
    expect(classifyBash("cat $(echo x)")).toMatchObject({ allowed: false, category: "unsupported" });
  });
});

describe("block hints", () => {
  it("marks every expansion rejection with an expansion hint", () => {
    for (const command of ["rm *", "git log *", "sed -i s/a/b/ *", "find * -delete", "cat $(echo x)", "ls ~user", "test -n \"$(id)\"", "echo `id`"]) {
      expect(classifyBash(command), command).toMatchObject({ allowed: false, hint: { kind: "expansion" } });
    }
  });
  it("names the tool and option for an unknown leading option", () => {
    expect(classifyBash("npm --foo test")).toMatchObject({ allowed: false, hint: { kind: "leading-option", tool: "npm", option: "--foo" } });
    expect(classifyBash("git -c a=b diff")).toMatchObject({ allowed: false, hint: { kind: "leading-option", tool: "git", option: "-c" } });
  });
  it("names the git subcommand that decided the verdict", () => {
    expect(classifyBash("git commit -m x")).toMatchObject({ allowed: false, hint: { kind: "git-subcommand", subcommand: "commit" } });
    expect(classifyBash("git branch newname")).toMatchObject({ allowed: false, hint: { kind: "git-subcommand", subcommand: "branch" } });
    expect(classifyBash("git submodule update")).toMatchObject({ allowed: false, hint: { kind: "git-subcommand", subcommand: "submodule" } });
    expect(classifyBash("git")).toMatchObject({ allowed: false, hint: { kind: "git-subcommand" } });
  });
  it("adds no hint where no concrete alternative is derivable", () => {
    for (const command of ["touch file", "curl http://x", "node -e 1", "echo hi > out.txt"]) {
      const verdict = classifyBash(command);
      expect(verdict.allowed, command).toBe(false);
      expect("hint" in verdict, command).toBe(false);
    }
  });
  it("exports the read-only git subcommands used in the suggestion", () => {
    expect(READ_ONLY_GIT_SUBCOMMANDS.slice(0, 4)).toEqual(["status", "diff", "log", "show"]);
    for (const sub of READ_ONLY_GIT_SUBCOMMANDS) expect(typeof sub).toBe("string");
  });
});
