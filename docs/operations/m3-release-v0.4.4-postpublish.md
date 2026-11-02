# M3 v0.4.4 post-publication release report

Package `@tamat-llc/repo-knowledge-mcp@0.4.4` is publicly published and the technical post-publication gates passed on 2026-10-02 UTC. The environment protection exception below is recorded separately and is not represented as independent reviewer approval.

## Release identity

| Item | Verified value |
| --- | --- |
| Release | [v0.4.4](https://github.com/TamaT-LLC/repo-knowledge-mcp/releases/tag/v0.4.4) |
| Package | [npm 0.4.4](https://www.npmjs.com/package/@tamat-llc/repo-knowledge-mcp/v/0.4.4) |
| Commit | `b50027728ea5c81e5b6f5c7719929ee21a0a0f00` |
| Tree | `72f90b0f90b50391007736d0b38361a063bdb936` |
| Annotated tag object | `adced5ef76993fc87867b2a988454670ae5c9446` |
| Workflow | [36983862342, attempt 1](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36983862342/attempts/1), success |
| Registry latest | `0.4.4` |

The supplied pre-publication report was materialized through Library on this Mac, verified at 22,285 bytes and SHA-256 `a1d27144ec7c70fcc37e22dd0a8138315ab570ed2867bd9e62f7b5991b334ea9`, and attached to the draft Release. Its downloaded attachment was byte-identical before Release publication. It remains preserved as the pre-publication record.

## Release and registry gates

| Gate | Result |
| --- | --- |
| [Verify release Node 22](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36983862342/job/110764305269) | success |
| [Verify release Node 24](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36983862342/job/110764305493) | success |
| [Publish exact tarball](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36983862342/job/110764828754) | success; GitHub Actions OIDC trusted publisher; npm 12.0.2 |
| [Registry smoke Node 22](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36983862342/job/110767337341) | success; exact-version npx and package smoke both pass |
| [Registry smoke Node 24](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36983862342/job/110767337332) | success; exact-version npx and package smoke both pass |
| Exact registry version | HTTP 200, name and version match |
| Workflow artifact versus registry tarball | byte-identical |
| Registry latest | `0.4.4` |
| Registry signatures / attestations | clean temporary install with lifecycle scripts disabled; npm audit signatures passed: 42 signatures, 10 attestations; exact package `0.4.4` present in verified results; invalid and missing arrays empty |

The workflow smoke exercises exact-version registry installation, guided setup/review help, MCP readiness and stdio, Node API import/types, and workspace cleanliness. M3-AC-008's previously pending registry smoke is now technically satisfied on Node 22 and 24. This is GitHub-hosted Linux execution; no additional Mac Node 22/24 runtime smoke is claimed.

## Published artifact and provenance

| Item | Value |
| --- | --- |
| Tarball SHA-256 | `740c7f5b9872ba6f0ef248ab778e5cb20e53a517b4706c4f2664e40e4b1c032f` |
| Tarball SHA-1 | `e2985c13b05414ab68c3d0aba98d8cf9b478f158` |
| Integrity | `sha512-XTny+1sYrl+8Nf1gbvnExvgbKGiAEEv0DOMrz9/pUjQ/4/I/MBw7TVn7GQY1SGYFx9+3O6JqG+vF64q5T4bz+Q==` |
| Workflow package-artifact-report SHA-256 | `239be557b5162bdafe8a24c1d97b71c9d8032947c818937451fab6f845c0c7bd` |
| Artifact gate | pass, 255 entries, `dist-js-dts-plus-explicit-root-files-v3` |

Public [npm attestation endpoint](https://registry.npmjs.org/-/npm/v1/attestations/@tamat-llc%2frepo-knowledge-mcp@0.4.4) contains SLSA v1 provenance. The subject SHA-512 matches the downloaded tarball; external workflow repository is `https://github.com/TamaT-LLC/repo-knowledge-mcp`, path `.github/workflows/release.yml`, ref `refs/tags/v0.4.4`. Its resolved Git commit is the exact release commit above, and invocation points to run 36983862342 attempt 1. npm audit signatures cryptographically verified the target package's attestations.

## npm environment protection exception

The run initially waited for `npm` environment id `19807183312`; GitHub reported `current_user_can_approve: false` for initiating account `TakehiroT`. Required reviewers were `TakehiroT` / `Fuelda` and self-review prevention was enabled. The assistant stopped at that blocker and reported the required independent review to the parent.

After the user reported performing the action, the existing run completed. The [GitHub approval-history API](https://api.github.com/repos/TamaT-LLC/repo-knowledge-mcp/actions/runs/36983862342/approvals) returned one entry: user `TakehiroT`, state `skipped`, empty comment, environment `npm`. This records skipped environment protection, not independent `Fuelda` approval. No independent reviewer approval is claimed. The assistant did not perform a bypass, generate credentials, change protection settings, create a duplicate run, or republish the package.

A read-only post-publication check confirmed the environment still has self-review prevention, the same reviewers, `v*` tag policy, and its pre-existing administrators-can-bypass setting. Technical publication succeeded; this process exception remains for maintainer review and is not erased by successful smoke/provenance checks.

## Scope and remaining limits

The owner-approved reuse of the previous pilot and current regression evidence remains as documented in the pre-publication report; no new 14-day pilot, independent human ranking evaluation, or independent human security approval is fabricated. The prior npm package settings periodic audit remains `not_due` under the pre-publication record; successful OIDC publication does not prove the separate npm token-ban setting.

No technical publication blocker remains. Maintainer review of the recorded environment protection skip remains. The immutable tag and published npm version were not changed or reused.

