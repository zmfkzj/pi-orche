# Witness-replay pilot

This is an experimental harness, not product behaviour.

It tests whether enforcing an unadapted public reproducer at candidate acceptance (arm T) repairs more than ordinary bounded revision (arm C).

- Harness and commands: `experiments/witness-replay/README.md`.
- R1 audit: `results/witness-replay/AUDIT.md`.
- Report and cost ledger: `results/witness-replay/REPORT.md` and `results/witness-replay/costs.json`.

Status: the pilot stopped at the R1 prerequisite, so efficacy is untested. Only the HF family qualified. Narwhals was re-checked on native PySpark: its seed already passes the issue's reproduction. tox's preservation case is not sufficiently justified publicly. No counted revision session ran.
