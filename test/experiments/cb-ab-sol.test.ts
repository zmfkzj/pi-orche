import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha } from "../../experiments/mdsd-ab/run.js";
import { analyze, validateScores } from "../../experiments/cb-ab/analysis-r2.js";
import { BIN_MOUNT, HOME, NODE, PROVIDER_MOUNT, REPO, sandboxCommand } from "../../experiments/cb-ab/env.js";
import { packetOrder, prepareScoring, probeSelection, scoreCase, seedFor } from "../../experiments/cb-ab/sol-score.js";
import {
  BRIDGE_SCRIPT, NET_MOUNT, SANDBOX_PROXY_PORT, SUPPORT_MOUNT, bridged, hostBridge, mountProblems, parseSolCheck, runSession, solCheckScript, solPiArgs, solSandboxArgs, type SessionResult, type SessionSpec,
} from "../../experiments/cb-ab/sol-session.js";

/**
 * The round-2 evaluator harness without a model: the session sandbox (private network, Sol/high, no orche), the scorer's mounts
 * (seeded packets, rubric, filtered probes; never the key, scores, transcripts, reference fix, hidden tests or this repository), the
 * scores schema (an absent known-defect entry is incomplete, never zero) and the one re-run of an incomplete scorer session.
 */
const temps: string[] = [];
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "cb-ab-sol-test-")); temps.push(dir); return dir; };
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });
const hasBwrap = spawnSync("bwrap", ["--version"]).status === 0 && existsSync(join(HOME, ".nvm")) && existsSync(join(HOME, ".bun"));
const write = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const ARMS = ["A", "B", "C"] as const;

/** A round-1-like study: runs (meta.json, wire.jsonl), the sealed key, packets.json + packets, a cases dir with rubric and probes. */
async function fakeStudy(options: { missing?: string[] } = {}) {
  const root = await temp();
  const study = join(root, "study"), casesDir = join(root, "cases");
  const src = join(root, "src"), venv = join(root, "venv");
  write(join(src, "pkg/mod.py"), "x = 1\n"); write(join(src, "pyproject.toml"), "");
  write(join(venv, "bin/python"), "");
  const key: Record<string, unknown> = {}, index: Record<string, { label: string; packetSha256: string }[]> = {};
  for (const [n, caseId] of ["c1", "c2"].entries()) {
    const caseDir = join(casesDir, `${caseId}-task${n + 1}`);
    const prompt = `prompt ${caseId}`;
    write(join(caseDir, "case.json"), JSON.stringify({ id: caseId, order: n + 1, task: `task${n + 1}`, repo: "o/r", baseCommit: "b", projectDir: "proj", pythonPath: ".", prompt, promptSha256: sha(prompt), source: src, venv }));
    write(join(caseDir, "rubric.json"), JSON.stringify({ case: caseId, knownDefects: [{ id: "K1", title: "first", scoring: { M: "m", L: "l", S: "s" } }, { id: "K2", title: "second", scoring: { M: "m", L: "l", S: "s" } }], scope: { inScope: "x", outOfScope: "y" } }));
    write(join(caseDir, "rubric.md"), "# rubric\n");
    write(join(caseDir, "probes/k1_probe.py"), "import sys\nsys.exit(0)\n");
    write(join(caseDir, "probes/_common.py"), "X = 1\n");
    write(join(caseDir, "probes/k1_probe-pre.log"), "FAIL\n");
    write(join(caseDir, "probes/fix-minus-K1-x.patch"), "diff --git a/pkg/mod.py b/pkg/mod.py\n");
    write(join(caseDir, "probes/fix-minus-K1-x.spec.json"), "[]");
    write(join(caseDir, "probes/k1_hidden_f2p-pre.log"), "hidden test output\n");
    write(join(caseDir, "probes/e1_testcmd-pre.log"), "test command\n");
    write(join(caseDir, "probes/run_probes.sh"), "#!/bin/sh\n");
    write(join(caseDir, "probes/minus_items.log"), "--- post/pkg/mod.py\n+++ minus/pkg/mod.py\n@@ -1,3 +1,2 @@\n-x\n");
    index[caseId] = [];
    for (const arm of ARMS) for (const repeat of [1, 2]) {
      const unit = `${caseId}/${arm}/r${repeat}`, dir = join(study, "runs", unit);
      const missing = options.missing?.includes(unit);
      write(join(dir, "meta.json"), JSON.stringify({ unit, status: "completed", infra: false, pi: { code: 0, guardFired: false }, final: { report: !missing }, route: { ok: true, violations: 0, byKind: {} } }));
      write(join(dir, "wire.jsonl"), missing ? `${JSON.stringify({ method: "POST", model: "gpt-6.1-sol", status: 200, providerError: { type: "invalid_request", code: "cyber_policy" } })}\n` : "");
      const label = sha(unit).slice(0, 6);
      key[label] = { unit, arm, repeat };
      const text = `# Report ${label}\n\nreport text of a run\n`;
      write(join(study, "scoring", caseId, "packets", `${label}.md`), text);
      index[caseId]!.push({ label, packetSha256: sha(text) });
    }
    index[caseId]!.sort((a, b) => a.label.localeCompare(b.label));
  }
  write(join(study, "scoring/key.json"), JSON.stringify(key));
  write(join(study, "scoring/packets.json"), JSON.stringify({ index }));
  write(join(study, "scoring/c1/scores.json"), JSON.stringify({ case: "c1", scorer: "round 1", packets: {} }));
  const labelOf = (unit: string) => sha(unit).slice(0, 6);
  return { root, study, casesDir, caseDir: (id: string) => join(casesDir, `${id}-task${id === "c1" ? 1 : 2}`), labelOf, scratch: join(root, "scratch"), outRoot: join(root, "scoring-sol") };
}

