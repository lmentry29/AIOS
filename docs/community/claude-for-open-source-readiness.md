# Claude for Open Source — AIOS Readiness and Application Evidence

**Evidence checked:** 2026-11-09  
**Program:** Anthropic Claude for Open Source  
**Official application:** https://claude.com/open-source-max  
**Official program page:** https://claude.com/contact-sales/claude-for-oss  
**Controlling terms:** https://www.anthropic.com/claude-for-oss-terms

This is an evidence register and application-preparation document. It is not an eligibility claim, an application, or an assertion of acceptance.

## 1. Benefit and rules

The current program terms offer an approved individual applicant six consecutive months of Claude Ultra. The program is capped at 10,000 approved recipients unless Anthropic raises the cap. Applications are reviewed on a rolling basis; Anthropic does not promise a response timeline and contacts applicants only if approved.

An applicant must meet **at least one** of the two contribution tracks below **and every general eligibility requirement** in Section 2.3 of the official terms. Anthropic retains sole discretion; meeting the criteria does not guarantee approval.

### Maintainer Track — at least one

- Maintained projects have, in aggregate, at least 500 dependent repositories or 100 dependent packages.
- Maintained packages have at least 200,000 combined monthly downloads across public registries.
- Applicant is a listed committer or maintainer of a recognized foundation or language project.
- Applicant authored at least 100 pull requests merged into public repositories they do not own in the preceding 12 months.
- A maintained repository had at least 20 unique external contributors with merged pull requests in the preceding 12 months.
- A maintained repository has an OpenSSF criticality score of at least 0.4.

Anthropic may discount activity it considers trivial, duplicative, automated, or inconsistent with the program's purpose.

### Ecosystem Impact Track — discretionary

Applicants who do not meet a Maintainer Track threshold may still apply if they maintain or significantly contribute to a project the open-source ecosystem meaningfully depends on. Anthropic identifies downstream dependents, breadth of usage, criticality, and the applicant's maintenance role as relevant factors.

This is discretionary, not a waiver of the general eligibility requirements.

### General requirements — all must be met

- Natural person, not an entity.
- At least 18 or the local age of majority, whichever is greater.
- Legal resident of a supported Claude.ai region and not subject to relevant export-control or sanctions restrictions.
- Existing GitHub account in good standing that is at least **two years old**.
- Public open-source contribution activity in the 90 days before applying.
- Maintain or contribute to at least one project distributed under an OSI-approved license.
- Not an Anthropic employee, contractor, agent, or an immediate family/household member of such a person.

The subscription is personal and non-transferable; account sharing is prohibited. The benefit is a Claude Ultra subscription, not API credits. The terms allow overage charges. If an existing paid subscription was paused, it resumes at its then-current plan and rate after the benefit period unless cancelled before renewal.

## 2. Live evidence for AIOS

Repository: https://github.com/lmentry29/AIOS

| Evidence | Live observation | Assessment |
|---|---|---|
| Public repository | Repository is public | Positive, necessary but insufficient |
| Project purpose | AI-native operating system/reference implementation for agent-driven software engineering organizations | Plausible developer-tooling scope |
| License on default branch | GitHub repository metadata reported no recognized license on `main` | **Not yet satisfied on default branch** |
| License on implementation branch | PR #1 adds an MIT license for original project material | Pending merge and rights confirmation |
| Repository age | Repository created 2026-07-10 | Does not establish GitHub account age |
| Stars | 1 at evidence capture | No meaningful reach evidence |
| Forks / network forks | 0 / 0 at evidence capture | No evidence of external reuse |
| Subscribers | 0 at evidence capture | No evidence of sustained watching |
| Releases | No GitHub releases returned | No release/distribution evidence |
| Registry packages | No published package or download evidence established in this audit | Maintainer thresholds not evidenced |
| External merged PRs | Search of AIOS merged PRs by external authors returned no results | 20-external-contributor threshold not evidenced |
| Applicant's merged PRs to repos not owned | Search returned seven PR records in the applicant's own repository; no qualifying 100-PR external contribution record was established | 100-PR threshold not evidenced |
| OpenSSF criticality | No score of 0.4+ established | Threshold not evidenced |
| Foundation committer role | No recognized foundation/language-project committer role established | Threshold not evidenced |
| Recent public activity | Active public implementation branch and commits on 2026-11-09 | Supports the 90-day activity requirement once the project is under an OSI license on a public branch |

