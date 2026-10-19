# Synthetic evaluation corpus

These fixtures are invented, deterministic normalized evidence. They contain no
merchant, customer, credential, or private-store data and never make a network
request.

`rule-cases.json` contains eight cases for each deterministic contradiction rule:
ST-001, ST-002, and ST-003. Each case declares independent ground truth and the
expected detector result. Positive means that a contradiction exists, negative
means that the observed evidence is consistent, and inconclusive means that the
available evidence cannot support either conclusion.

The evaluation runner validates the manifest before calculating its reproducible
confusion matrix and per-rule precision report.
