/**
 * Live image-context task of the stage evaluation (experiments/stage-eval, change #2): a deterministic "GUI recording" of a
 * monitoring console as 16 PNG screenshots. The only source of the values is the pixels (no text layer, file names carry only the
 * frame number), so the agent must look at every screenshot; with 16 tool images an orche worker's request-time image budget
 * (8 images) must omit earlier ones, which is the code path the change alters. Graded by exact comparison of report.json.
 *
 *   npx tsx experiments/stage-eval/image-task.ts <fixture dir> [seed]   # writes <dir>/repo/screens/*.png, <dir>/hidden/truth.json, <dir>/task.json
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { rng } from "./protocol.js";

export const IMAGE_TASK_ID = "img-console-recording";
export const FRAMES = 16;
const NODES = ["alpha", "bravo", "cedar", "delta", "ember", "fjord", "gamma", "harbor"];
const STATUSES = ["OK", "DEGRADED", "DOWN"] as const;

export interface Frame { frame: number; node: string; cpu: number; queue: number; status: typeof STATUSES[number] }
export interface Truth { frames: Frame[]; firstQueueOver100: number | null; highestCpuNode: string; downFrames: number[] }

export function frames(seed: string): Frame[] {
  const random = rng(seed);
  return Array.from({ length: FRAMES }, (_, index) => {
    const node = NODES[Math.floor(random() * NODES.length)]!;
    const cpu = 5 + Math.floor(random() * 90);
    const queue = index < 5 ? Math.floor(random() * 90) : Math.floor(random() * 240);
    const roll = random();
    return { frame: index + 1, node, cpu, queue, status: roll < 0.6 ? "OK" : roll < 0.85 ? "DEGRADED" : "DOWN" };
  });
}

export function truthOf(list: readonly Frame[]): Truth {
  const over = list.find(frame => frame.queue > 100);
  const top = [...list].sort((a, b) => b.cpu - a.cpu || a.frame - b.frame)[0]!;
  return { frames: [...list], firstQueueOver100: over ? over.frame : null, highestCpuNode: top.node, downFrames: list.filter(frame => frame.status === "DOWN").map(frame => frame.frame) };
}

const COLORS: Record<Frame["status"], string> = { OK: "#2e7d32", DEGRADED: "#f9a825", DOWN: "#c62828" };
function svg(frame: Frame): string {
  const rows = Array.from({ length: 6 }, (_, i) => `<rect x="40" y="${300 + i * 60}" width="${300 + ((frame.cpu * (i + 3)) % 700)}" height="30" fill="#cfd8dc"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800">
<rect width="1280" height="800" fill="#eceff1"/>
<rect width="1280" height="70" fill="#263238"/>
<text x="30" y="47" font-family="DejaVu Sans" font-size="30" fill="#ffffff">Cluster Console - recording frame ${frame.frame} of ${FRAMES}</text>
<text x="40" y="140" font-family="DejaVu Sans" font-size="36" fill="#263238">Node: ${frame.node}</text>
<text x="40" y="200" font-family="DejaVu Sans" font-size="30" fill="#37474f">CPU ${frame.cpu}%   |   Queue depth ${frame.queue}</text>
<rect x="840" y="105" width="380" height="110" rx="12" fill="${COLORS[frame.status]}"/>
<text x="1030" y="175" font-family="DejaVu Sans" font-size="40" fill="#ffffff" text-anchor="middle">${frame.status}</text>
${rows}
<text x="40" y="760" font-family="DejaVu Sans" font-size="20" fill="#90a4ae">sidebar: overview | nodes | queues | alerts | settings</text>
</svg>`;
}

export const IMAGE_INSTRUCTION = [
  `The directory screens/ holds a screen recording of our cluster console as ${FRAMES} screenshots, frame-01.png to frame-${String(FRAMES).padStart(2, "0")}.png, in order. Each frame shows one node's panel: the node name, its CPU percentage, its queue depth and a status badge (OK, DEGRADED or DOWN). The values exist only in the pixels; there is no other copy.`,
  "Look at every frame and write report.json in the workspace root with exactly this shape:",
  '{"frames": [{"frame": 1, "node": "<name>", "cpu": <integer>, "queue": <integer>, "status": "OK|DEGRADED|DOWN"}, ... one entry per frame, in frame order], "firstQueueOver100": <first frame number whose queue depth is greater than 100, or null>, "highestCpuNode": "<node of the frame with the highest CPU; the earliest such frame on a tie>", "downFrames": [<frame numbers whose status is DOWN, ascending>]}',
  "Do not write any other file.",
].join("\n\n");

export async function buildFixture(dir: string, seed = "stage-eval-image-2026-11-12"): Promise<Truth> {
  const list = frames(seed);
  await mkdir(join(dir, "repo/screens"), { recursive: true });
  await mkdir(join(dir, "hidden"), { recursive: true });
  for (const frame of list) await sharp(Buffer.from(svg(frame))).png().toFile(join(dir, "repo/screens", `frame-${String(frame.frame).padStart(2, "0")}.png`));
  const truth = truthOf(list);
  await writeFile(join(dir, "hidden/truth.json"), `${JSON.stringify(truth, null, 2)}\n`);
  await writeFile(join(dir, "task.json"), `${JSON.stringify({ id: IMAGE_TASK_ID, kind: "image", title: "Read a 16-frame console recording", instruction: IMAGE_INSTRUCTION, seed }, null, 2)}\n`);
  return truth;
}

/** Exact grade of a final workspace's report.json against the hidden truth (field-level detail for the report). */
export async function gradeImage(fixture: string, workspace: string): Promise<{ passed: boolean; error?: string; checks: Record<string, { passed: boolean; detail: string }> }> {
  const truth: Truth = JSON.parse(await readFile(join(fixture, "hidden/truth.json"), "utf8"));
  const file = join(workspace, "report.json");
  if (!existsSync(file)) return { passed: false, checks: { report: { passed: false, detail: "no report.json" } } };
  let report: any;
  try { report = JSON.parse(await readFile(file, "utf8")); } catch (error) { return { passed: false, checks: { report: { passed: false, detail: `invalid JSON: ${String(error).slice(0, 200)}` } } }; }
  const wrong: string[] = [];
  for (const expected of truth.frames) {
    const got = Array.isArray(report.frames) ? report.frames.find((item: any) => item?.frame === expected.frame) : undefined;
    for (const key of ["node", "cpu", "queue", "status"] as const) if (got?.[key] !== expected[key]) wrong.push(`frame ${expected.frame} ${key}: ${JSON.stringify(got?.[key])} != ${JSON.stringify(expected[key])}`);
  }
  const checks: Record<string, { passed: boolean; detail: string }> = {
    frames: { passed: !wrong.length && Array.isArray(report.frames) && report.frames.length === truth.frames.length, detail: wrong.length ? `${wrong.length} wrong field(s): ${wrong.slice(0, 12).join("; ")}` : `${truth.frames.length} frames exact` },
    firstQueueOver100: { passed: report.firstQueueOver100 === truth.firstQueueOver100, detail: `${JSON.stringify(report.firstQueueOver100)} vs ${truth.firstQueueOver100}` },
    highestCpuNode: { passed: report.highestCpuNode === truth.highestCpuNode, detail: `${JSON.stringify(report.highestCpuNode)} vs ${truth.highestCpuNode}` },
    downFrames: { passed: JSON.stringify(report.downFrames) === JSON.stringify(truth.downFrames), detail: `${JSON.stringify(report.downFrames)} vs ${JSON.stringify(truth.downFrames)}` },
  };
  return { passed: Object.values(checks).every(check => check.passed), checks };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const truth = await buildFixture(process.argv[2]!, process.argv[3]);
  console.log(JSON.stringify({ firstQueueOver100: truth.firstQueueOver100, highestCpuNode: truth.highestCpuNode, downFrames: truth.downFrames }));
}
