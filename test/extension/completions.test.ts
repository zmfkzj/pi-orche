import { afterEach, describe, expect, it } from "vitest";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { parseOrcheCommand } from "../../src/extension/index.js";
import { completeOrcheArguments, orcheCompletions } from "../../src/extension/completions.js";
import { MAIN_MODES } from "../../src/orchestration/routing.js";
import { createHarness, type Harness } from "./harness.js";

const values = (prefix: string, ids: string[] = []) => completeOrcheArguments(prefix, ids)?.map(item => item.value) ?? null;
const open: Harness[] = [];
afterEach(async () => { for (const h of open.splice(0)) await h.dispose(); });

describe("/orche argument completions", () => {
  it("offers every subcommand on empty input, mode values from MAIN_MODES, without duplicates", () => {
    const all = values("")!;
    expect(new Set(all).size).toBe(all.length);
    for (const mode of MAIN_MODES) expect(all).toEqual(expect.arrayContaining([`${mode} `, `mode ${mode}`]));
    expect(all).toEqual(expect.arrayContaining(["mode", "workers", "stop all", "records", "splits", "models", "cancel", "detach"]));
  });

  it("completes the whole argument string, including nested choices", () => {
    expect(values("mode d")).toEqual(["mode direct"]);
    expect(values("mode")).toEqual(["mode", ...MAIN_MODES.map(mode => `mode ${mode}`), "models"]);
    expect(values("mode ")).toEqual(MAIN_MODES.map(mode => `mode ${mode}`));
    expect(values("s")).toEqual([...MAIN_MODES.filter(mode => mode.startsWith("s")).map(mode => `${mode} `), "stop all", "splits"]);
    expect(values("  wo")).toEqual(["workers"]);
    expect(values("stop W", ["W1", "W2"])).toEqual(["stop W1", "stop W2"]);
  });

  it("offers nothing for unknown tokens, a lone exact match or a free prompt", () => {
    expect(values("xyz")).toBeNull();
    expect(values("workers")).toBeNull();
    expect(values("mode direct")).toBeNull();
    expect(values("single ")).toBeNull();
    expect(values("single fix the s")).toBeNull();
    expect(values("direct mode")).toBeNull();
    expect(values("mode  d")).toBeNull();
  });

  it("skips worker ids that would duplicate `stop all` or not parse as one token", () => {
    expect(values("stop ", ["all", "W1", "W1", "bad id"])).toEqual(["stop all", "stop W1"]);
  });

  it("every complete candidate parses; prompt modes parse once a prompt follows", () => {
    for (const { value } of orcheCompletions(["W1"])) {
      expect(parseOrcheCommand(value.endsWith(" ") ? `${value}do it` : value), value).toBeDefined();
    }
  });

  it("works through Pi's autocomplete provider: the selection replaces the whole argument", async () => {
    const h = await createHarness({ mainSteps: [], orcheSteps: [], mainMode: "direct" }); open.push(h);
    const command = h.session.extensionRunner.getCommand("orche")!;
    expect(command.getArgumentCompletions).toBeTypeOf("function");
    const provider = new CombinedAutocompleteProvider([{ name: command.invocationName, description: command.description, getArgumentCompletions: command.getArgumentCompletions }], h.cwd);
    const names = await provider.getSuggestions(["/orc"], 0, 4, { signal: new AbortController().signal });
    expect(names?.items.map(item => item.value)).toEqual(["orche"]);
    const line = "/orche mode d";
    const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
    expect(suggestions?.items.map(item => item.value)).toEqual(["mode direct"]);
    expect(provider.applyCompletion([line], 0, line.length, suggestions!.items[0]!, suggestions!.prefix).lines).toEqual(["/orche mode direct"]);
    const prompt = "/orche single fix the s";
    expect(await provider.getSuggestions([prompt], 0, prompt.length, { signal: new AbortController().signal })).toBeNull();
  });
});
