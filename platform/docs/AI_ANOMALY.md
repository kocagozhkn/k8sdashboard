# AI-assisted anomaly detection & remediation (bonus path)

## Anomaly detection

1. **Batch:** Nightly job exports per-cluster node/pod metrics (Prometheus range queries) to Parquet in object storage.
2. **Model:** Train isolation forest or autoencoder on CPU/memory/disk saturation, restart rates, pending pod counts.
3. **Score:** Write `anomaly_scores` (cluster_id, window_start, score, features JSON) to PostgreSQL.
4. **UI:** Highlight clusters above threshold on the dashboard.

## Suggested remediation (human-in-the-loop)

1. Build a prompt template with **redacted** metrics (no pod names if policy requires).
2. LLM returns ranked checklist: e.g. “check node pressure”, “review PDB vs rollout”, “inspect quota”.
3. Store suggestions in `remediation_suggestions` with `approved_by NULL` until an operator acknowledges.

Never auto-apply destructive kubectl without explicit policy gates and audit logs.
