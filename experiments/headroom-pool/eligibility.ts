/**
 * Eligibility records of the headroom-pool study (model-free bookkeeping): the witness author's E2/E3/E6 decision per case (a
 * rejection with its reason, or "witness" when a witness was written), and the screening table that joins E1 (environment manifest),
 * the decision and the E4/E5/E7 qualification verdict into one status per pool case. Records are appended, never rewritten.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { envManifestPath, readJsonFile, type StudyPaths } from "./cases.js";
import type { EnvManifest } from "./envbuild.js";
import type { EligibilityRule } from "./protocol.js";
import { currentVerdict, historyPath } from "./qualify.js";

export interface Decision { id: string; decision: "rejected" | "witness"; rule?: EligibilityRule; reason: string; author: string; at: string }
export const decisionPath = (paths: StudyPaths, id: string) => join(paths.out, "eligibility", `${id}.json`);

export async function recordDecision(paths: StudyPaths, decision: Omit<Decision, "at">): Promise<Decision[]> {
  const path = decisionPath(paths, decision.id);
  const list: Decision[] = existsSync(path) ? readJsonFile<Decision[]>(path) : [];
  list.push({ ...decision, at: new Date().toISOString() });
  await mkdir(join(paths.out, "eligibility"), { recursive: true });
  await writeFile(path, `${JSON.stringify(list, null, 2)}\n`);
  return list;
}

export type CaseStatus = "qualified" | "rejected" | "pending";
export interface ScreeningRow { id: string; order: number; status: CaseStatus; rule?: string; reason: string; e1: string; witnessSha256?: string }

/** One row per pool case, in pool order: the first failing rule, or qualified, or pending (pure over the records on disk). */
export function screeningTable(paths: StudyPaths, order: readonly string[]): ScreeningRow[] {
  return order.map((id, index) => {
    const env: EnvManifest | undefined = existsSync(envManifestPath(paths, id)) ? readJsonFile<EnvManifest>(envManifestPath(paths, id)) : undefined;
    const e1 = env ? (env.status === "built" ? "built" : `failed at ${env.step}`) : "not built";
    if (!env) return { id, order: index, status: "pending", reason: "environment not built", e1 };
    if (env.status !== "built") return { id, order: index, status: "rejected", rule: "E1", reason: (env.reason ?? "").split("\n")[0]!.slice(0, 300), e1 };
    const decisions: Decision[] = existsSync(decisionPath(paths, id)) ? readJsonFile<Decision[]>(decisionPath(paths, id)) : [];
    const last = decisions.at(-1);
    if (last?.decision === "rejected") return { id, order: index, status: "rejected", rule: last.rule, reason: last.reason, e1 };
    const verdict = currentVerdict(paths, id);
    if (verdict.qualified) return { id, order: index, status: "qualified", reason: verdict.detail, e1, ...(verdict.witnessSha256 ? { witnessSha256: verdict.witnessSha256 } : {}) };
    if (existsSync(historyPath(paths, id))) {
      const history = readJsonFile(historyPath(paths, id));
      const lastQualify = history.entries.filter((entry: any) => entry.kind === "qualify").at(-1);
      if (lastQualify?.verdict && !lastQualify.verdict.qualified) return { id, order: index, status: "rejected", rule: lastQualify.verdict.failed, reason: lastQualify.verdict.detail, e1 };
    }
    return { id, order: index, status: "pending", reason: last ? `decision ${last.decision}; ${verdict.detail}` : "no decision", e1 };
  });
}

export const readTextFile = (path: string): string => readFileSync(path, "utf8");
