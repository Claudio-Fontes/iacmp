# Changelog

---

## [2.5.0] — 2026-07-28

**Open core** shift: the CLI is open (Apache-2.0) and AI generation backed by a
validated corpus becomes **iacmp Pro**.

- **Apache-2.0 license** — all published packages (previously MIT).
- **GCP supported** — Terraform synth (tf.json) with 20/20 e2e battery
  scenarios validated in real deploys (parity with AWS and Azure). Deploy with
  API/role pre-flight, hash-versioned handler build+upload and automatic
  import of the `(default)` Firestore database.
- **`--format tf`** — AWS and Azure gain Terraform as an alternative
  synth/deploy/destroy format (`synth-out/aws-tf/`, `synth-out/azure-tf/`),
  validated in real deploys. Standalone `--provider terraform` was discontinued.
- **iacmp Pro** — `iacmp ai`, `from-diagram` and example search
  (`search_examples`/`list_examples` in the MCP) now require the Pro modules
  (`@iacmp/ai` + `@iacmp/knowledge`, outside this repo). Without them the CLI
  degrades with a clear message; everything else works in full.
- **Open embedded MCP** — `iacmp setup` registers the MCP server in Claude
  Code/Desktop with the mechanical tools (`write_stack`, `synth_project`,
  `deploy_project`, `destroy_project`, `validate_stack`, `read_synth_output`,
  `from_diagram`) — no Pro dependency.
- **Runtime 0.4.0** — facade with `table()`, `blob()`, `queue()`, `cache()`,
  `sql()`, `secret()` across all three clouds.
- **Structural refactors** — the synth/deploy/destroy commands became thin
  orchestrators with per-provider/per-flow modules; Azure/GCP executors split
  by responsibility; azure-tf synth follows the per-domain constructs/ pattern.

Packages: `@iacmp/core` 2.4.0 · `@iacmp/runtime` 0.4.0 · `iacmp` 2.5.0.

---

## [2.3.0] — 2026-07-23

Release consolidating distribution, learning and robustness.

- **npm distribution of the knowledge base** — corpus (126 examples) + seed moved to `@iacmp/knowledge` (single "corpus + retrieval + seed" source), bundled into the CLI and seeded on first use (`ensureSeeded`). Package published for the first time.
- **`@iacmp/runtime`** (facade) — handlers use cloud-agnostic `table`/`blob`; the per-cloud adapter is resolved at deploy time. Package published for the first time.
- **Learning loop (Mode 1)** — opt-in `knowledge.autolearn: "local"`: after a successful first-of-its-kind deploy, the CLI offers to record the pattern in the local base (preview + confirmation).
- **Generation quality** — env var guard covers nested handlers; anti-monolith validator (rejects stacks with 4+ infra domains); `fullstack` template split by domain.
- **Deploy/destroy robustness** — cross-stack export pre-flight (AWS); destroy cleans up orphans with confirmation (empty RG on Azure, Retain buckets on AWS); deploy error message no longer insists on "authentication"; compiles nested handlers on its own.
- **Shared APIM (Azure)** — `azure.sharedApim` in iacmp.json references an existing APIM (eliminates the ~30-45min floor per project).

Packages: `@iacmp/core` 2.3.0 · `@iacmp/runtime` 0.2.0 · `@iacmp/knowledge` 2.3.0 · `iacmp` 2.3.0 · `@iacmp/mcp` 0.2.0.

---

## [1.2.0] — 2026-06-29

Core abstraction refactor: domain knowledge migrated from the AI prompt into testable
code (semantic validation, derived defaults, environment profile). Errors that previously
only surfaced during real deploys are now blocked at synth time or eliminated at the source.

> **Version note:** the `1.1.0` published to npm drifted from the monorepo code (same
> version, different contents — e.g. Aurora engines missing from the published one). This bump to
> `1.2.0` realigns the version with the content. Republish to npm so `npm install` brings the current code.

### Added

- **Semantic validation (`@iacmp/core` → `validateSemantics`)** — runs at synth time and blocks,
  before deploy: Security Group missing the port of the database engine it protects, RDS/DocumentDB without
  ≥2 AZ coverage, `maxAzs > 0` coexisting with explicit subnets (CIDR conflict), subnet CIDR
  outside the VPC CIDR, and references (`vpcId`/`subnetIds`/`securityGroupIds`) to nonexistent
  constructs. The `iacmp ai` self-correction loop captures and resubmits these errors.
- **Default normalization (`applyEnvironmentDefaults`)** — automatically fills in, before
  synth: a distinct `availabilityZone` per subnet (derived from the region) and the engine port in the
  database's Security Group. Eliminates at the source the two most recurrent deploy bugs.
