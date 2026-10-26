/**
 * Cross-process budget ledger of the decision-audit pilot (pilot/PREREGISTRATION.md "Budget"). Every arm process's proxy reserves a
 * request's worst-case cost here BEFORE forwarding it and settles it after the response; the driver reads the same ledger for job
 * admission. One append-only JSONL file guarded by an exclusive lock file, so concurrent arms never both take the last headroom.
 *
 * Lines: {k:"r", id, unit, arm, usd} reservation · {k:"s", id, usd} settlement (actual token-priced cost) · {k:"x", id, unit, arm, reason}
 * refusal. A reservation without a settlement (a killed process) stays committed: interrupted requests count at their reservation.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

export interface LedgerState { settledUsd: number; outstandingUsd: number; committedUsd: number; byArm: Record<string, number>; reservations: number; refusals: number }

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export class Ledger {
  readonly file: string;
  private readonly lockFile: string;
  constructor(readonly dir: string, private readonly capUsd: number, private readonly marginUsd: number) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "ledger.jsonl");
    this.lockFile = join(dir, "ledger.lock");
  }

  private locked<T>(body: () => T): T {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const fd = openSync(this.lockFile, "wx");
        try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
        break;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        // A lock older than 10 s belongs to a process that died inside the (millisecond) critical section.
        try { if (Date.now() - statSync(this.lockFile).mtimeMs > 10_000) rmSync(this.lockFile, { force: true }); } catch { /* raced */ }
        if (Date.now() > deadline) throw new Error(`budget ledger lock ${this.lockFile} not acquired in 20 s`);
        sleep(5);
      }
    }
    try { return body(); } finally { rmSync(this.lockFile, { force: true }); }
  }

  /** The ledger now (no lock needed: appended lines are whole). */
  state(): LedgerState {
    const reserved = new Map<string, { usd: number; key: string }>();
    const settled = new Map<string, number>();
    let refusals = 0;
    if (existsSync(this.file)) for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.k === "r") reserved.set(entry.id, { usd: entry.usd, key: `${entry.unit}/${entry.arm}` });
      else if (entry.k === "s") settled.set(entry.id, entry.usd);
      else if (entry.k === "x") refusals++;
    }
    let settledUsd = 0, outstandingUsd = 0;
    const byArm: Record<string, number> = {};
    for (const [id, { usd, key }] of reserved) {
      const value = settled.has(id) ? settled.get(id)! : usd;
      if (settled.has(id)) settledUsd += value; else outstandingUsd += value;
      byArm[key] = (byArm[key] ?? 0) + value;
    }
    return { settledUsd, outstandingUsd, committedUsd: settledUsd + outstandingUsd, byArm, reservations: reserved.size, refusals };
  }

  /** Reserves `usd` for one request of `unit/arm`, or refuses when the global gate or the arm's cap would be passed. */
  reserve(request: { id: string; unit: string; arm: string; usd: number; armCapUsd: number }): { ok: true } | { ok: false; reason: string } {
    return this.locked(() => {
      const state = this.state();
      const armUsd = state.byArm[`${request.unit}/${request.arm}`] ?? 0;
      const limit = this.capUsd - this.marginUsd;
      const reason = state.committedUsd + request.usd > limit ? `budget: committed ${state.committedUsd.toFixed(2)} + reservation ${request.usd.toFixed(2)} USD would pass ${limit} USD`
        : armUsd + request.usd > request.armCapUsd ? `arm cap: ${request.unit}/${request.arm} committed ${armUsd.toFixed(2)} + ${request.usd.toFixed(2)} USD would pass ${request.armCapUsd} USD`
        : undefined;
      const at = new Date().toISOString();
      if (reason) { appendFileSync(this.file, `${JSON.stringify({ k: "x", id: request.id, unit: request.unit, arm: request.arm, usd: request.usd, reason, at })}\n`); return { ok: false, reason }; }
      appendFileSync(this.file, `${JSON.stringify({ k: "r", id: request.id, unit: request.unit, arm: request.arm, usd: request.usd, at })}\n`);
      return { ok: true };
    });
  }

  settle(id: string, usd: number): void {
    this.locked(() => appendFileSync(this.file, `${JSON.stringify({ k: "s", id, usd: Number(usd.toFixed(6)), at: new Date().toISOString() })}\n`));
  }
}
