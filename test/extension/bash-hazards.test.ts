import { describe, expect, it } from "vitest";
import { findBashHazards } from "../../src/extension/bash-hazards.js";

/** The static accident check: nothing is executed; cwd and home are fixed strings. */
const context = { cwd: "/home/u/Code/proj", home: "/home/u" };
const levels = (command: string, cwd = context.cwd) => findBashHazards(command, { ...context, cwd }).map(hazard => hazard.level);
const blocked = (commands: string[], cwd?: string) => { for (const command of commands) expect(levels(command, cwd), command).toContain("block"); };
const warned = (commands: string[], cwd?: string) => { for (const command of commands) expect(levels(command, cwd), command).toEqual(expect.arrayContaining(["warn"])); for (const command of commands) expect(levels(command, cwd), command).not.toContain("block"); };
const clean = (commands: string[], cwd?: string) => { for (const command of commands) expect(levels(command, cwd), command).toEqual([]); };

describe("findBashHazards", () => {
  it("blocks deletes, moves and recursive chmod/chown of /, top-level system directories and the whole home directory when the target is known", () => {
    blocked([
      "rm -rf /", "rm -rf /*", "rm -rf ~", "rm -rf ~/", "rm -rf ~/*", "rm -rf ~/.*", "rm -rf $HOME", "rm -rf \"$HOME\"/*", "rm -rf ${HOME}/",
      "rm -rf /home/u", "rm -rf /home/u/", "sudo rm -rf /usr", "rm -rf /etc/", "rm -rf /tmp/../", "rm -r -- /var", "mv ~ /tmp/old-home",
      "chmod -R 777 /", "sudo chown -R me /usr", "find / -delete", "find ~ -type f -delete", "find /var -exec rm -rf {} +",
      "ls && rm -rf ~", "echo \"$(rm -rf ~)\"", "bash -c 'rm -rf ~'", "sudo sh -c \"rm -rf /*\"", "timeout 5 rm -rf /", "if true; then rm -rf ~; fi", "false && rm -rf ~",
    ]);
  });

  it("an unknown variable (not assigned in the command, e.g. inherited from the environment) never blocks: it is a warning for Jev", () => {
    warned(["rm -rf \"$DIR/\"*", "rm -rf $DIR/", "rm -rf \"${BUILD}\"/", "rm -rf \"$PREFIX/usr\"", "rm -rf $1/*", "find \"$ROOT/\" -delete", "bash -c 'rm -rf \"$DIR/\"*'"]);
    const [hazard] = findBashHazards("rm -rf \"$DIR/\"*", context);
    expect(hazard).toEqual({ level: "warn", message: "rm $DIR/*: if $DIR is empty or unset the target is everything in the filesystem root (its value is not known here: it may come from the environment or a conditional assignment)" });
  });

  it("the same target: unknown $DIR warns, DIR='' blocks, a safe literal or ${DIR:?} has no finding", () => {
    const matrix: [string, string[]][] = [
      ["rm -rf \"$DIR/\"*", ["warn"]],
      ["DIR=''; rm -rf \"$DIR/\"*", ["block"]],
      ["DIR=; rm -rf \"$DIR/\"*", ["block"]],
      ["DIR=\"\"\nrm -rf \"$DIR/\"*", ["block"]],
      ["export DIR=''; rm -rf \"$DIR/\"*", ["block"]],
      ["DIR=build; rm -rf \"$DIR/\"*", []],
      ["rm -rf \"${DIR:?}/\"*", []],
      ["DIR=''; rm -rf \"${DIR:?}/\"*", []],
    ];
    for (const [command, expected] of matrix) expect(levels(command), command).toEqual(expected);
    expect(findBashHazards("DIR=''; rm -rf \"$DIR/\"*", context)[0]?.message).toBe("rm $DIR/*: $DIR is assigned an empty value in this command, so the target is everything in the filesystem root");
  });

  it("assignments that may not run, or do not reach the command, are unknown, never known facts", () => {
    warned([
      "false && DIR=/; rm -rf \"$DIR/\"*", "true || DIR=''; rm -rf \"$DIR/\"*", "if false; then DIR=''; fi; rm -rf \"$DIR/\"*", "(DIR=''); rm -rf \"$DIR/\"*",
      "DIR+=''; rm -rf \"$DIR/\"*", "DIR=''; bash -c 'rm -rf \"$DIR/\"*'", "echo \"$(rm -rf \"$DIR/\"*)\"; DIR=''", "DIR=$(mktemp -d); rm -rf \"$DIR/\"*",
    ]);
    // A later conditional value does not hide an unknown one either.
    expect(levels("if x; then DIR=build; fi; rm -rf \"$DIR/\"*")).toEqual(["warn"]);
  });

  it("does not flag the same commands when the variable is set to a literal, guarded, or the target is specific", () => {
    clean([
      "DIR=build; rm -rf \"$DIR/\"*", "export OUT=dist && rm -rf $OUT/", "for d in a b; do rm -rf \"$d/\"; done", "rm -rf \"${DIR:?}/\"*",
      "rm -rf \"${DIR:-build}/\"", "rm -rf \"$DIR\"", "rm -rf \"$DIR/build\"", "rm -rf build dist", "rm -rf ~/Code/proj/build", "rm -rf ~/.cache/pip",
      "rm -rf /tmp/scratch", "rm -rf /usr/local/lib/foo", "sudo rm -rf /var/tmp/x", "mv build ~", "mv a b ~/", "chmod -R 755 build", "chown -R me ~/Documents",
      "find . -name '*.o' -delete", "find ~/Code -name node_modules -prune", "git clean -fdx", "rm -f /home/u/.zsh_history.lock",
    ]);
  });

  it("keeps quoted text quoted: literal ~, literal * and commands inside strings are not targets", () => {
    clean(["echo 'rm -rf /' > note.txt", "rm -rf '~'", "rm -rf \"~\"", "rm -rf '/*'", "rm -rf \"$HOME/*\"", "grep -n 'rm -rf ~' notes.md", "cat <<'EOF'\nrm -rf ~\nEOF", "echo \"rm -rf $HOME\""]);
    blocked(["rm -rf /*", "rm -rf ~"]);
  });

  it("warns (for Jev) about the working directory, its parents, home for chmod/chown, filtered finds and substitution targets", () => {
    warned([
      "rm -rf .", "rm -rf *", "rm -rf ./*", "rm -rf ..", "rm -rf ../*", "rm -rf /home/u/Code", "chown -R me ~", "chmod -R go-w ~",
      "find ~ -name '*.tmp' -delete", "rm -rf $(cat dirs.txt)", "X=$(mktemp -d); rm -rf \"$X/\"*", "rm -rf $PWD/*",
    ]);
  });

  it("targets that depend on a cd are warnings for Jev: the cd may fail, run in a subshell or be conditional", () => {
    warned(["cd ~ && rm -rf *", "cd / && rm -rf usr", "cd /home && rm -rf u", "(cd /); rm -rf usr", "cd / || rm -rf usr", "cd; rm -rf ./*"]);
    clean(["cd \"$WORK\" && rm -rf .", "cd /tmp/staging && rm -rf build", "env -C /tmp/x rm -rf *"]);
    warned(["cd sub && rm -rf ../*", "cd build && rm -rf ..", "cd /tmp/staging && rm -rf ./*"]);
    // The tool's own cwd is known: `rm -rf *` there is the whole home directory.
    blocked(["rm -rf *"], "/home/u");
    clean(["env -C /tmp/x rm -rf *"], "/home/u");
  });

  it("finds nothing in text it cannot parse and in commands it does not model (left to Jev)", () => {
    clean(["rm -rf 'unterminated", "ssh host 'rm -rf ~'", "python3 -c 'import shutil; shutil.rmtree(\"/\")'", "make clean", "dd if=/dev/zero of=/dev/sda", "$CMD -rf /"]);
  });
});