- **Environment profile (`EnvironmentProfile`, `accountTier` in `iacmp.json`)** — RDS defaults
  (backup, encryption) derive from the tier (`free` → 0/false, `standard` → 7/true). Switching from a
  free account to standard becomes a configuration change, not a code change.
- **Domain knowledge (`@iacmp/core/knowledge`)** — single source of truth for ports per
  SQL engine and AZ requirements, consumed by both validation and defaults.
- **Dynamic database references in the AWS synth** — env vars `AppDB.Endpoint`/`Port`/`Password`/
  `SecretArn` resolve to `Fn::ImportValue`/`Fn::GetAtt`/`{{resolve:secretsmanager}}`, with no hardcoded
  endpoint or password. Unlocks destroy+recreate without manual editing.
- **`iacmp init` `blank` template (default)** — `iacmp init` without `--template` creates an empty project (no
  scaffold), ideal for the `iacmp ai` flow. The old HelloWorld became `--template hello` (opt-in).

### Fixed

- **Relationship inference in diagrams** — the intra-stack env hint only creates a relationship when the env
  var value references the resource (it previously linked by type, generating noise or missing real relationships).

## In development

### Real e2e test battery on AWS (2026-06-23)

Implementation of ~40 integration tests that perform real deploy/destroy of CloudFormation stacks
on AWS, covering all 32 supported construct types. Each test uses `AWS_PROFILE=iacmp-e2e`
(a dedicated IAM user with a restricted policy) and checks `StackStatus === 'CREATE_COMPLETE'`.

#### Added

- **`packages/e2e-aws/`** — new package with 12 e2e suites (tests `00` through `11`) covering VPC,
  SecurityGroup, SQS, SNS, S3, EFS, Glacier, Lambda, ApiGateway, EventBridge, DynamoDB, RDS MySQL,
  EC2, AutoScaling, ECS Fargate, ALB, WAF, CloudFront, IAM Role, SecretsManager, CloudWatch Alarm,
  CloudWatch Dashboard, LogGroup, StepFunctions, ElastiCache Redis, Custom.Resource SSM and Route53.
- **`docs/iam-policy.json`** — minimal IAM policy for using `iacmp` in production, with full `ssm:*`
  and an explicit deny of dangerous operations (user creation, billing, organizations).
- **`iacmp doctor` — IAM permission check** — new `checkAwsIamPermissions()` check verifies
  `sts:GetCallerIdentity`, `lambda:ListFunctions` and `apigateway:GetRestApis`; reports missing
  permissions with a hint to `docs/iam-policy.json`.

#### Fixed in the AWS synth (`packages/providers/aws/src/synth/cloudformation.ts`)

- **SQS/SNS FifoQueue/FifoTopic** — AWS rejects `FifoQueue: false`; the property is now omitted
  when `false` and only included when `true`.
- **EventBridge Rule created before the Bus** — using the `busName` string did not create an implicit dependency;
  fixed to `{ Ref: busId }` for non-default buses.
- **StepFunctions `Resource` in non-Task states** — CloudFormation rejects `Resource` in states
  of type `Pass`, `Wait`, `Choice` etc.; the property is now only included in `Task`.
- **StepFunctions `LoggingConfiguration` without Destinations** — `Level: 'ERROR'` without at least one
  destination is invalid; block removed (logging is opt-in via props).
- **RDS `BackupRetentionPeriod`** — default changed from `7` to `0` (disables automatic backup);
  free tier accounts reject any value > 0.
- **RDS `StorageEncrypted`** — default changed from `true` to `false`; now opt-in via
  `storageEncrypted: true`. Added `storageEncrypted?` to `DatabaseSQLProps`.
- **Outdated RDS `EngineVersion`** — versions `8.0.36` (MySQL), `15.4` (PostgreSQL) and
  `10.11.6` (MariaDB) no longer exist in the us-east-1 region; updated to `8.0.46`, `17.10` and
  `11.8.8` respectively.
- **DocumentDB `BackupRetentionPeriod`** — default changed from `7` to `1`.
- **Deprecated AutoScaling `LaunchConfiguration`** — `AWS::AutoScaling::LaunchConfiguration` was
  removed from new accounts; migrated to `AWS::EC2::LaunchTemplate`.
- **AutoScaling without `AvailabilityZones`** — CFN rejects an ASG with neither subnets nor AZs; added
  `AvailabilityZones: { 'Fn::GetAZs': '' }` as a fallback when `subnetIds` is not provided.
- **ECS Service with empty `subnetIds`** — Fargate rejects a service without subnets; the `Service` is now
  only generated when `subnetIds.length > 0`.
