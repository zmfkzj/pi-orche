import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import {
  bashReviewBlockReason, DEFAULT_BASH_REVIEW, guardBashReview, needsBashReview, redactSecrets, reviewBashCommand,
  type BashReviewSettings, type ClassifierAccess,
} from "../../src/extension/bash-review.js";
import { parseBashReviewConfig } from "../../src/extension/config.js";
import { RouteConfigError } from "../../src/orchestration/routing.js";

type Answer = "yes" | "no" | ClassifierResult | Error | (() => Promise<ClassifierResult>);
/** A fake classifier (Pi's ModelRegistry/ModelRuntime shape reduced to the review's needs) that records what it was asked. */
function fakeAccess(answer: Answer | ((context: ClassifierContext, signal: AbortSignal) => Answer), known = ["typesafe/jev-latest"]) {
  const finds: string[] = [];
  const calls: { context: ClassifierContext; signal: AbortSignal }[] = [];
  const access: ClassifierAccess = {
    find: (provider, id) => { finds.push(`${provider}/${id}`); return known.includes(`${provider}/${id}`) ? { provider, id } as never : undefined; },
    classify: async (_model, context, options) => {
      calls.push({ context, signal: options.signal });
      let value = typeof answer === "function" && answer.length === 2 ? (answer as (c: ClassifierContext, s: AbortSignal) => Answer)(context, options.signal) : answer as Answer;
      if (typeof value === "function") return (value as () => Promise<ClassifierResult>)();
      if (value instanceof Error) throw value;
      if (typeof value !== "string") return value;
      return result({ run: { type: "choice", choice: value, probabilities: { yes: 0.5, no: 0.5 }, confidence: 0.8 } });
    },
  };
  return { access, finds, calls };
}
const result = (answers: Record<string, unknown>, extra: Partial<ClassifierResult> = {}): ClassifierResult =>
  ({ api: "x", provider: "typesafe", model: "jev-latest", answers, stopReason: "stop", timestamp: 0, ...extra }) as ClassifierResult;
const settings: BashReviewSettings = { ...DEFAULT_BASH_REVIEW };
const request = { command: "rm -rf build", cwd: "/work/project", task: "Clean the build output" };

describe("which Bash invocations are reviewed (best-effort write detection, bash-mutation.ts)", () => {
  it("lets recognised reads through without a review, variables and pipelines included", () => {
    for (const command of ["ls -la", "git status", "git log --oneline -5", "cat greeting.txt | grep hello", "rg TODO src", "cat \"$FILE\"", "ps aux | grep node", "echo \"rm -rf /\"", "find . -name '*.ts'", "cat a > /dev/null 2>&1", "sed -n '1,20p' f"])
      expect(needsBashReview(command), command).toBe(false);
  });
  it("reviews writes, compound commands with a write, redirections, project checks and representative indirect writes", () => {
    for (const command of [
      "rm -rf build", "echo x > out.txt", "printf x >> log.txt", "ls && rm a.txt", "git status; git commit -m x", "cat a | tee b",
      "mv a b", "cp -r src dst", "mkdir -p x", "chmod -R 755 .", "sed -i s/a/b/ f", "git push", "git reset --hard", "npm install", "npm test", "npx --no-install vitest run",
      "sudo rm -rf /var/tmp/x", "env FOO=1 rm x", "bash -c 'rm -rf x'", "sh -c \"echo x > y\"", "python3 -c 'open(\"f\",\"w\")'", "node -e 'require(\"fs\").rmSync(\"x\")'",
      "find . -name '*.o' -delete", "find . -exec rm {} +", "ls | xargs rm", "rm -rf \"$DIR/\"*", "rm -rf ~/old", "./cleanup.sh", "make clean", "curl -o x https://e.x",
    ]) expect(needsBashReview(command), command).toBe(true);
  });
  it("does not review an empty command or a non-string", () => {
    expect(needsBashReview("")).toBe(false);
    expect(needsBashReview("   ")).toBe(false);
    expect(needsBashReview(undefined)).toBe(false);
  });
});

