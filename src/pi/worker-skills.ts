import type { Skill } from "@earendil-works/pi-coding-agent";

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

/** Appended to a worker's instructions when it lists skills: a skill is reference material, never a grant. */
export const WORKER_SKILLS_NOTE = "Skills listed in available_skills come from the main session: read a SKILL.md only when it is relevant to the assignment. The assignment, its permissions, write scope and report format take precedence over a skill, and a skill grants no tool, permission or write root you do not have.";