- **ElastiCache Memcached `VpcSecurityGroupIds`** — `AWS::ElastiCache::CacheCluster` requires
  `VpcSecurityGroupIds` in VPC-only accounts; added support for the `securityGroupIds` prop in the synth.
- **SecretsManager name collides between runs** — a fixed secret name caused failures on the second deploy;
  fixed to `{ 'Fn::Sub': '${AWS::StackName}-<id>-db-password' }`.
- **Default `DeletionPolicy` for RDS and DocDB** — changed from `Snapshot` to `Delete` to
  avoid `DELETE_FAILED` when the resource never got created successfully.

#### Fixed in the AWS deploy (`packages/cli/src/deploy/aws.ts`)

- **Synchronous ROLLBACK_COMPLETE cleanup** — when a stack is in `ROLLBACK_COMPLETE`,
  `ROLLBACK_FAILED` or `UPDATE_ROLLBACK_FAILED` state, the deploy now deletes it and waits for completion
  via `execFileSync` before attempting to create again, avoiding race conditions.

#### Justified skips (tests marked as `test.skip`)

- **DocumentDB** — engine not available on free tier accounts (only aurora-postgresql)
- **EKS** — $0.10/hr for the control plane regardless of free tier
- **ACM Certificate** — DNS validation takes long; without a real registered domain the resource never leaves `CREATE_IN_PROGRESS`
- **ElastiCache Memcached** — `VpcSecurityGroupIds` requires a real GroupId; a SecurityGroup `{ Ref }`
  without an explicit VpcId returns GroupName on this account, causing a validation error

---

DevEx, CI and documentation hygiene from the audit
(`docs/report.md`):

### Added

- **`Database.DynamoDB` gains `partitionKeyType`/`sortKeyType`** — the key attribute type was always hardcoded
  as `'S'` (string) on AWS (CloudFormation) and Terraform, even when the application uses a numeric key. This
  caused a `ValidationException: Type mismatch` at runtime whenever the handler sent a number on a key
  declared as a string. Now `partitionKeyType`/`sortKeyType` (and the per-GSI equivalent) accept `'S' | 'N' | 'B'`,
  with `'S'` as the default (compatible with existing stacks). Azure (Cosmos DB Table API) and GCP (Bigtable/Firestore) do not
  need the fix — they are schemaless, with no per-attribute type declaration.
- **Fix: `iacmp ai` reported dependencies as "missing" even when they were already installed in the project** —
  the TypeScript validator (`packages/ai/src/parser/validator.ts`) wrote the generated files and ran `tsc` in a
  temporary directory in `os.tmpdir()`, outside the project tree — but TypeScript/Node module resolution
  walks up directories looking for `node_modules`, so a tmpDir outside the project never saw the real dependencies already
  installed (e.g. `@aws-sdk/client-dynamodb`). Any third-party package import was reported as a
  "Cannot find module" error, and the AI interpreted that as "I need to install this dependency" even when it was already
  in the user's `package.json`/`node_modules`. The temporary validation directory is now created INSIDE the project
  (`<project>/.iacmp-validate-*`, cleaned up after validation, added to the `.gitignore` generated by `iacmp init`), so
  module resolution finds the project's real `node_modules`.
- **`iacmp ls --status` shows which stacks are actually deployed, not just the ones defined locally** — previously, `ls` only listed
  the files in `stacks/`, with no notion of what actually exists in the cloud (confusing after a `destroy`: the stack keeps showing up,
  because `ls` lists the local `.ts` file, not remote state). The new flag queries the configured provider
  (`getExecutor`/`describeStatus`, a new optional method on `DeployExecutor`) and shows `[deployed: <native status>]` or
  `[not deployed]` per stack — implemented for AWS (`cloudformation describe-stacks`) and Azure (`az stack group show`); GCP uses a
  simple existence check (`deploymentExists`, no detailed status); Terraform does not implement it (it operates on the whole directory as
  a single state, with no individual stacks) — `ls --status` warns that it is not supported for those cases and falls back to the local listing, without
  breaking. Without the flag, `iacmp ls` remains exactly as before (no network calls).
