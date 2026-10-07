import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkBashWrites } from "../../src/orchestration/bash-writes.js";
import type { WriteRoot } from "../../src/orchestration/ownership.js";

const cwd = "/home/u/Code/repo";
const scratch = "/tmp/pi-orche/s1/W1";
const sibling = "/home/u/Code/sibling";
const roots: WriteRoot[] = [{ path: scratch, kind: "scratch" }, { path: sibling, kind: "root" }];
const scratchOnly: WriteRoot[] = [{ path: scratch, kind: "scratch" }];
const check = (command: string, options: { roots?: readonly WriteRoot[]; readOnly?: boolean } = {}) =>
  checkBashWrites(command, { cwd, roots: options.roots ?? roots, readOnly: options.readOnly ?? false });
const blocked = (command: string, options?: { roots?: readonly WriteRoot[]; readOnly?: boolean }) => {
  const verdict = check(command, options);
  expect(verdict.allowed, command).toBe(false);
  return verdict.allowed ? [] : verdict.targets;
};
const allowed = (command: string, options?: { roots?: readonly WriteRoot[]; readOnly?: boolean }) => expect(check(command, options), command).toEqual({ allowed: true });

describe("static bash write check", () => {
  it("blocks redirections and heredocs to /tmp outside the scratch directory, with advice", () => {
    expect(blocked("echo hi > /tmp/x.py")).toEqual(["/tmp/x.py"]);
    expect(blocked("cat > /tmp/notes.md <<'EOF'\nline > /etc/passwd\nEOF\necho done")).toEqual(["/tmp/notes.md"]);
    expect(blocked("cat <<EOF >>/tmp/a\nx\nEOF")).toEqual(["/tmp/a"]);
    expect(blocked("cat <<-EOF | tee /tmp/b\n\tbody\n\tEOF\n")).toEqual(["/tmp/b"]);
    for (const op of [">", ">>", "&>", "&>>", "2>", "2>>", ">|", "1>", ">&"]) expect(blocked(`make ${op}/tmp/log`), op).toEqual(["/tmp/log"]);
    const verdict = check("echo hi > /tmp/x.py");
    expect(verdict.allowed ? "" : verdict.reason).toBe(`Blocked: this bash command writes outside the workspace (/tmp/x.py). Use your scratch directory ${scratch} for temporary files. If the user explicitly asked to change /tmp/x.py, stop and report_result with data.status "blocked" so main can re-assign the task with writeRoots including it.`);
  });

  it("allows the scratch directory, the workspace and device files", () => {
    allowed(`echo hi > ${scratch}/x.py`);
    allowed(`cat > ${scratch}/notes.md <<'EOF'\nbody\nEOF`);
    allowed("echo hi > out.txt && mkdir -p build/tmp && cp a b && rm -rf dist");
    allowed(`echo > ${cwd}/x`);
    allowed("cmd > /dev/null 2>&1; cmd 2>/dev/null >/dev/stderr; echo >/dev/stdout; cmd 3>/dev/fd/3 >&2 2>&-");
    allowed("");
  });

  it("detects tee, touch, mkdir, rm, rmdir, cp, mv, install, ln, sed -i, perl -i, chmod, chown, truncate and dd targets", () => {
    expect(blocked("ls | tee -a /tmp/a /tmp/b")).toEqual(["/tmp/a", "/tmp/b"]);
    expect(blocked("touch -d yesterday /tmp/t")).toEqual(["/tmp/t"]);
    expect(blocked("mkdir -p -m 700 /tmp/d")).toEqual(["/tmp/d"]);
    expect(blocked("rm -rf /tmp/old; rmdir /var/x")).toEqual(["/tmp/old", "/var/x"]);
    expect(blocked("cp -r src /tmp/copy")).toEqual(["/tmp/copy"]);
    expect(blocked("cp -t /tmp/dir a b")).toEqual(["/tmp/dir"]);
    expect(blocked("cp --target-directory=/tmp/dir2 a")).toEqual(["/tmp/dir2"]);
    expect(blocked("mv build/out.js /opt/out.js")).toEqual(["/opt/out.js"]);
    expect(blocked("install -m 755 bin/tool /usr/local/bin/tool")).toEqual(["/usr/local/bin/tool"]);
    expect(blocked("install -d /tmp/i1 /tmp/i2")).toEqual(["/tmp/i1", "/tmp/i2"]);
    expect(blocked("ln -sf ../x /tmp/link")).toEqual(["/tmp/link"]);
    expect(blocked("sed -i 's/a/b/' /etc/hosts")).toEqual(["/etc/hosts"]);
    expect(blocked("sed -i.bak -e s/a/b/ src/x /etc/y")).toEqual(["/etc/y"]);
    expect(blocked("sed --in-place -n 's/a/b/p' /etc/z")).toEqual(["/etc/z"]);
    expect(blocked("perl -pi -e 's/a/b/' /etc/p")).toEqual(["/etc/p"]);
    expect(blocked("perl -i -pe 's/a/b/' /etc/q")).toEqual(["/etc/q"]);
    expect(blocked("chmod -R 755 /tmp/m")).toEqual(["/tmp/m"]);
    expect(blocked("chmod -x /tmp/n")).toEqual(["/tmp/n"]);
    expect(blocked("chown -R me:me /srv/x")).toEqual(["/srv/x"]);
    expect(blocked("truncate -s 0 /var/log/x")).toEqual(["/var/log/x"]);
    expect(blocked("dd if=/dev/zero of=/tmp/disk bs=1M count=1")).toEqual(["/tmp/disk"]);
    expect(blocked("sudo -u root tee /etc/motd < x")).toEqual(["/etc/motd"]);
    expect(blocked("FOO=1 env -i BAR=2 /bin/rm /tmp/e")).toEqual(["/tmp/e"]);
    // Non-writing uses of the same programs.
    allowed("sed 's/a/b/' /etc/hosts; perl -ne 'print' /etc/hosts; cp /etc/hosts .; ln -s /etc/hosts; cat /etc/hosts; diff /etc/a /etc/b");
    allowed("chmod 644 src/a.ts; dd if=/etc/hosts of=copy");
  });

  it("allows dynamic or unparseable targets (not a sandbox)", () => {
    allowed("echo > $TMPDIR/x; echo > \"$OUT\"; echo > `mktemp`; echo > $(mktemp); rm /tmp/*.log; touch /tmp/{a,b}; cp a ~other/x");
    allowed("echo 'unterminated > /tmp/x");
    allowed("for f in /tmp/a; do rm \"$f\"; done");
    allowed("python3 -c 'open(\"/tmp/x\",\"w\")'; bash -c 'echo > /tmp/y'");
    allowed("[[ 1 > 2 ]] && echo ok; (( 3 > 2 ))");
    allowed("x=$(echo > /tmp/hidden)");
  });

  it("handles quoting, separators, subshells, newlines and tilde", () => {
    expect(blocked("echo 'a > b' > '/tmp/q x'")).toEqual(["/tmp/q x"]);
    expect(blocked("true && echo x>/tmp/a || echo y >>/tmp/b | cat; (echo z > /tmp/c)\necho w > /tmp/d &")).toEqual(["/tmp/a", "/tmp/b", "/tmp/c", "/tmp/d"]);
    expect(blocked("echo > ~/notes.txt")).toEqual([join(process.env.HOME || homedir(), "notes.txt")]);
    expect(blocked("echo \\> x > /tmp/esc")).toEqual(["/tmp/esc"]);
    expect(blocked("cd /tmp && echo x > rel.txt")).toEqual(["/tmp/rel.txt"]);
    allowed("(cd /tmp && ls); echo x > rel.txt");
    allowed("cd \"$DIR\" && echo x > rel.txt");
    allowed("cd sub && echo x > rel.txt; cd .. && echo > y");
    expect(blocked("cd .. && echo > x")).toEqual(["/home/u/Code/x"]);
    expect(blocked("{ echo a; } > /tmp/g")).toEqual(["/tmp/g"]);
    expect(blocked("# comment > /tmp/no\necho > /tmp/yes # > /tmp/no2")).toEqual(["/tmp/yes"]);
  });

  it("blocks traversal and prefix tricks around the scratch directory", () => {
    expect(blocked(`echo > ${scratch}/../../../../etc/x`)).toEqual(["/etc/x"]);
    expect(blocked(`echo > ${scratch}-evil/x`)).toEqual([`${scratch}-evil/x`]);
  });

  it("blocks an adjacent repository unless it is an extra root, and a read-only role only gets its scratch directory", () => {
    expect(blocked(`echo x > ${sibling}/src/a.ts`, { roots: scratchOnly })).toEqual([`${sibling}/src/a.ts`]);
    expect(blocked("cp a.ts ../sibling/src/a.ts", { roots: scratchOnly })).toEqual([`${sibling}/src/a.ts`]);
    allowed(`echo x > ${sibling}/src/a.ts`);
    allowed("cp a.ts ../sibling/src/a.ts && sed -i s/a/b/ ../sibling/x");
    const verdict = check(`echo x > ${sibling}/src/a.ts`, { readOnly: true });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed ? "" : verdict.reason).toContain(`${sibling} is an extra write root, but this assignment is read-only: only the scratch directory is writable.`);
    allowed(`echo x > ${scratch}/a.txt`, { readOnly: true });
    allowed("echo x > notes.txt", { readOnly: true });
    // No scratch directory: the advice still says how to get a root.
    const bare = checkBashWrites("echo > /tmp/x", { cwd, roots: [], readOnly: false });
    expect(bare.allowed ? "" : bare.reason).not.toContain("scratch directory");
    expect(bare.allowed ? "" : bare.reason).toContain("writeRoots");
  });
});