const complete = (k = ["K1", "K2"]) => ({ k: k.map(id => ({ k: id, m: 1, l: 1, s: 0, quote: `M: "${id}" | L: "f.py:1" | S: (none)` })), findings: [{ id: "f1", claim: "c", location: "f.py:2", class: "V", reason: "r", evidence: "python -c ... -> X" }, { id: "f2", claim: "c2", class: "F", reason: "out of scope", evidence: "scope" }], notes: "" });

describe("scorer inputs and mounts", () => {
  it("stages the available packets in the seeded order, the rubric and the probes without reference-fix or hidden-test material; no mount exposes the key, scores, transcripts, fixtures or the repository", async () => {
    const s = await fakeStudy({ missing: ["c2/A/r1"] });
    const outDir = join(s.outRoot, "S1/c2");
    mkdirSync(outDir, { recursive: true });
    const plan = prepareScoring({ study: s.study, casesDir: s.casesDir, caseDir: s.caseDir("c2"), outRoot: s.outRoot, scorer: "S1", scratch: s.scratch }, outDir);
    const available = ARMS.flatMap(arm => [1, 2].map(repeat => `c2/${arm}/r${repeat}`)).filter(unit => unit !== "c2/A/r1").map(s.labelOf);
    expect(plan.order).toEqual(packetOrder(available, seedFor("S1", "c2")));
    expect(plan.excluded.map(item => [item.label, item.reason])).toEqual([[s.labelOf("c2/A/r1"), expect.stringMatching(/^run missing: no final report \(provider stop: invalid_request\/cyber_policy\)/)]]);
    expect(readdirSync(join(plan.stage, "packets"))).toEqual(plan.order.map((label, index) => `${String(index + 1).padStart(2, "0")}-${label}.md`));
    for (const item of plan.names) expect(readFileSync(join(plan.stage, "packets", item.name), "utf8")).toBe(readFileSync(join(s.study, "scoring/c2/packets", `${item.label}.md`), "utf8"));
    expect(readdirSync(join(plan.stage, "rubric")).sort()).toEqual(["rubric.json", "rubric.md"]);
    expect(readdirSync(join(plan.stage, "probes")).sort()).toEqual(["_common.py", "k1_probe-pre.log", "k1_probe.py"]);
    const inputs = JSON.parse(readFileSync(join(outDir, "inputs.json"), "utf8"));
    expect(inputs.probes.excluded.map((item: any) => item.name).sort()).toEqual(["e1_testcmd-pre.log", "fix-minus-K1-x.patch", "fix-minus-K1-x.spec.json", "k1_hidden_f2p-pre.log", "minus_items.log", "run_probes.sh"]);
    expect(inputs.seed).toBe("cb-ab-r2-2026-10-24/part-r/S1/c2");
    // The mount plan is safe; the forbidden list covers the key, round-1 scores, transcripts, other scorers, the cases, the fixtures.
    expect(mountProblems(plan.mounts, plan.forbidden)).toEqual([]);
    expect(plan.forbidden).toEqual(expect.arrayContaining([join(s.study, "scoring/key.json"), join(s.study, "scoring"), join(s.study, "runs"), s.outRoot, s.casesDir, join(REPO, "fixtures")]));
    for (const mount of plan.mounts) if (mount.kind !== "empty") expect(mount.host.startsWith(s.study) || mount.host.startsWith(s.casesDir) || mount.host.startsWith(REPO)).toBe(false);
    const bad = (host: string) => mountProblems([{ kind: "ro", host, sandbox: join(HOME, "eval/x"), purpose: "test" }], plan.forbidden);
    expect(bad(s.study).join("\n")).toMatch(/contains the forbidden path .*scoring\/key\.json/);
    expect(bad(join(s.study, "scoring/c1")).join("\n")).toMatch(/lies inside the forbidden path .*scoring/);
    expect(bad(join(s.study, "runs/c1/A/r1")).join("\n")).toMatch(/lies inside the forbidden path .*runs/);
    expect(bad(join(REPO, "fixtures/advisor-bench/swe/python-markdown__markdown-1587/reference")).join("\n")).toMatch(/lies inside the forbidden path .*fixtures/);
    expect(bad(REPO).join("\n")).toMatch(/contains the forbidden path/);
    expect(bad(dirname(REPO)).join("\n")).toMatch(/contains the forbidden path/);
    // The prompt lists the packets in order and the known defects; no arm, repeat or unit.
    expect(plan.prompt).toContain(plan.names.map((item, index) => `  ${index + 1}. \`${item.name}\` (report ${item.label})`).join("\n"));
    expect(plan.prompt).toMatch(/- K1: first\n- K2: second/);
    expect(plan.prompt).not.toMatch(/\barm\b|\/A\/r1|\brepeat\b|key\.json/);
  });

  it("probe selection: patches, hunk specs, diffs, hidden-test logs and run_probes.sh are excluded with a reason", async () => {
    const dir = await temp();
    write(join(dir, "a.py"), "print(1)\n"); write(join(dir, "sub/b.py"), "x\n"); write(join(dir, "x.diff"), "d"); write(join(dir, "hidden_tests-post.log"), "h");
    write(join(dir, "notes.txt"), "context\n@@ -10,2 +10,3 @@ def f():\n");
    const selection = probeSelection(dir);
    expect(selection.include.map(item => item.name).sort()).toEqual(["a.py", "sub/b.py"]);
    expect(Object.fromEntries(selection.exclude.map(item => [item.name, item.reason]))).toEqual({ "x.diff": expect.stringMatching(/patch/), "hidden_tests-post.log": expect.stringMatching(/hidden-test/), "notes.txt": expect.stringMatching(/diff/) });
  });

  it("seeded packet order: deterministic, a permutation, independent of the input order, different for S1 and S2", () => {
    const labels = ["0395e5", "10f694", "90f8d1", "aee83f", "d6bae5", "e50e1c"];
    const s1 = packetOrder(labels, seedFor("S1", "c1"));
    expect(s1).toEqual(["d6bae5", "aee83f", "10f694", "e50e1c", "90f8d1", "0395e5"]);
    expect(packetOrder([...labels].reverse(), seedFor("S1", "c1"))).toEqual(s1);
    expect([...s1].sort()).toEqual(labels);
    const s2 = packetOrder(labels, seedFor("S2", "c1"));
    expect(s2).toEqual(["e50e1c", "0395e5", "10f694", "aee83f", "d6bae5", "90f8d1"]);
    expect(s2).not.toEqual(s1);
    expect(seedFor("S1", "c1")).not.toBe(seedFor("S2", "c1"));
  });
});