- **`iacmp deploy` (AWS) detects orphaned resources before creating the stack, and fixes the nonexistent `Fn.Lambda` IAM Role** —
  two real end-to-end deploy problems:
  - `Function.Lambda` always generated `Role: arn:...:role/LambdaExecutionRole` — a role iacmp never creates. Every
    deploy failed with "The role defined for the function cannot be assumed by Lambda." Now
    (`packages/providers/aws/src/synth/cloudformation.ts`) the Lambda references the real role created by a `Policy.IAM`
    (`attachType: 'lambda'`) that points to it — locally via `Fn::GetAtt`, cross-stack via `Fn::ImportValue` of a
    new `Outputs`/`Export` in the `Policy.IAM` — and, when there is no matching `Policy.IAM`, it generates a minimal default
    inline role (`AWSLambdaBasicExecutionRole`), so every Lambda is always deployable.
  - Resources with `DeletionPolicy: Retain`/`Snapshot` (e.g. `Database.DynamoDB`) survive stack destruction — a
    previously destroyed stack can leave a resource alive, orphaned, outside CloudFormation's control. A subsequent
    deploy trying to recreate that resource failed with a confusing error only visible after attempting to create the changeset
    (`AWS::EarlyValidation::ResourceExistenceCheck`). `iacmp deploy` now checks this BEFORE, generically via the AWS
    Cloud Control API (`get-resource`/`delete-resource` — works for any CloudFormation `Type`, not tied
    to a specific service): if it finds a conflict, it shows a clear warning and asks before deleting (default no);
    if the user declines, it skips only that stack and continues deploying the others, instead of aborting everything.
- **Fix: `Fn.ApiGateway` (REST v1) without `description` failed on real deploy** — `AWS::ApiGateway::RestApi` rejects
  `Description: ''` with `400 (Description cannot be an empty string)`; the generator always sent an empty string when the
  user did not set `description`. The property is now omitted when absent, instead of sent empty
  (`packages/providers/aws/src/synth/cloudformation.ts`).
- **`Testing.loadStack`/`findResource` in `@iacmp/core` + `iacmp ai` now generates the handler code alongside `Fn.Lambda`** —
  two real problems found while testing end-to-end deploys:
  - `iacmp ai` generated the `Fn.Lambda` stack (`code: 'dist/'`) but never the
    handler code itself — `dist/` never existed, and the deploy failed when
    packaging. The prompt (`packages/ai/src/prompts/system-prompt.ts`) now
    instructs it to always generate the handler `.ts` file at the project
    root as well (path derived from `handler: '<file>.<export>'`,
    following the `rootDir: '.'` convention of `iacmp init`), prioritizing real logic
    when the request describes what the function does, with a placeholder
    (`{ statusCode: 200, ... }`) only when no business logic is described.
  - The AI had hallucinated a nonexistent testing API (`Testing.loadStack`,
    `Testing.describe/it/expect`, `stack.findResource`) in a generated test
    file — none of that existed in `@iacmp/core`, and the prompt had
    no instruction about test generation. Implemented for real:
    `Testing.loadStack(path)` (new, `packages/core/src/testing.ts`)
    loads the stack exported by a file (relative to the project root) and
    returns `.findResource(id)` (`BaseConstruct | undefined`). The prompt
    now documents this real API and instructs using Jest's
    `describe`/`it`/`expect` directly (globals), and never inventing
    nonexistent methods/namespaces in any generated file.
- **Fix: Lambda `Code` resolved to the wrong directory on AWS deploy** —
  `aws cloudformation package` resolves relative `Code` paths against the
  TEMPLATE's directory (`synth-out/aws/`), not the project root where
  `dist/` actually lives (next to `stacks/`). The deploy
  failed with `Parameter Code of resource ... refers to a file or folder
  that does not exist .../synth-out/aws/dist` even with `dist/` present
  in the project. The AWS executor (`packages/cli/src/deploy/aws.ts`) now
  rewrites those paths to absolute (relative to `cwd`) in an intermediate
  template before packaging — validated with a real upload to S3.
- **`Fn.ApiGateway` on AWS: real REST v1, Lambda permission and cross-stack
  references** — three bugs fixed in `packages/providers/aws/src/synth/cloudformation.ts`
  that prevented any real API Gateway deploy, including the default
  `iacmp init` template:
  - `type: 'REST'` (the default) generated `AWS::ApiGatewayV2::*` resources
    (API Gateway v2/HTTP), incompatible with `AWS::ApiGateway::RestApi`
    (v1). It now generates the full v1 model: a `Resource` tree per
    path segment (deduplicated across routes), `Method` with a nested
    `AWS_PROXY` integration, correct `Deployment`+`Stage`, v1 `Authorizer` and
    CORS via `OPTIONS`+`MOCK`.
  - The `AWS::Lambda::Permission` allowing API Gateway to
    invoke the Lambda (REST and HTTP) was never generated — every API call got Access Denied.
    Now generated once per (API, Lambda) pair, even when the same function
    serves multiple routes.
  - A `Function.Lambda` referenced by a `Function.ApiGateway` in **another**
    stack/file (the recommended pattern: Lambda in `stacks/compute/`, API
    in `stacks/network/`) generated `Fn::Sub: '${lambdaId.Arn}'`, which only
    resolves within the same template — CloudFormation rejected it with
    `references invalid resource attribute`. `iacmp synth` now loads
    all project stacks before synthesizing (even with `--stack`
    filtering what is written) and resolves automatically: a local reference
    stays direct, a cross-stack reference becomes an `Fn::ImportValue` of an
    `Outputs`/`Export` (`<stack>-<lambdaId>-Arn`) that every `Function.Lambda`
    now exports. Clear synth error if the referenced Lambda does not
    exist in any project stack.
  - `iacmp deploy`/`destroy` order stacks by the export/import
    dependency detected in the templates (`orderByDependency`, in
    `synth-out.ts`) — exporters go up before importers on deploy, and
    are destroyed after them on destroy. Without this, even with the correct reference,
    the real deploy would fail with "export not found" by bringing the API up before the
    Lambda.
  - Scope: AWS only in this delivery. Azure is suspected of the same cross-stack
    reference bug via `reference(resourceId(...))`, not yet
    investigated — GCP and Terraform do not have this problem (GCP uses a predictable
    HTTPS URL, Terraform operates on the whole directory as a single state).
