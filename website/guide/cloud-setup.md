# Cloud accounts and CLIs

Never used a cloud before? This page takes you from zero to "ready to deploy" on each provider. You only need **one** of them to start — pick AWS if you have no preference (it is the most common and its free tier covers everything in this guide).

::: tip Costs
All three providers have free tiers that cover every example in this documentation. Two rules keep you safe: use the free tier account types linked below, and run `iacmp destroy` when you finish experimenting — resources you delete stop counting. `iacmp deploy` always asks for confirmation before creating anything.
:::

## AWS

**1. Create the account** (free tier, needs a credit card for identity check):

- Sign up: https://aws.amazon.com/free

**2. Install the AWS CLI:**

```bash
# macOS
brew install awscli

# Ubuntu/Debian
sudo apt install awscli

# Windows (PowerShell)
winget install Amazon.AWSCLI
```

Official installers for every OS: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html

**3. Create an access key** — in the AWS Console, go to **IAM → Users → Create user** (don't use the root account day to day), give it `AdministratorAccess` for now, then **Security credentials → Create access key**. Guide: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html

**4. Configure the CLI** with the key you just created:

```bash
aws configure
# AWS Access Key ID:     paste your access key
# AWS Secret Access Key: paste your secret key
# Default region name:   us-east-1
# Default output format: json
```

**5. Verify:**

```bash
aws sts get-caller-identity   # shows your account — credentials work
iacmp doctor                  # iacmp confirms everything is in place
```

## Azure

**1. Create the account** (free credits for 30 days + always-free services):

- Sign up: https://azure.microsoft.com/free

**2. Install the Azure CLI:**

```bash
# macOS
brew install azure-cli

# Ubuntu/Debian
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash

# Windows (PowerShell)
winget install Microsoft.AzureCLI
```

Official installers: https://learn.microsoft.com/cli/azure/install-azure-cli

**3. Log in** (opens the browser):

```bash
az login
```

**4. Verify:**

```bash
az account show               # shows your subscription — you are logged in
iacmp doctor
```

## Google Cloud (GCP)

**1. Create the account** (free credits + always-free tier):

- Sign up: https://cloud.google.com/free
- Then create a **project** in the console (note its ID): https://console.cloud.google.com/projectcreate

**2. Install the gcloud CLI:**

```bash
# macOS
brew install google-cloud-sdk

# Windows (PowerShell)
winget install Google.CloudSDK
```

Official installers (all OSes, including Linux): https://cloud.google.com/sdk/docs/install

**3. Log in and select your project** (opens the browser):

```bash
gcloud auth login
gcloud config set project YOUR-PROJECT-ID
```

**4. Verify:**

```bash
gcloud config list            # shows account + project
iacmp doctor
```

For GCP deploys, also set the project in your `iacmp.json`:

```json
{ "provider": "gcp", "projectId": "YOUR-PROJECT-ID" }
```

## Terraform (optional)

Only needed for GCP deploys and for the `--format tf` output paths:

```bash
# macOS
brew install terraform

# Windows (PowerShell)
winget install Hashicorp.Terraform
```

Official installers: https://developer.hashicorp.com/terraform/install

## Done — deploy

With any one of the clouds configured:

```bash
iacmp deploy --dry-run --provider aws   # shows the plan, touches nothing
iacmp deploy --provider aws             # real deploy (asks for confirmation)
iacmp destroy --provider aws            # removes everything when you're done
```

`iacmp doctor` is your friend at every step — it checks CLIs, credentials and versions, and `iacmp doctor --fix` installs what's missing.