describe("scores schema", () => {
  it("a missing known-defect entry, a point other than 0/1, no quote, a duplicate entry or no findings array make a packet incomplete (never a zero); a complete packet is scored with its V/F/U counts", () => {
    const labels = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
    const raw = { case: "c1", packets: {
      p1: complete(),
      p2: { ...complete(), k: complete().k.filter(item => item.k !== "K2") },
      p3: { ...complete(), k: complete().k.map(item => item.k === "K1" ? { ...item, m: 2 } : item) },
      p4: { ...complete(), k: complete().k.map(item => item.k === "K2" ? { ...item, quote: " " } : item) },
      p5: { k: complete().k, notes: "" },
      p6: { ...complete(), k: [...complete().k, complete().k[0]] },
      extra: complete(),
    } };
    const result = validateScores(raw, labels, ["K1", "K2"]);
    expect(result.packets.p1).toMatchObject({ status: "scored", problems: [], counts: { V: 1, F: 1, U: 0 } });
    expect(result.packets.p2).toMatchObject({ status: "incomplete", problems: ["K2: no entry"] });
    expect(result.packets.p3!.problems).toEqual(["K1: m is 2, not 0 or 1"]);
    expect(result.packets.p4!.problems).toEqual(["K2: no quote"]);
    expect(result.packets.p5!.problems).toEqual(["no findings array"]);
    expect(result.packets.p6!.problems).toEqual(["K1: 2 entries"]);
    expect(result.packets.p7).toMatchObject({ status: "incomplete", problems: ["no entry for this packet"] });
    expect(result.incomplete).toEqual(["p2", "p3", "p4", "p5", "p6", "p7"]);
    expect(result.unknownLabels).toEqual(["extra"]);
    expect(validateScores(undefined, ["p1"], ["K1"])).toMatchObject({ parsed: false, incomplete: ["p1"] });
    const evidence = validateScores({ packets: { p1: { ...complete(), findings: [{ id: "f1", claim: "c", class: "V" }, { id: "f2", claim: "c", class: "X" }] } } }, ["p1"], ["K1", "K2"]).packets.p1!;
    expect(evidence.status).toBe("incomplete");
    expect(evidence.problems).toEqual(['finding f2: class "X" is not V, F or U']);
    expect(evidence.warnings).toEqual(["finding f1 (V): no evidence recorded"]);
  });
});