- **Root `--help` listing shows one example per command** — new
  `IacmpHelp` class (`packages/cli/src/help.ts`, registered via `oclif.helpClass`
  in `package.json`) overrides oclif's command formatting to
  include each command's first `static examples` directly in `iacmp`
  (no args) or `iacmp --help`, instead of just the one-line description. The
  per-command `--help` still shows all examples.
  Also fixed a related bug: the CLI `build` did not regenerate
  `oclif.manifest.json` (only `prepack` did), so locally modified
  commands could show `--help` with outdated flags/examples;
  `npm run build` now always regenerates the manifest.
- **`iacmp deploy`/`iacmp destroy` perform real deploys** — no longer a
  simulation (forced dry-run); they now call each provider's native CLI
  via subprocess: `aws cloudformation package`+`deploy` (AWS, automatically creating and
  reusing its own S3 bucket,
  `iacmp-deploy-artifacts-<account>-<region>`, for Lambda code),
  `az stack group create`/`delete` (Azure, via Deployment Stacks),
  `gcloud deployment-manager deployments create`/`update` (GCP, automatically choosing
  between create and update) and `terraform init`+`apply`/`destroy`
  (Terraform, operating on the entire `synth-out/terraform/` directory). New
  `--dry-run` flag on both commands shows the exact commands without executing
  anything. New optional fields `resourceGroup` (Azure) and `projectId` (GCP) in
  `iacmp.json`. `iacmp doctor` gains checks (+ `--fix`) for Azure CLI,
  gcloud CLI and Terraform CLI. Also fixed a codegen bug on AWS: the
  Lambda `Code` generated `{ ZipFile: '<local-path>' }` (an invalid format
  for real deploys — `ZipFile` expects inline code, not a path); it now
  generates the path as a plain string, a format that `aws cloudformation
  package` recognizes and resolves to S3. **Known limitation:** only AWS
  has function code packaging fixed in this delivery — Azure
  (Function App), GCP (Cloud Functions) and Terraform still do not attach working
  code to the created resource; fix planned for the next step, after
  manual validation of this delivery.
- **Fix:** `aws cloudformation package`/`deploy` have no equivalent to the
  AWS SAM CLI's `--resolve-s3` — `package` always requires an explicit
  `--s3-bucket` (initially confused with the SAM CLI, which has that flag). The
  AWS executor now resolves the account via `aws sts get-caller-identity`,
  derives a deterministic bucket name and creates that bucket automatically
  (`aws s3 mb`) the first time, if it does not exist yet, before `package`.
- **`.github/workflows/ci.yml`** — CI pipeline on GitHub Actions with a
  Node 20.x matrix, `.turbo/` and `npm cache` caching, running `typecheck`, `test` and
  `build` via Turborepo.
- **`LICENSE`** — MIT file at the root (DOC-05/DX-06). Copied to
  `packages/cli/` and `packages/core/` on `prepack` to ship with the packages
  published to npm.
- **`CONTRIBUTING.md`** — stub at the root pointing to `../CONTRIBUTING.md`.
- **`.env.example`** — versioned template with `ANTHROPIC_API_KEY` and
  `GITHUB_TOKEN` documented.
- Versions aligned at `1.1.0` across all 10 `package.json` files in the workspace
  (DOC-04). Some were still at `1.0.0`.
- Documentation for **all 13 construct namespaces** in
  `docs/constructs.md` (DOC-06) — previously only 5 were documented.

### Fixed

- A malformed `iacmp.json` now **propagates an error** in `loadPlugins` instead of
  silently falling back to `[]` (ARCH-07). Plugins with an ambiguous export
  (`default` vs `module.exports`) are normalized via `m.default ?? m`.
