# Four-Week MCP Evidence Review

## Mutual Action Plan for a Design Partner

This plan is for an enterprise team that wants to understand the MCP servers and agent tools already in use before approving, restricting, replacing, or monitoring them.

The pilot is a **free, four-week evidence review**. It begins with a shareable list of tool names and public evidence. It does not require production access, credentials, private source code, or installation of the tools being reviewed.

The intended outcome is a decision, not a dashboard: the customer should leave the pilot knowing which tools have usable public evidence, which facts remain unknown, which findings were wrong or incomplete, and what action to take next.

## What AgentGate does in this pilot

AgentGate creates a reviewable evidence record for the agreed tool list. The record explains:

- what material was provided and what was actually checked;
- which public sources and scanners produced each finding;
- which checks completed, failed, or were not run;
- which facts are supported, which are ambiguous, and which remain unmeasured;
- what changed in the public evidence during the pilot, when comparable snapshots exist.

Unknown evidence stays unknown. A missing public signal is not converted into a pass, and a public result is not presented as proof of the customer's production configuration.

## What this pilot does not claim

This pilot does not certify a tool, prove regulatory compliance, test production behavior, replace the customer's security review, or guarantee complete vulnerability coverage. It does not include enterprise identity, role-based access control, multi-tenant administration, enterprise retention controls, signed audit export, or SIEM integration. Those are possible future requirements, not current pilot deliverables.

The separately available paid evidence record is not part of this free pilot unless both parties agree to it in writing.

## Roles and responsibilities

| Role | Responsibilities |
| --- | --- |
| Customer pilot lead | Confirms the review scope, provides an approved tool-name list, coordinates internal feedback, and owns the final business decision. |
| Customer security or platform reviewer | Reviews findings, identifies false positives and missed context, and decides whether any tool needs approval, rejection, remediation, or further investigation. |
| AgentGate pilot lead | Records the evidence boundary, produces the reports, explains sources and limitations, tracks agreed corrections, and facilitates the final review. |

Names, dates, and communication channels are recorded in the written kickoff confirmation rather than in this reusable plan.

## Inputs and data boundary

The default starting point is a list of MCP server or agent-tool names that the customer is authorized to share. Tool names may themselves be sensitive, so the customer decides what may leave its environment.

The review can remain at the public-evidence level or expand only with explicit customer approval:

| Level | Customer-provided material | What AgentGate can assess |
| --- | --- | --- |
| Public evidence | Approved tool-name list | Public registry, package, repository, and existing indexed evidence; unmatched items remain unmeasured. |
| Redacted configuration | Redacted MCP configuration with internal addresses and secrets removed | Version pinning and visible transport or authentication signals; absence of a field does not prove absence in production. |
| Customer-run scan | Reviewed and redacted scanner output produced inside the customer's environment | The supplied output and its stated coverage; source code remains on the customer's systems. |
| Authorized read-only material | A specifically approved repository or source subset | Static review of the agreed scope; anything outside that scope remains unmeasured. |

Do not send passwords, tokens, API keys, database connection strings, internal addresses, or any material the customer is not authorized to share. AgentGate does not run the reviewed projects or their installation scripts.

## Four-week action plan

| Period | Customer action | AgentGate action | Deliverable and decision |
| --- | --- | --- | --- |
| Before the first review | Confirm the pilot lead, reviewer, authorized tool list, and chosen evidence level. | Confirm receipt, record the evidence boundary, and flag inputs that should be removed or redacted. | Written scope record and an accepted input set. |
| Week 1 | Review the inventory and identify obvious omissions, internal naming differences, and business-critical tools. | Match the list against available public evidence and issue the initial evidence report with coverage, sources, failures, and unknowns. | Initial HTML evidence report and a continuation decision. |
| Week 2 | Explain material false positives, missing context, and the decisions the customer needs the evidence to support. If policy integration is selected, approve the rule intent. | Correct confirmed interpretation errors, separate customer-owned questions from tool evidence, and optionally draft an AgentGate policy for the customer to run in its own CI. | Reviewed findings, a gap register, and an optional policy file. |
| Week 3 | Confirm any relevant tool-list or version change and, when available, run the agreed customer-side check. | Compare retained public evidence snapshots and describe visible changes, failed comparisons, and remaining gaps without reconstructing evidence that was never captured. | Change note and updated evidence record. |
| Week 4 | Decide which findings require approval, rejection, remediation, monitoring, or no action. State whether the outcome is worth paying for or operating internally. | Deliver the final report and facilitate the review of usefulness, accuracy, operating burden, and next-step economics. | Final evidence report, decision record, and explicit stop, self-host, repeat, or requirements-discovery outcome. |

The default meeting load is a final one-hour review. If policy integration is selected, the parties add a half-hour rule-confirmation session. Preparation, redaction, customer-run scanning, and CI work depend on the agreed scope.

## Week 1 continuation gate

The pilot continues only when the first review produces a useful learning signal at an acceptable customer cost. At the end of Week 1, the customer chooses one of three outcomes:

- **Continue:** the evidence reveals a material unknown, validates a known concern, or supports a real review decision.
- **Adjust scope:** the initial result is potentially useful, but tool naming, evidence level, or decision context needs correction.
- **Stop:** the evidence is irrelevant, too incomplete, or too costly to review. The customer keeps the initial report and owes no fee.

The decision should consider whether the input scope is understandable, whether the source trail can be reviewed independently, whether unknowns are visible, and whether the time required from the customer is proportionate to the value found.

## Success evidence to record

The pilot is successful only if it produces customer-observed evidence about the problem and the buying decision. The final review records the actual result for each of these questions:

- How many MCP servers or agent tools were in the agreed scope?
- How many had an unknown or unclear identity, source, version, or evidence boundary?
- Which findings were confirmed false positives, and which important facts were missed?
- Did the review cause a real approve, reject, remediate, monitor, or investigate decision?
- Was the evidence reused after a relevant tool or public-evidence change?
- Would the customer pay for the outcome, who would own that purchase, and what prerequisites would be required?

A positive comment without an operational or purchasing decision is feedback, not proof of product-market fit.

## Deliverables and acceptance

The pilot deliverables are accepted when the customer can independently identify:

- the tool list and material boundary used for the review;
- the source and reason behind each material finding;
- the checks that completed, failed, or were not performed;
- the customer-owned questions that AgentGate cannot answer;
- the corrections made after customer review;
- the decisions taken, deferred, or rejected because evidence was insufficient.

An optional evidence pack can include the machine-readable record, HTML report, AI-CAIQ mapping, file hashes, and verification seal. An optional policy file is accepted only after the customer runs it in its own environment and confirms the result.

## End-of-pilot decision

The final review ends with one explicit path:

- **Stop:** the evidence layer does not solve an important problem for this customer.
- **Self-host the open-source core:** the customer wants to operate the current capability independently.
- **Commission another fixed-scope evidence record:** the customer wants the same outcome for a new questionnaire or tool set.
- **Define a future enterprise requirement:** the customer has a real owner, purchasing path, and unmet requirement that is not yet implemented.

The pilot does not imply a subscription, endorsement, public reference, or permission to identify the customer. Any continued work, commercial terms, testimonial, case study, or public attribution requires a separate written agreement.

## Confidentiality and reporting

Pilot results are private by default. AgentGate may not identify the customer, publish the tool list, quote feedback, or use the result as a case study without explicit written permission. The customer may keep and internally share its reports subject to its own policies.

Questions and kickoff requests can be sent to `contact@智量.com` (`contact@xn--5kvo87g.com`) or opened as an issue at <https://github.com/ciceroyang/agentgate/issues> when the content is suitable for a public issue.