**Conclusion:** The evidence currently supports recent public development activity, but does not establish any numeric Maintainer Track threshold or meaningful ecosystem dependence. The Ecosystem Impact Track is therefore a weak application today. The two-year GitHub-account requirement is a separate hard gate and cannot be bypassed by the discretionary track.

**Account-age verification is still required from the account owner.** The repository creation date is not the GitHub account creation date. Do not infer one from the other.

## 3. Honest application posture

Do not claim any of the following without new, verifiable evidence:

- downstream dependents, package downloads, external users, or production deployments;
- 20 external contributors or 100 qualifying merged PRs;
- foundation maintainer status or OpenSSF criticality >=0.4;
- production readiness, independent deployment, or external adoption;
- that the MIT license is already present on the default branch.

Do not manufacture stars, forks, contributors, packages, downloads, PR volume, dependency relationships, or automated activity. The official terms explicitly reserve disqualification for artificially inflated metrics.

The best honest case is a technical project with a defined problem and an increasingly rigorous reference implementation. That is not yet evidence that the ecosystem meaningfully depends on it.

## 4. Application draft — use only if every general requirement is met

### Why I qualify (Ecosystem Impact Track; under 500 words)

I maintain AIOS, an open-source TypeScript reference implementation exploring how persistent AI agents can carry out bounded software-engineering work through explicit work hierarchies, canonical records, lifecycle controls, institutional memory, and auditable execution.

The project addresses a concrete engineering problem: agent workflows are often driven by transient conversations and loosely connected tool calls, making state, authority, provenance, and completion difficult to inspect or verify. AIOS explores a structured alternative. Its implementation includes canonical entity schemas, lifecycle-aware persistence interfaces, task and project stores, knowledge evolution, default-deny resource authorization, and an orchestration kernel that requires an independent verification port before a task can be marked complete.

The project is early-stage and does not currently claim significant downstream adoption, published-package usage, or production deployment. I am applying under the discretionary Ecosystem Impact Track because I believe the problem—making agentic software work inspectable, bounded, and auditable—is important to the developer ecosystem. I understand that the current project reach may be below the program's normal selection bar and that Anthropic will assess the actual significance and my maintenance role.

I maintain the implementation, tests, architecture decisions, and contributor documentation. My current work focuses on completing durable persistence, trusted identity, policy administration, reliable orchestration, sandboxed execution, and independent verification before making production claims.

### How I plan to use Claude Ultra

I would use the subscription personally to maintain and improve AIOS: implementation, test development, architecture review, security analysis, documentation, and review of changes before they are merged. I would retain human control over architectural decisions, credentials, releases, and deployment. I would not share the subscription or represent AIOS as production-ready before the required controls and independent verification exist.

**Do not submit this draft unchanged.** Update it with real evidence and ensure the subscription use described is consistent with the current terms and your intended use.

## 5. Pre-application checklist

- [ ] Confirm the GitHub account used for application is at least two years old and in good standing.
- [ ] Confirm the applicant's legal residence and age requirements.
- [ ] Merge or otherwise publish the OSI-approved license on the repository's default branch after reviewing ownership and third-party notices.
- [ ] Confirm public commits/PRs/reviews/releases within the preceding 90 days.
- [ ] Recheck GitHub dependency-graph counts, registry downloads, external contributor counts, qualifying external merged PRs, foundation roles, and OpenSSF score.
- [ ] If applying under Ecosystem Impact, provide independently verifiable evidence of actual ecosystem dependence; do not substitute project ambition for adoption.
- [ ] Submit only once; duplicate applications do not speed up review.
- [ ] Record the date submitted and the exact evidence snapshot used.
- [ ] If approved, activate within 90 days and calendar the six-month expiry/any paused-plan billing resumption.
- [ ] Do not share the subscription or incur overages unintentionally.

## 6. Evidence maintenance

Refresh this document immediately before applying. GitHub counts, Anthropic criteria, program availability, and terms can change. The official terms and application form control over this snapshot.
