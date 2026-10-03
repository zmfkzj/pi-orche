# Keyed background queue
service.mjs adapts records to the scheduler; jobs.mjs normalizes keys; retry.mjs is used only by callers, never by the scheduler. Queue functions are injected, so regression tests need no clock sleeps.
