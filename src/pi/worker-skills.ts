import { readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { parseFrontmatter, type Skill, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";

/**
 * Skill metadata a worker session lists in its `available_skills` prompt section: copies of the skills the main session's Pi
 * resource loader discovered (global, project and package skills, after `--no-skills`/settings). Only the name, description and
 * absolute `SKILL.md` location travel; no skill body is read here, and nothing else of main (its extensions, hooks, tools,
 * conversation or extension state) comes with them. Skills marked `disable-model-invocation` stay out, as Pi leaves them out of
 * main's own prompt.
 */
export function workerSkills(skills: readonly Skill[] | undefined): Skill[] {
  return (skills ?? [])
    .filter(skill => !skill.disableModelInvocation && typeof skill.name === "string" && typeof skill.filePath === "string")
    .map(skill => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      sourceInfo: { ...skill.sourceInfo },
      disableModelInvocation: false,
    }));
}

/**
 * The same metadata when main has not run yet in this extension runtime (after a session start or `/reload`) and a worker starts
 * anyway. On Pi 1.2.0 and later every run that starts while idle emits `before_agent_start` (`messageType` `"user"` or
 * `"custom"`), so a run's workers have the event's list; an older Pi host (orche's peer range is `*`) emits none for a run that
 * a `triggerTurn` message started (a session-bus wake, an orche result, another extension's notice). Pi lists every skill its
 * loader has, the list main's own prompt is built from, as a `skill:<name>` slash command with the `SKILL.md` path in
 * `sourceInfo.path` (`pi.getCommands()`). The command does not carry `disable-model-invocation`, so that frontmatter flag is read
 * from the listed file; a file that cannot be read or parsed is left out. Nothing beyond that list is searched, so `--no-skills`,
 * settings and package filters keep applying.
 */
export function discoveredSkills(commands: readonly SlashCommandInfo[] | undefined): Skill[] {
  const skills: Skill[] = [];
  for (const command of commands ?? []) {
    if (command?.source !== "skill" || !command.name.startsWith("skill:")) continue;
    const filePath = command.sourceInfo?.path;
    if (typeof filePath !== "string" || !isAbsolute(filePath)) continue;
    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = parseFrontmatter(readFileSync(filePath, "utf8")).frontmatter;
    } catch {
      continue;
    }
    if (frontmatter["disable-model-invocation"] === true) continue;
    skills.push({
      name: command.name.slice("skill:".length),
      description: command.description ?? "",
      filePath,
      baseDir: dirname(filePath),
      sourceInfo: { ...command.sourceInfo },
      disableModelInvocation: false,
    });
  }
  return skills;
}

/** Appended to a worker's instructions when it lists skills: a skill is reference material, never a grant. */
export const WORKER_SKILLS_NOTE = "Skills listed in available_skills come from the main session: read a SKILL.md only when it is relevant to the assignment. The assignment, its permissions, write scope and report format take precedence over a skill, and a skill grants no tool, permission or write root you do not have.";