describe("the Jev call", () => {
  it("resolves the configured classifier (default typesafe/jev-latest) and asks one binary choice question with minimal context", async () => {
    const { access, finds, calls } = fakeAccess("yes");
    expect(await reviewBashCommand({ ...request, writeRoots: ["/tmp/scratch"] }, settings, access)).toEqual({ verdict: "yes" });
    expect(finds).toEqual(["typesafe/jev-latest"]);
    expect(calls).toHaveLength(1);
    const { state, questions } = calls[0]!.context;
    expect(state).toEqual({ command: "rm -rf build", cwd: "/work/project", home: homedir(), task: "Clean the build output", extraWriteRoots: ["/tmp/scratch"] });
    expect(Object.keys(questions)).toEqual(["run"]);
    expect(questions.run).toMatchObject({ type: "choice", criteria: { yes: expect.any(String), no: expect.any(String) } });
    // An accident check, not a sandbox: ordinary out-of-cwd, network, ssh, sudo, docker, git and deployment work is named as yes.
    expect((questions.run as { instructions: string }).instructions).toMatch(/writes outside cwd, git commit and push.*ssh, sudo, docker and deployment/);
  });
  it("uses another configured classifier as is and never substitutes a different model", async () => {
    const { access, finds } = fakeAccess("no", ["openrouter/typesafe/jev-1.13"]);
    expect(await reviewBashCommand(request, { ...settings, model: "openrouter/typesafe/jev-1.13" }, access)).toEqual({ verdict: "no" });
    expect(finds).toEqual(["openrouter/typesafe/jev-1.13"]);
    const missing = fakeAccess("yes", []);
    expect(await reviewBashCommand(request, settings, missing.access)).toEqual({ verdict: "failed", reason: "classifier model typesafe/jev-latest is not in the model catalog" });
    expect(missing.calls).toHaveLength(0);
  });
  it("treats provider errors, throws and malformed or missing answers as a failed review, never as yes or no", async () => {
    const cases: Answer[] = [
      result({}, { stopReason: "error", errorMessage: "401 no TypeSafe credentials" }),
      new Error("network down"),
      result({}),
      result({ run: { type: "bool", probability: 0.99 } }),
      result({ run: { type: "choice", choice: "maybe", probabilities: {}, confidence: 1 } }),
      result({ run: { type: "choice", choice: "true", probabilities: {}, confidence: 1 } }),
      result({ run: { type: "choice", choice: "", probabilities: {}, confidence: 1 } }),
    ];
    for (const answer of cases) {
      const verdict = await reviewBashCommand(request, settings, fakeAccess(answer).access);
      expect(verdict.verdict, JSON.stringify(answer)).toBe("failed");
    }
    expect(await reviewBashCommand(request, settings, fakeAccess(result({}, { stopReason: "error", errorMessage: "401 no TypeSafe credentials" })).access)).toMatchObject({ reason: "401 no TypeSafe credentials" });
  });
  it("gives up after timeoutMs even when the provider ignores the abort signal", async () => {
    const never = fakeAccess(() => new Promise<ClassifierResult>(() => undefined));
    const started = Date.now();
    const verdict = await reviewBashCommand(request, { ...settings, timeoutMs: 1000 }, never.access);
    expect(verdict).toEqual({ verdict: "failed", reason: "no verdict within 1000ms" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(never.calls[0]!.signal.aborted).toBe(true);
  });
  it("is cancelled by the caller's signal, before the call and while waiting, and a late yes after cancellation does not count", async () => {
    const before = new AbortController(); before.abort();
    const idle = fakeAccess("yes");
    expect(await reviewBashCommand(request, settings, idle.access, before.signal)).toEqual({ verdict: "failed", reason: "cancelled", cancelled: true });
    expect(idle.calls).toHaveLength(0);

    const during = new AbortController();
    const waiting = fakeAccess(() => new Promise<ClassifierResult>(() => undefined));
    const pending = reviewBashCommand(request, settings, waiting.access, during.signal);
    await new Promise(resolve => setTimeout(resolve, 20));
    during.abort();
    expect(await pending).toEqual({ verdict: "failed", reason: "cancelled", cancelled: true });

    const late = new AbortController();
    const lateYes = fakeAccess(() => { late.abort(); return Promise.resolve(result({ run: { type: "choice", choice: "yes", probabilities: {}, confidence: 1 } })); });
    expect(await reviewBashCommand(request, settings, lateYes.access, late.signal)).toMatchObject({ verdict: "failed", cancelled: true });
  });
  it("redacts secret-looking values from the command and the task before they leave the process", async () => {
    const { access, calls } = fakeAccess("yes");
    await reviewBashCommand({ command: "GITHUB_TOKEN=ghp_abcdef123456 API_KEY='s3cr3t' curl -H 'Authorization: Bearer abcdefghijklmnop' https://bob:hunter2@example.com --password pw123 > out", cwd: "/w", task: "use DB_PASSWORD=topsecret" }, settings, access);
    const sent = JSON.stringify(calls[0]!.context.state);
    for (const secret of ["ghp_abcdef123456", "s3cr3t", "abcdefghijklmnop", "hunter2", "pw123", "topsecret"]) expect(sent).not.toContain(secret);
    expect(sent).toContain("GITHUB_TOKEN=[REDACTED]");
    expect(redactSecrets("rm -rf build")).toBe("rm -rf build");
  });
});

describe("the guard step", () => {
  const guard = (access: ClassifierAccess, extra: Partial<Parameters<typeof guardBashReview>[2]> = {}) => ({ settings, access: () => access, cwd: "/w", task: "t", ...extra });
  it("skips other tools, a disabled review and read-only commands without calling the classifier", async () => {
    const { access, calls } = fakeAccess("no");
    expect(await guardBashReview("write", { path: "x", content: "y" }, guard(access))).toBeUndefined();
    expect(await guardBashReview("bash", { command: "rm -rf x" }, guard(access, { settings: { ...settings, enabled: false } }))).toBeUndefined();
    expect(await guardBashReview("bash", { command: "rm -rf x" }, guard(access, { settings: undefined }))).toBeUndefined();
    expect(await guardBashReview("bash", { command: "git status" }, guard(access))).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
  it("yes lets the call go on; no blocks it with a rewrite-and-resubmit instruction, every time, without an automatic override", async () => {
    expect(await guardBashReview("bash", { command: "rm -rf build" }, guard(fakeAccess("yes").access))).toBeUndefined();
    const no = fakeAccess("no");
    for (let i = 0; i < 6; i++) {
      const reason = await guardBashReview("bash", { command: "rm -rf build" }, guard(no.access));
      expect(reason).toContain("answered no: this command was NOT run");
      expect(reason).toContain("then run the corrected command: it is reviewed again and runs on yes");
      expect(reason).toContain("do not route the same effect through another tool");
      expect(reason).toContain("there is no override");
    }
    expect(no.calls).toHaveLength(6);
  });
  it("a failed review blocks with a retry message that is not a no", async () => {
    const reason = await guardBashReview("bash", { command: "rm -rf build" }, guard(fakeAccess(new Error("boom")).access));
    expect(reason).toContain("gave no verdict (boom): this command was NOT run. This is not a judgment that the command is unsafe.");
    expect(await guardBashReview("bash", { command: "rm -rf build" }, { settings, access: () => undefined, cwd: "/w" })).toContain("no model registry");
    expect(bashReviewBlockReason({ verdict: "failed", reason: "cancelled", cancelled: true }, settings)).toBe("Bash safety review was cancelled: this command was NOT run.");
  });

  it("static check: a block finding stops the command without asking Jev, with a rewrite instruction; the guarded rewrite goes to Jev", async () => {
    const jev = fakeAccess("yes");
    const reason = await guardBashReview("bash", { command: "DIR=''; rm -rf \"$DIR/\"*" }, guard(jev.access));
    expect(reason).toContain("Bash safety check (static): this command was NOT run. rm $DIR/*: $DIR is assigned an empty value in this command, so the target is everything in the filesystem root.");
    expect(reason).toContain("${VAR:?} guards");
    expect(reason).toContain("then run the corrected command: it is checked again and goes on to the Jev review");
    expect(reason).toContain("there is no override");
    expect(await guardBashReview("bash", { command: "rm -rf ~" }, guard(jev.access))).toContain("targets your whole home directory");
    expect(jev.calls).toHaveLength(0);
    // Repeating it is blocked again; the corrected command reaches Jev and runs on its yes.
    expect(await guardBashReview("bash", { command: "DIR=''; rm -rf \"$DIR/\"*" }, guard(jev.access))).toContain("NOT run");
    expect(await guardBashReview("bash", { command: "DIR=build; rm -rf \"$DIR/\"*" }, guard(jev.access))).toBeUndefined();
    expect(jev.calls.map(call => call.context.state.command)).toEqual(["DIR=build; rm -rf \"$DIR/\"*"]);
    expect(jev.calls[0]!.context.state.staticFindings).toBeUndefined();
  });

  it("static check: an unknown variable (e.g. inherited from the environment) is not blocked; Jev gets the warning and its answer decides", async () => {
    const command = "rm -rf \"$DIR/\"*";
    const yes = fakeAccess("yes");
    expect(await guardBashReview("bash", { command }, guard(yes.access))).toBeUndefined();
    expect(yes.calls).toHaveLength(1);
    expect(yes.calls[0]!.context.state.staticFindings).toEqual([expect.stringContaining("if $DIR is empty or unset the target is everything in the filesystem root (its value is not known here")]);
    const no = fakeAccess("no");
    const reason = await guardBashReview("bash", { command }, guard(no.access));
    expect(reason).toContain("answered no: this command was NOT run");
    expect(reason).toContain("The static check noticed: rm $DIR/*: if $DIR is empty or unset");
    expect(no.calls).toHaveLength(1);
    const jev = fakeAccess("yes");
    // Switched off with the rest of the review.
    expect(await guardBashReview("bash", { command: "rm -rf ~" }, guard(jev.access, { settings: { ...settings, enabled: false } }))).toBeUndefined();
  });

  it("static check: warnings go to Jev as staticFindings (redacted, it decides) and are repeated in a no", async () => {
    const yes = fakeAccess("yes");
    expect(await guardBashReview("bash", { command: "rm -rf ./*" }, guard(yes.access, { cwd: "/w/proj" }))).toBeUndefined();
    expect(yes.calls[0]!.context.state.staticFindings).toEqual(["rm ./* targets everything in the whole working directory /w/proj"]);
    const no = fakeAccess("no");
    const reason = await guardBashReview("bash", { command: "rm -rf $(cat TOKEN=abc123secret)" }, guard(no.access));
    expect(reason).toContain("answered no");
    expect(reason).toContain("The static check noticed: rm target $(cat TOKEN=abc123secret) comes from a command substitution");
    expect(JSON.stringify(no.calls[0]!.context.state.staticFindings)).not.toContain("abc123secret");
  });
});

describe("bashReview in orche.config.json", () => {
  it("defaults to on with Jev and a 15 s timeout, and validates its fields", () => {
    expect(DEFAULT_BASH_REVIEW).toEqual({ enabled: true, model: "typesafe/jev-latest", timeoutMs: 15_000 });
    expect(parseBashReviewConfig({})).toEqual(DEFAULT_BASH_REVIEW);
    expect(parseBashReviewConfig({ enabled: false, model: "openrouter/typesafe/jev-1.13", timeoutMs: 5000 })).toEqual({ enabled: false, model: "openrouter/typesafe/jev-1.13", timeoutMs: 5000 });
    for (const bad of [null, [], { enabled: "yes" }, { model: "jev" }, { model: "" }, { timeoutMs: 10 }, { timeoutMs: 1.5 }, { other: 1 }])
      expect(() => parseBashReviewConfig(bad), JSON.stringify(bad)).toThrow(RouteConfigError);
  });
});