describe("scorer re-run rule", () => {
  /** A stand-in session: writes the planned scores.json into its collected output, never runs a model. */
  const fakeRunner = (outputs: ((order: string[]) => unknown)[], calls: SessionSpec[]) => async (spec: SessionSpec): Promise<SessionResult> => {
    calls.push(spec);
    const order = [...spec.prompt.matchAll(/\(report ([0-9a-f]{6})\)/g)].map(match => match[1]!);
    const out = join(spec.outDir, "attempts/1/outputs/out");
    mkdirSync(out, { recursive: true });
    const raw = outputs[calls.length - 1]!(order);
    if (raw !== undefined) writeFileSync(join(out, "scores.json"), JSON.stringify(raw));
    writeFileSync(join(spec.outDir, "session.json"), "{}");
    const final = { n: 1, dir: join(spec.outDir, "attempts/1"), status: "completed" as const, successfulRequests: 3, infra: false, route: { ok: true, requests: 3, posts: 3, violations: 0, byKind: {} }, outputs: { out }, exit: 0 };
    return { dir: spec.outDir, label: spec.label, attempts: [final], final, routeOk: true, costUSD: 0.01, requests: 3, scratchDir: join(spec.scratch, "none") };
  };
  const all = (order: string[], skip?: string) => ({ case: "c1", packets: Object.fromEntries(order.map(label => [label, label === skip ? { ...complete(), k: complete(["K1"]).k } : complete()])) });

  it("a complete first session is used as is; an incomplete one is re-run once and the re-run is used; incomplete again -> unscored (its entry kept verbatim, never zero)", async () => {
    const s = await fakeStudy();
    const job = { study: s.study, casesDir: s.casesDir, caseDir: s.caseDir("c1"), outRoot: s.outRoot, scratch: s.scratch, log: () => undefined };
    const once: SessionSpec[] = [];
    const first = await scoreCase({ ...job, scorer: "S1", runner: fakeRunner([order => all(order)], once) });
    expect(first).toMatchObject({ status: "done", finalRun: 1, compliant: true, scored: 6, unscored: 0, runs: 1 });
    expect(once).toHaveLength(1);
    const scores = JSON.parse(readFileSync(join(s.outRoot, "S1/c1/scores.json"), "utf8"));
    expect(scores.scorer).toEqual({ model: "cliproxyapi/gpt-6.1-sol", thinking: "high", scorerId: "S1", seed: "cb-ab-r2-2026-10-24/part-r/S1/c1" });
    expect(Object.keys(scores)).toEqual(["case", "scorer", "packets"]);
    expect(await scoreCase({ ...job, scorer: "S1", runner: fakeRunner([], []) })).toMatchObject({ status: "skipped" });

    let target = "";
    const twice: SessionSpec[] = [];
    const rerun = await scoreCase({ ...job, scorer: "S2", runner: fakeRunner([order => { target = order[2]!; return all(order, target); }, order => all(order)], twice) });
    expect(twice).toHaveLength(2);
    expect(twice.map(spec => spec.outDir.split("/").at(-1))).toEqual(["run-1", "run-2"]);
    expect(twice[0]!.prompt).toBe(twice[1]!.prompt);
    expect(rerun).toMatchObject({ finalRun: 2, scored: 6, unscored: 0 });
    const validation = JSON.parse(readFileSync(join(s.outRoot, "S2/c1/validation.json"), "utf8"));
    expect(validation.runs.map((run: any) => run.incomplete)).toEqual([[target], []]);

    const s2 = await fakeStudy();
    const stuck: SessionSpec[] = [];
    let missing = "";
    const unscored = await scoreCase({ study: s2.study, casesDir: s2.casesDir, caseDir: s2.caseDir("c1"), outRoot: s2.outRoot, scratch: s2.scratch, log: () => undefined, scorer: "S1", runner: fakeRunner([order => { missing = order[0]!; return all(order, missing); }, order => all(order, missing)], stuck) });
    expect(stuck).toHaveLength(2);
    expect(unscored).toMatchObject({ finalRun: 2, scored: 5, unscored: 1 });
    const final = JSON.parse(readFileSync(join(s2.outRoot, "S1/c1/validation.json"), "utf8"));
    expect(final.packets[missing]).toBe("unscored");
    expect(final.problems[missing]).toEqual(["K2: no entry"]);
    expect(JSON.parse(readFileSync(join(s2.outRoot, "S1/c1/scores.json"), "utf8")).packets[missing].k.map((item: any) => item.k)).toEqual(["K1"]);
    // The analysis leaves the unscored packet out of the analysis set; nothing fills its K2 with a zero.
    const analysis = analyze(s2.study, s2.casesDir, s2.outRoot, "S1");
    const row = analysis.runs.find(item => item.label === missing)!;
    expect(row).toMatchObject({ packetStatus: "unscored", inSet: false, packetProblems: ["K2: no entry"] });
    expect(row.k).toBeUndefined();
    const c1 = analysis.cases.find(item => item.caseId === "c1")!;
    expect(c1.n[row.arm]).toBe(1);
    expect(c1.reproducibility[row.arm]).toBe("n/a");
    expect(c1.leftOut).toEqual([{ unit: row.unit, why: "packet unscored: K2: no entry" }]);
  });

  it("a missing scores.json counts every packet incomplete (re-run once)", async () => {
    const s = await fakeStudy();
    const calls: SessionSpec[] = [];
    const outcome = await scoreCase({ study: s.study, casesDir: s.casesDir, caseDir: s.caseDir("c2"), outRoot: s.outRoot, scratch: s.scratch, scorer: "S1", log: () => undefined, runner: fakeRunner([() => undefined, order => all(order)], calls) });
    expect(calls).toHaveLength(2);
    expect(outcome).toMatchObject({ finalRun: 2, scored: 6 });
    expect(JSON.parse(readFileSync(join(s.outRoot, "S1/c2/validation.json"), "utf8")).runs[0].outputError).toBe("no ~/eval/out/scores.json");
  });
});

