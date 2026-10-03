export interface ProposedTask {
  readonly title: string;
  readonly description: string;
  readonly files: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly suggestedOwner?: string;
}
export interface BacklogProposal {
  readonly sourceAgentId: string;
  readonly items: readonly ProposedTask[];
}
export interface DeduplicatedTask extends ProposedTask {
  readonly sourceAgentIds: readonly string[];
}
export type TaskStatus = "pending" | "running" | "done" | "blocked";
export interface TaskItem {
  readonly id: string;
  readonly description: string;
  readonly owner?: string;
  readonly dependsOn?: readonly string[];
  readonly files: readonly string[];
  readonly status: TaskStatus;
}
export type BacklogIssue =
  | { type: "duplicate_id"; taskId: string }
  | { type: "missing_owner"; taskId: string }
  | { type: "unknown_owner"; taskId: string; owner: string }
  | { type: "unknown_dependency"; taskId: string; dependencyId: string }
  | { type: "dependency_cycle"; taskIds: readonly string[] }
  | { type: "file_overlap"; taskIds: readonly [string, string]; files: readonly [string, string] };

/** Repository-relative paths; retain directory intent while normalizing spelling. */
export function normalizeOwnedPath(path: string): string {
  // Root is a deterministic single-worker ownership sentinel, never an absolute host path.
  if (path === "/" || path === "./") return "/";
  const directory = /[\\/]$/.test(path);
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/") + (directory && parts.length ? "/" : "");
}

/** Only obvious duplicates: semantic reconciliation remains the coordinator's job. */
export function dedupeProposals(proposals: readonly BacklogProposal[]): readonly DeduplicatedTask[] {
  const merged = new Map<string, DeduplicatedTask>();
  for (const proposal of proposals) {
    for (const item of proposal.items) {
      const files = [...new Set(item.files.map(normalizeOwnedPath))].sort();
      const key = JSON.stringify([item.title.trim().replace(/\s+/g, " ").toLowerCase(), files]);
      const existing = merged.get(key);
      if (existing) {
        merged.set(key, { ...existing,
          sourceAgentIds: [...new Set([...existing.sourceAgentIds, proposal.sourceAgentId])],
          dependsOn: [...new Set([...(existing.dependsOn ?? []), ...(item.dependsOn ?? [])])],
        });
      } else {
        merged.set(key, { ...item, files, ...(item.dependsOn ? { dependsOn: [...item.dependsOn] } : {}), sourceAgentIds: [proposal.sourceAgentId] });
      }
    }
  }
  return [...merged.values()];
}

function overlaps(a: string, b: string): boolean {
  const left = normalizeOwnedPath(a);
  const right = normalizeOwnedPath(b);
  if (left === "/" || right === "/") return true;
  return left.replace(/\/$/, "") === right.replace(/\/$/, "") ||
    (left.endsWith("/") && right.startsWith(left)) ||
    (right.endsWith("/") && left.startsWith(right));
}

export function validateBacklog(tasks: readonly TaskItem[], knownOwners: readonly string[]): readonly BacklogIssue[] {
  const issues: BacklogIssue[] = [];
  const ids = new Set<string>();
  const owners = new Set(knownOwners);
  for (const task of tasks) {
    if (ids.has(task.id)) issues.push({ type: "duplicate_id", taskId: task.id });
    ids.add(task.id);
    if (!task.owner) issues.push({ type: "missing_owner", taskId: task.id });
    else if (!owners.has(task.owner)) issues.push({ type: "unknown_owner", taskId: task.id, owner: task.owner });
  }
  for (const task of tasks) {
    for (const dependencyId of task.dependsOn ?? []) {
      if (!ids.has(dependencyId)) issues.push({ type: "unknown_dependency", taskId: task.id, dependencyId });
    }
  }
  const byId = new Map(tasks.map(task => [task.id, task]));
  const visited = new Set<string>();
  const active: string[] = [];
  const visit = (id: string): void => {
    const cycleStart = active.indexOf(id);
    if (cycleStart >= 0) {
      issues.push({ type: "dependency_cycle", taskIds: [...active.slice(cycleStart), id] });
      return;
    }
    if (visited.has(id)) return;
    active.push(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) if (byId.has(dependency)) visit(dependency);
    active.pop();
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
  for (let i = 0; i < tasks.length; i++) {
    const a = tasks[i]!;
    for (let j = i + 1; j < tasks.length; j++) {
      const b = tasks[j]!;
      if (!a.owner || !b.owner || a.owner === b.owner) continue;
      for (const left of a.files) for (const right of b.files) {
        if (overlaps(left, right)) issues.push({ type: "file_overlap", taskIds: [a.id, b.id], files: [left, right] });
      }
    }
  }
  return issues;
}

export function readyTasks(tasks: readonly TaskItem[]): readonly TaskItem[] {
  const statuses = new Map(tasks.map(task => [task.id, task.status]));
  return tasks.filter(task => task.status === "pending" && (task.dependsOn ?? []).every(id => statuses.get(id) === "done"));
}
export function updateTaskStatus(tasks: readonly TaskItem[], taskId: string, status: TaskStatus): readonly TaskItem[] {
  if (!tasks.some(task => task.id === taskId)) throw new Error(`Unknown task: ${taskId}`);
  return tasks.map(task => task.id === taskId ? { ...task, status } : task);
}
export function isBacklogDone(tasks: readonly TaskItem[]): boolean {
  return tasks.every(task => task.status === "done");
}
export function isBacklogBlocked(tasks: readonly TaskItem[]): boolean {
  return !isBacklogDone(tasks) && !tasks.some(task => task.status === "running") && readyTasks(tasks).length === 0;
}
