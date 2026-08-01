# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately through [GitHub Security Advisories](https://github.com/Claudio-Fontes/iacmp/security/advisories/new) — or, if you prefer, reach out on [LinkedIn](https://www.linkedin.com/in/claudio-me1o) and we'll move to a private channel.

Please include: affected version, reproduction steps, and the impact you believe it has. Proof-of-concept code is welcome.

**Response targets** (single-maintainer project — honest numbers):

| Stage | Target |
|---|---|
| First acknowledgement | 72 hours |
| Initial assessment (severity + plan) | 7 days |
| Fix released for critical issues | 30 days |

Credit is given in the release notes unless you prefer to stay anonymous.

## Supported versions

Only the latest published version of `iacmp` receives security fixes. There is no LTS branch.

## Scope

**In scope:** the CLI, the synthesizers (`@iacmp/provider-*`), `@iacmp/core`, `@iacmp/runtime`, the embedded MCP server, and any generated template that grants more access than the stack declared.

**Out of scope:** vulnerabilities in the cloud providers themselves; issues that require the attacker to already control the machine running the CLI; and the closed Pro modules (report those through the same private channel — they just aren't in this repository).

## What this tool does with your credentials

iacmp runs locally with **your** cloud credentials, via the official CLIs (`aws`, `az`, `gcloud`, `terraform`). It does not send your code, templates or credentials anywhere: there is no telemetry, no phone-home, no hosted service in the open CLI. Everything it does you can inspect with `--dry-run`.

## Security model and known limitations

We prefer stating limitations to implying guarantees. As of the current release:

- **Authentication semantics are not uniform across providers.** `Fn.ApiGateway`'s `authType` is implemented in different depths per cloud, and a backend function may be reachable directly (bypassing the gateway) depending on the provider. Treat generated auth as a starting point and verify the final template before exposing anything sensitive. Making auth explicit, validated and fail-closed in all three clouds is the top item on the security roadmap.
- **IAM translation is lossy by design.** AWS-style actions map to broader GCP roles at project scope. Where the semantics cannot be preserved (`Deny` statements, unknown actions), the synth **fails** instead of guessing — but a successful synth still means "at least what you asked for", not "exactly what you asked for". Review generated policies.
- **GCP deploy grants roles to the default compute service account** (idempotently, at pre-flight) so first deploys on new projects work. This is convenient and broader than least privilege; dedicated per-workload service accounts are on the roadmap.
- **Terraform state is local by default** (`synth-out/…/terraform.tfstate`) and may contain sensitive values. For anything beyond experiments, configure a remote encrypted backend with locking.
- **`iacmp audit-security` is a linter, not a compliance audit.** It checks a limited set of properties on a subset of constructs. A clean run is not certification.

## Hardening already in place

- Cloud CLIs are invoked with separated arguments (no shell string interpolation).
- Package names derived from AI-generated code are validated against a strict npm grammar and installed with `--ignore-scripts`.
- Azure secret material is generated with a CSPRNG at deploy time and passed as `@secure()` parameters — never derived deterministically in the template, never printed in logs or `--dry-run`.
- Destructive commands ask for confirmation before any cloud call; `--dry-run` shows the exact commands.
- The local dashboard binds to `127.0.0.1` and serves no routes beyond the root page.
