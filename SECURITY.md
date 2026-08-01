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

- **Authentication is explicit and fail-closed** (since 2.7.0). Declare it with `auth: { type: 'jwt' | 'lambda' | 'iam' | 'none', … }`. If a provider cannot implement what you asked for, the synth **fails** — it never downgrades to a public endpoint. JWT is validated natively by the gateway on all three clouds (AWS HTTP API, Azure APIM `validate-jwt`, GCP API Gateway), and GCP backends behind a protected route no longer get `allUsers`, so the gateway cannot be bypassed. Remaining gap: on Azure, the Function App behind APIM still accepts anonymous calls on its own hostname — restrict it with access restrictions/private endpoint until we ship function-key wiring.
- **IAM translation is lossy by design.** AWS-style actions map to broader GCP roles at project scope. Where the semantics cannot be preserved (`Deny` statements, unknown actions), the synth **fails** instead of guessing — but a successful synth still means "at least what you asked for", not "exactly what you asked for". Review generated policies.
- **GCP deploy grants roles to the default compute service account** (idempotently, at pre-flight) so first deploys on new projects work. Since 2.7.0 the set is derived from the resources your artifact actually creates (a project without Pub/Sub gets no Pub/Sub role) and the plan is printed before anything is granted. Dedicated per-workload service accounts are still on the roadmap.
- **Terraform state is local by default** (`synth-out/…/terraform.tfstate`) and may contain sensitive values. The deploy warns about it every run. For anything shared, configure a remote backend with locking in `iacmp.json`:
  ```json
  { "tfBackend": { "type": "s3", "bucket": "my-state", "key": "prod/app.tfstate", "region": "us-east-1", "dynamodb_table": "tf-locks" } }
  ```
  `gcs` and `azurerm` are supported with the same shape.
- **`iacmp audit-security` is a linter, not a compliance audit.** Since 2.7.0 it also inspects the **synthesized artifacts** (CloudFormation/Bicep/Terraform) for wildcard IAM, `iam:PassRole` with `*`, admin/database ports open to the internet, unauthenticated routes, public buckets, `allUsers` invokers, secrets in outputs and storage without TLS — and reports `PASS`/`FAIL`/`NOT_APPLICABLE`/`NOT_CHECKED` instead of a blanket "OK". Still: a clean run is not certification.

## Hardening already in place

- Cloud CLIs are invoked with separated arguments (no shell string interpolation).
- Package names derived from AI-generated code are validated against a strict npm grammar and installed with `--ignore-scripts`.
- Azure secret material is generated with a CSPRNG at deploy time and passed as `@secure()` parameters — never derived deterministically in the template, never printed in logs or `--dry-run`.
- Destructive commands ask for confirmation before any cloud call; `--dry-run` shows the exact commands.
- The local dashboard binds to `127.0.0.1` and serves no routes beyond the root page.
- Security groups with no declared source fail the synth instead of defaulting to `0.0.0.0/0`; on GCP, unmappable IAM actions and `Deny` statements fail instead of being translated into a broader grant.
- CI pins every GitHub Action by commit SHA, runs `npm audit --omit=dev --audit-level=high` and CodeQL on every push and pull request.