- `packages/cli/package.json` gains `LICENSE` in `files` and an automatic copy
  on `prepack` — the npm package previously shipped without a license despite `"license":"MIT"`.
- `turbo.json`: the `test` task no longer depends on `build` (ARCH-09) — ts-jest
  operates on `src` directly. The `test` `outputs` now cover `coverage/**` and
  `inputs` list `src/**`, `test/**`, `tsconfig.*.json`, `jest.config.*` and
  `package.json` for effective caching (DX-09).
- `MVP-STATUS.md` became a pointer to README/changelog (DOC-01). It previously said
  "AWS only" and hardcoded `/Users/cmelo/` paths.
- `docs/faq.md`, `docs/user-guide.md`, `docs/providers.md` now describe
  the real `synth-out/<provider>/<stack>.<ext>` layout (DOC-08) and the use of
  `ts-node` (DOC-09) — the synth registers ts-node when available in the project,
  not automatically.
- `docs/estudo-rag.md` reworked as "Architecture (current state)" + a
  "Next steps" section (DOC-03). Much of what was a "plan" already exists.
- `../CONTRIBUTING.md`: the "new construct" example rewritten to match the real
  pattern (namespace, `*Props`, `implements BaseConstruct`, `stack.addConstruct`)
  copying `cache.ts` (DOC-07). Clone URL standardized to
  `https://github.com/Claudio-Fontes/iacmp` (DOC-12).
- `docs/user-guide.md`: removed the "Phase 3 vs Available" contradiction in
  `iacmp ai` (DOC-11).
- README: the docs index lists all 10 files in `docs/` (3 were
  missing); GitHub URLs aligned (DOC-12).

### Hygiene

- `.gitignore` covers `.iacmp/` (SEC-08), `tmp/` and `.DS_Store` (DX-05). Removed
  `tmp/test-init-compute/**` from the index via `git rm --cached`.

---

## [1.1.0] — 2026-06-13

Templates in `init`, audits and architecture diagrams.

### Added

- **`iacmp init --template <name>`** — 6 stack templates embedded in the CLI: `default`, `rds`, `webapp`, `network`, `serverless`, `fullstack`. The project name is interpolated automatically. Works after `npm install -g iacmp` with no dependency on external paths.
- **`iacmp init --list`** — lists all templates with description and included constructs.
- **`iacmp diagram`** — generates architecture diagrams from the project's stacks
  - `--format structurizr` (default) — generates `diagrams/workspace.dsl` with C4 styles, `autoLayout` and inferred relationships marked
  - `--format mermaid` — generates `diagrams/workspace.md` with `graph TD` blocks per stack, emojis per type and a resource legend; rendered automatically on GitHub/GitLab/Notion
  - `--stack <name>` — filters a specific stack
  - `--out <dir>` — configurable output directory (default: `diagrams/`)
  - Internal `src/diagram/` module with `model.ts`, `builder.ts`, `structurizr.ts` and `mermaid.ts`
  - Conservative inference: single VPC → dashed arrow to the other constructs, labeled `[inferred]`
- **5 audit commands** with Markdown reports in `audit/`
  - `iacmp audit-security` — public access, versioning, Multi-AZ, Lambda memory, CIDR
  - `iacmp audit-ha` — Single-AZ database/VPC, instance without redundancy, Lambda/S3 as natively HA
  - `iacmp audit-dr` — /10 score with checklist, versioning, Multi-AZ, multi-AZ networking
  - `iacmp audit-improvements` — performance and architecture suggestions with impact and effort
  - `iacmp audit-all` — runs all 4 in sequence
- **`docs/plano-diagramas-stacks.md`** — revised architecture plan with structural decisions, format roadmap and acceptance criteria

---

## [1.0.0] — 2026-06-13

Phase 5 — Production.

### Added

- **Integration tests** — Jest suite with ts-jest covering all native providers
  - `packages/core/test/stack.test.ts` — 7 tests: Stack and all constructs (Compute, Storage, Network, Database, Fn)
  - `packages/providers/aws/test/cloudformation.test.ts` — 8 tests: CloudFormation, type mapping, versioning, VPC, RDS, Lambda
  - `packages/providers/azure/test/arm.test.ts` — 2 tests: ARM Template, VM and Storage Account
  - `packages/providers/terraform/test/hcl.test.ts` — 3 tests: HCL blocks, aws_instance, aws_s3_bucket
  - `test` pipeline added to `turbo.json` and `npm test` to the root
