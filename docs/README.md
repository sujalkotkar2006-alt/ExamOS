# ExamOS documentation

Start with the problem statement, current status, and roadmap. Future coding sessions should also load the repository's [AGENTS.md](../AGENTS.md).

## Product direction and development

| Document                                  | Purpose                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| [Problem statement](PROBLEM-STATEMENT.md) | Canonical user-supplied scope and technical requirements                        |
| [Requirements](REQUIREMENTS.md)           | Stable requirement IDs, current gaps, and acceptance evidence                   |
| [Roadmap](ROADMAP.md)                     | Prioritized backlog, dependencies, release gates, and first implementation task |
| [Project status](PROJECT-STATUS.md)       | Current checkout, observed checks, limitations, and handoff                     |
| [Project memory](PROJECT-MEMORY.md)       | Durable intent, decisions, boundaries, and next action                          |
| [Contributing](../CONTRIBUTING.md)        | Requirement-based change and review workflow                                    |
| [Testing](TESTING.md)                     | Existing checks, environment prerequisites, and evidence rules                  |
| [Architecture](../ARCHITECTURE.md)        | Current components, storage, and lifecycle                                      |
| [Application README](../README.md)        | Setup, LAN configuration, and application usage                                 |

## Individual exam review

[Event review and manual exam controls](EVENT-REVIEW.md) describes the current human-review flow, timer policy, API, audit and limitations.

## Existing feature and verification documents

| Document                                                       | Purpose                                                          |
| -------------------------------------------------------------- | ---------------------------------------------------------------- |
| [Current publication verification](../CURRENT-VERIFICATION.md) | Upstream hardware/build results, including incomplete acceptance |
| [Historical validation](../VALIDATION.md)                      | Earlier baseline; later reports may supersede individual claims  |
| [Question papers](../QUESTION-PAPERS.md)                       | PDF assignment, student exams, and server timing                 |
| [Enrollment](../ENROLLMENT-FIX.md)                             | Code lifecycle, credential reuse, and transport recovery         |
| [Same-PC workflow](../SAME-PC-TEST.md)                         | Manual Windows workflow                                          |
| [Live proctoring](../LIVE-PROCTORING.md)                       | Consented camera analysis and limited examination environment    |
| [Automatic evidence](../AUTOMATIC-EVIDENCE.md)                 | Event snapshots, silent clips, and review history                |
| [Evidence Centre](../EVIDENCE-CENTRE-FIX.md)                   | Evidence catalog and camera-check implementation                 |
| [Distribution](../REPOSITORY-DISTRIBUTION.md)                  | Source, model, binary, and private-data boundaries               |

The problem statement governs scope. The requirements matrix governs completion. Status records evidence for a particular checkout; roadmap items describe future work. Older reports never establish acceptance for a different build or environment.