describe("evaluator session sandbox", () => {
  const layout = (root: string) => ({ agent: join(root, "agent"), provider: join(root, "provider"), bin: join(root, "bin"), support: join(root, "support"), net: join(root, "net"), scratch: join(root, "scratch"), cwd: join(HOME, "work"), mounts: [{ host: join(root, "work"), sandbox: join(HOME, "work"), writable: true }, { host: join(root, "in"), sandbox: join(HOME, "in"), writable: false }] });

  it("private PID and network namespaces, empty home, provider only (no orche runtime), explicit mounts; Pi on Sol/high in JSON mode without project context files", () => {
    const args = solSandboxArgs(layout("/s"));
    const pairs = (flag: string) => args.flatMap((arg, index) => arg === flag ? [[args[index + 1], args[index + 2]]] : []);
    expect(args.slice(0, 8)).toEqual(["--dev-bind", "/", "/", "--die-with-parent", "--unshare-pid", "--unshare-net", "--proc", "/proc"]);
    expect(args.indexOf(HOME)).toBeLessThan(args.indexOf("/s/agent"));
    expect(pairs("--ro-bind")).toEqual(expect.arrayContaining([["/s/provider", PROVIDER_MOUNT], ["/s/bin", BIN_MOUNT], ["/s/support", SUPPORT_MOUNT], ["/s/in", join(HOME, "in")]]));
    expect(pairs("--bind")).toEqual([["/s/agent", join(HOME, ".pi/agent")], ["/s/net", NET_MOUNT], ["/s/work", join(HOME, "work")], ["/s/scratch", "/tmp/pi-orche"]]);
    expect(args.join(" ")).not.toMatch(/orche-runtime|node_modules/);
    expect(args.slice(-2)).toEqual(["--chdir", join(HOME, "work")]);
    const pi = solPiArgs("sid-1", "PROMPT");
    expect(pi.join(" ")).toContain("--no-extensions --no-skills --no-prompt-templates --no-mcp --no-approve --no-context-files -e");
    expect(pi.join(" ")).toContain("--model cliproxyapi/gpt-6.1-sol --thinking high --mode json --session-id sid-1");
    expect(pi.filter(arg => arg.endsWith(".ts"))).toEqual([join(PROVIDER_MOUNT, "extensions/index.ts")]);
    expect(pi.join(" ")).not.toMatch(/xhigh|\bmax\b|orche/);
    expect(bridged(["x"]).slice(-3)).toEqual([join(NET_MOUNT, "s"), "--", "x"]);
  });

  it("the sandbox check refuses a reachable upstream or external address, an unreachable bridge, a visible repository, extra home entries and host paths in the process list", () => {
    const good = ["home: .bun .local .nvm .pi work", "tmp: pi-orche", `pwd: ${join(HOME, "work")}`, "git-worktree-exit: 128", "repo-visible: no", "bridge: reachable", "upstream: ECONNREFUSED", "external: ENETUNREACH", "pid1-options: --args 3 --"].join("\n");
    const expectations = { cwd: join(HOME, "work"), homeEntries: [".bun", ".local", ".nvm", ".pi", "work"] };
    expect(parseSolCheck(good, expectations)).toMatchObject({ ok: true, problems: [] });
    const bad = good.replace("upstream: ECONNREFUSED", "upstream: reachable").replace("external: ENETUNREACH", "external: reachable").replace("bridge: reachable", "bridge: ECONNREFUSED").replace("repo-visible: no", "repo-visible: yes").replace("work\n", "work Code\n").replace("--args 3 --", "--bind /home/x");
    expect(parseSolCheck(bad, expectations).problems).toEqual([
      expect.stringMatching(/^home shows/), "the repository is visible", "the proxy bridge is not reachable (ECONNREFUSED)", "the upstream CLIProxyAPI is reachable directly", "an external address is reachable", expect.stringMatching(/^host paths/),
    ]);
    expect(mountProblems([{ kind: "empty", sandbox: "/srv/x", purpose: "t" }, { kind: "empty", sandbox: join(HOME, ".pi/agent/x"), purpose: "t" }, { kind: "empty", sandbox: join(HOME, "a"), purpose: "t" }, { kind: "empty", sandbox: join(HOME, "a"), purpose: "t" }])).toEqual([
      "/srv/x: a session mount must lie below the empty home", `${join(HOME, ".pi/agent/x")}: below a reserved home entry (.pi, .local, .nvm, .bun, .venvs)`, `${join(HOME, "a")}: mounted twice`,
    ]);
  });

  it("a session never uses the repository or /tmp itself as its scratch", async () => {
    const base = { outDir: join(await temp(), "out"), label: "x", prompt: "p", cwd: join(HOME, "w"), mounts: [] };
    await expect(runSession({ ...base, scratch: join(REPO, "tmp-scratch") })).rejects.toThrow(/outside the repository/);
    await expect(runSession({ ...base, scratch: "/tmp" })).rejects.toThrow(/not \/tmp itself/);
  });

  it.skipIf(!hasBwrap)("live: inside the sandbox only the bridge reaches out (to this session's host socket); the upstream port and external addresses are unreachable; no host path in the process list", async () => {
    const root = await temp();
    const l = layout(root);
    for (const dir of [l.agent, l.provider, l.bin, l.support, join(l.scratch, "tmp"), join(root, "work"), join(root, "in")]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(l.support, "bridge.mjs"), BRIDGE_SCRIPT);
    const net = join(root, "n"); mkdirSync(net); l.net = net;
    const upstream = createServer(socket => socket.end("pong-from-host\n"));
    await new Promise<void>(done => upstream.listen(0, "127.0.0.1", () => done()));
    const bridge = await hostBridge(join(net, "s"), (upstream.address() as any).port);
    try {
      const box = solSandboxArgs(l);
      const ask = `node -e 'require("net").connect(${SANDBOX_PROXY_PORT},"127.0.0.1").on("data",d=>process.stdout.write("reply: "+d))'`;
      const run = sandboxCommand(box, join(root, "sandbox.args"), bridged(["/bin/sh", "-c", `${solCheckScript(false)}\n${ask}`]));
      const output = await new Promise<string>((done, fail) => {
        const child = spawn(run.command, run.args, { env: { HOME, PATH: [dirname(NODE), "/usr/bin", "/bin"].join(":"), TMPDIR: "/tmp/pi-orche/tmp" } });
        let text = "";
        child.stdout.on("data", chunk => { text += String(chunk); });
        child.stderr.on("data", chunk => { text += String(chunk); });
        child.on("error", fail);
        child.on("close", () => done(text));
      });
      expect(output).toContain("reply: pong-from-host");
      const parsed = parseSolCheck(output, { cwd: join(HOME, "work"), homeEntries: [".bun", ".local", ".nvm", ".pi", "work", "in"] });
      expect(parsed.problems).toEqual([]);
      expect(parsed.values.upstream).not.toBe("reachable");
      expect(parsed.values.external).not.toBe("reachable");
    } finally {
      await new Promise<void>(done => bridge.close(() => done()));
      await new Promise<void>(done => upstream.close(() => done()));
    }
  }, 30_000);
});
