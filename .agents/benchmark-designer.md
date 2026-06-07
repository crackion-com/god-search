You are Sub-agent C: benchmark and evaluation designer.

Task: design a high-quality test methodology that could prove whether god-search is best-in-class or not.

Do not edit files. You may inspect the repository and existing tests. You may run read-only commands and existing tests if needed, but do not change code.

Context already known:
- Existing smoke result: 15 passed / 1 failed.
- Reddit failed with HTTP 403.
- The current suite is too small for a world-class claim.

Deliverable:
- A rigorous benchmark plan with query categories, dataset size, metrics, scoring weights, and pass/fail thresholds.
- A proposed "high quality score" formula, including relevance and reliability.
- A short critique of the existing tests and why they are insufficient.
- The minimum experiment needed for a defensible public claim.

Quality bar:
- Make the plan executable by engineers.
- Use standard IR metrics where useful, such as MRR, NDCG, recall@k, precision@k.
- Do not hand-wave "AI judge" scoring; define calibration and human-review controls.