- **Complete documentation**
  - `docs/architecture.md` — internal monorepo architecture, `iacmp synth` flow, `iacmp ai` flow, plugin system and new-provider guide
  - `docs/faq.md` — 10 frequently asked questions covering ts-node, API keys, real deploy, synth-out, multiple stacks, custom providers
  - `docs/publicacao-npm.md` — npm publishing guide with checklist and commands
- **Real project examples** in `examples/`
  - `examples/webapp/` — static site with VPC, public bucket and private bucket
  - `examples/database/` — Multi-AZ RDS database with VPC and replica
  - `examples/network/` — full network with VPC, bastion and app server
  - All functional: `iacmp synth` generates valid CloudFormation JSON
- **Version 1.0.0** across all monorepo packages
- **`iacmp synth`** — looks up `ts-node` in parent directories (support for monorepos and examples without local node_modules)

---

## [0.4.0] — 2026-06-13

Phase 4 — DX & Ecosystem.

### Added

- **`@iacmp/plugin-sdk`** — SDK for third-party custom providers
  - `plugin.ts` — `IacmpProvider` and `IacmpPlugin` interfaces + `definePlugin()` function
  - `loader.ts` — `loadPlugins()`: reads the `plugins` field from `iacmp.json` and loads providers via `require()` with error debouncing
- **`@iacmp/dashboard`** — web dashboard package for stack visualization
  - `server.ts` — native HTTP server (no external dependencies)
  - `ui.ts` — HTML generation with dark theme, per-stack cards, resource table, all inline
  - `index.ts` — exportable `startDashboard()`
- **`@iacmp/registry`** — client for the community constructs registry
  - `registry.json` — local registry with 3 example constructs: `WebApp.Static`, `Queue.SQS`, `Auth.Cognito`
  - `client.ts` — `listConstructs()` and `searchConstructs(term)`
- **`iacmp watch`** — new CLI command
  - Watches `stacks/` recursively with native `fs.watch()`
  - 300ms debounce to avoid duplicate synths on rapid saves
  - Runs `iacmp synth` automatically when changes are detected
  - Prints a `[HH:MM:SS]` timestamp, the changed file name and the result (✓/✗)
- **`iacmp dashboard`** — new CLI command
  - Serves the HTTP dashboard on a configurable port (default: 4000)
  - Reads `synth-out/` and displays stacks and resources in real time
  - `--open` flag to open the browser automatically
- **`iacmp registry`** — new CLI command
  - `iacmp registry list` — lists all constructs in a formatted table
  - `iacmp registry search <term>` — filters by name, package or description
- **Plugin system in `iacmp synth`** — integration with loaded plugins
  - If the provider is not native, looks it up among plugins loaded via `loadPlugins()`
  - Example plugin in `examples/plugin-exemplo/` (simulated Digital Ocean)
- **CI/CD generated by `iacmp init`**
  - `.github/workflows/iacmp.yml` — GitHub Actions: checkout, setup-node, `npm ci`, `iacmp synth`, `npm test`
  - `.gitlab-ci.yml` — GitLab CI: image node:20, script: `npm ci`, `iacmp synth`, `npm test`
- **`iacmp doctor`** — new plugin check
  - If `iacmp.json` has a `plugins` field, lists each plugin and indicates whether it loaded successfully

---

## [0.3.0] — 2026-06-13

Phase 3 — AI module.

### Added

- **`@iacmp/ai`** — package with all AI stack generation logic
  - `providers/base.ts` — `AIProvider`, `AIMessage`, `AIResponse` interfaces
  - `providers/anthropic.ts` — `AnthropicProvider` with chat and streaming support (model `claude-sonnet-4-6`)
  - `providers/copilot.ts` — `CopilotProvider` via the GitHub Copilot API (`gpt-4o`, SSE streaming)
  - `prompts/system-prompt.ts` — complete system prompt with generation, migration, documentation and cost-optimization instructions; `{PROJECT_CONTEXT}` placeholder replaced at runtime
  - `parser/code-extractor.ts` — extracts and validates JSON from the AI response (supports raw JSON, markdown blocks and a `{...}` heuristic)
  - `parser/validator.ts` — validates generated TypeScript with `tsc --noEmit` in a temporary directory
  - `chat/session.ts` — `ChatSession` with message history
  - `chat/renderer.ts` — spinner, explanation, warnings, next steps and chunk-by-chunk streaming
  - `tools/diff-renderer.ts` — colored diff of new/modified files with approval via `readline`
  - `tools/file-writer.ts` — writes files after diff approval; supports `--dry-run`
  - `tools/context-reader.ts` — reads `iacmp.json` and existing stacks to inject context into the prompt
  - `tools/synth-runner.ts` — runs `iacmp synth` after generation
