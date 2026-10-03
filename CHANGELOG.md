# Changelog

## [Unreleased]

### Changed

- Failed, non-cancelled extension `orche_run` calls in auto mode now hand live workers and their full contexts to `orche_task`, with collision-free usable ids, roles, last tasks and remaining issues in the result. Auto delegation recovers via those workers rather than repeating the run; multi mode reports skipped handover. Successful/cancelled runs and SDK callers without the opt-in hook retain normal disposal.
- One-worker `change` runs now need only the classification coordinator decision: deterministic repository-wide execution, V1 verification, context-preserving fixes within the normal cap, and a composed implementation/verification summary. Blocked implementers and exhausted verification fail without coordinator replanning; larger changes and other classes are unchanged.

- Reused `orche_task` workers now bound earlier tool output with a cache-stable, restorable assignment-boundary projection that changes only with new clears. Affected earlier reasoning is cumulatively omitted for signature safety, and its paired Responses item IDs are dropped without breaking call/result pairing; raw session records stay complete. Added validated `taskContext` settings and clearing counts in task results/record events. `clearBetweenAssignments: false` means no new clears: existing projections stay applied unchanged, never-cleared workers stay unprojected, and dropping an existing projection requires a new worker. Other sessions do not project context, but shared validation means an invalid `taskContext` also fails `orche_run`.
- Reduced read anchors to four hex characters, omitted blank-line tags, and kept 4–16-hex backward compatibility; earlier-read anchors rebase across the tool's own edits, rejecting ambiguous surviving targets. Current read/symbol anchors always win, so re-reading resolves ambiguity.
- Compacted edit echoes to one-line context / 40 lines with long-operation collapse, and added non-blocking JS/TS parse-error feedback.
- Added JS/TS/Markdown read outlines and named-symbol reads with normal edit anchors; `outline: false` is unset and blank symbols are rejected.
- Filtered bash test/compiler/linter noise and grouped repeated grep paths, preserving diagnostics and recoverable full-output artifacts; analysis clips lines at 2,000 characters, scans their full tails for diagnostic words and reports the clip count, and skips specialized filters above 2 MB. Over-threshold specialized summaries fall back to bounded original-output previews, prioritizing middle errors over warnings and counting omitted diagnostics.
- Delegation now passes references rather than copied files/logs, and worker reports are conclusion-first with location evidence. Run worker instructions are static per role/loadout, with identity/request/language briefed in the first assignment for cache reuse.
- Rebuilt eval summaries now record the artifact directory actually read, so relocated study directories remain analysable.

### Fixed

- Directory `ast_rewrite` now checks ownership per matching file at write time, skipping and listing blocked files instead of failing the whole call. Directory rewrites never follow file symlinks or escape their target directory, and guarded sessions without a per-file guard fail closed.
- Multi-run workspace audits now include uncommitted submodule files and moved submodule HEADs. Worker-attributed HEAD moves still undergo ownership checks and retain submodule-aware checkout recovery; quiet external moves are not restored.
- Disposed workers release their sessions and adapters instead of retaining full transcripts; lightweight status and record data remain available.
- Worker startup observes cancellation and assignment deadlines. An unresponsive SDK abort is bounded to one second by default, then the worker is force-disposed so subsequent tasks can start.
- Each assignment uses its freshly resolved `limits.assignmentRequests` budget, including changes between tasks on a reused worker.