- **`iacmp ai`** — new CLI command
  - Single-command mode: `iacmp ai "description"` — generates the stack, validates, shows a diff, asks for approval
  - Chat mode: `iacmp ai --chat` — interactive loop with `/sair` and `/limpar` commands
  - `--dry-run` flag — shows the files that would be generated without saving anything
  - `--provider` flag — overrides the provider from `iacmp.json`
  - Automatic retry on TypeScript errors (1 attempt)
  - Provider detection: `ANTHROPIC_API_KEY` takes priority over `GITHUB_TOKEN`
  - Clear error message when no API key is configured

---

## [0.2.0] — 2026-06-13

Phase 2 — Multi-cloud.

### Added

- **`@iacmp/provider-azure`** — construct synthesis to ARM Template JSON
  - `Compute.Instance` → `Microsoft.Compute/virtualMachines`
  - `Storage.Bucket` → `Microsoft.Storage/storageAccounts` (kind `StorageV2`)
  - `Network.VPC` → `Microsoft.Network/virtualNetworks`
  - `Database.SQL` → `Microsoft.Sql/servers` + `Microsoft.Sql/servers/databases`
  - `Fn.Lambda` → `Microsoft.Web/sites` (kind `functionapp`)
- **`@iacmp/provider-gcp`** — construct synthesis to GCP Deployment Manager JSON
  - `Compute.Instance` → `compute.v1.instance`
  - `Storage.Bucket` → `storage.v1.bucket`
  - `Network.VPC` → `compute.v1.network`
  - `Database.SQL` → `sqladmin.v1beta4.instance`
  - `Fn.Lambda` → `cloudfunctions.v2.function`
- **`@iacmp/provider-terraform`** — construct synthesis to HCL (`.tf`)
  - `Compute.Instance` → `resource "aws_instance"`
  - `Storage.Bucket` → `resource "aws_s3_bucket"`
  - `Network.VPC` → `resource "aws_vpc"`
  - `Database.SQL` → `resource "aws_db_instance"`
  - `Fn.Lambda` → `resource "aws_lambda_function"`
- **`iacmp diff`** — compares the previous synth with the current one, shows a line-by-line colored diff
- **`iacmp synth`** — support for `azure`, `gcp` and `terraform` providers (in addition to `aws`)
- **`iacmp deploy`** — provider-specific messages
- **`iacmp init --language python`** — creates `stacks/exemplo_stack.py` as a placeholder for Phase 3
- **`iacmp init --provider`** — flag to set the default provider in `iacmp.json`

---

## [0.1.0] — 2026-06-13

First version of iacmp — Phase 1 MVP.

### Added

- Monorepo with Turborepo (`@iacmp/core`, `@iacmp/provider-aws`, `iacmp`)
- **`@iacmp/core`** — 5 provider-agnostic constructs:
  - `Compute.Instance` — virtual machines
  - `Storage.Bucket` — object storage
  - `Network.VPC` — virtual private networks
  - `Database.SQL` — managed relational databases
  - `Fn.Lambda` — serverless functions
- **`@iacmp/provider-aws`** — construct synthesis to CloudFormation JSON
- **`iacmp` CLI** with 6 commands:
  - `iacmp init` — initializes a project with `iacmp.json` and `stacks/`
  - `iacmp synth` — synthesizes stacks to the provider's native format
  - `iacmp deploy` — deploys the stacks to the provider
  - `iacmp destroy` — destroys the infrastructure (with confirmation)
  - `iacmp ls` — lists the project's stacks
  - `iacmp doctor` — checks environment and dependencies
- Initial documentation: user guide, constructs reference, providers reference, contributing guide

### Limitations of this version

- `deploy` and `destroy` are simulated — no real AWS calls
- Only the AWS provider is available
- `iacmp ai` (AI generation) available in Phase 3
- Azure, GCP and Terraform providers available in Phase 2

---

## Upcoming versions (planned)

### [0.2.0] — Phase 2 · Multi-cloud

- Azure provider (Bicep / ARM Template)
- GCP provider (Deployment Manager)
- Terraform provider (HCL via CDKTF)
- `iacmp diff` — view differences before deploy
- `iacmp doctor` with Azure CLI and gcloud checks

### [0.3.0] — Phase 3 · AI module

- `iacmp ai "description"` — generates a stack via AI (Claude / GitHub Copilot)
- `iacmp ai --chat` — interactive chat mode
- `iacmp ai --dry-run` — preview without writing files
- Colored diff with mandatory approval before saving generated files
- `ANTHROPIC_API_KEY` required as of this version for `iacmp ai`

### [0.4.0] — Phase 4 · DX & Ecosystem

- `iacmp watch` — hot deploy on detected changes
- Plugin system for custom providers
- Community constructs registry
- GitHub Actions and GitLab CI integrations
