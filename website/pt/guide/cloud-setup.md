# Contas de nuvem e CLIs

Nunca usou nuvem? Esta página te leva do zero ao "pronto pra deployar" em cada provider. Você só precisa de **uma** delas pra começar — na dúvida, vá de AWS (é a mais comum e o free tier cobre tudo deste guia).

::: tip Custos
As três nuvens têm free tier que cobre todos os exemplos desta documentação. Duas regras te mantêm seguro: use os tipos de conta gratuitos linkados abaixo, e rode `iacmp destroy` quando terminar de experimentar — recurso deletado para de contar. O `iacmp deploy` sempre pede confirmação antes de criar qualquer coisa.
:::

## AWS

**1. Crie a conta** (free tier; pede cartão de crédito para verificação de identidade):

- Cadastro: https://aws.amazon.com/free

**2. Instale o AWS CLI:**

```bash
# macOS
brew install awscli

# Ubuntu/Debian
sudo apt install awscli

# Windows (PowerShell)
winget install Amazon.AWSCLI
```

Instaladores oficiais para todos os sistemas: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html

**3. Crie uma access key** — no Console da AWS, vá em **IAM → Users → Create user** (não use a conta root no dia a dia), dê `AdministratorAccess` por enquanto, e em **Security credentials → Create access key**. Guia: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html

**4. Configure o CLI** com a key que você criou:

```bash
aws configure
# AWS Access Key ID:     cole a sua access key
# AWS Secret Access Key: cole a sua secret key
# Default region name:   us-east-1
# Default output format: json
```

**5. Verifique:**

```bash
aws sts get-caller-identity   # mostra sua conta — credenciais funcionando
iacmp doctor                  # o iacmp confirma que está tudo no lugar
```

## Azure

**1. Crie a conta** (créditos grátis por 30 dias + serviços sempre gratuitos):

- Cadastro: https://azure.microsoft.com/free

**2. Instale o Azure CLI:**

```bash
# macOS
brew install azure-cli

# Ubuntu/Debian
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash

# Windows (PowerShell)
winget install Microsoft.AzureCLI
```

Instaladores oficiais: https://learn.microsoft.com/cli/azure/install-azure-cli

**3. Faça login** (abre o navegador):

```bash
az login
```

**4. Verifique:**

```bash
az account show               # mostra sua subscription — você está logado
iacmp doctor
```

## Google Cloud (GCP)

**1. Crie a conta** (créditos grátis + camada sempre gratuita):

- Cadastro: https://cloud.google.com/free
- Depois crie um **projeto** no console (anote o ID dele): https://console.cloud.google.com/projectcreate

**2. Instale o gcloud CLI:**

```bash
# macOS
brew install google-cloud-sdk

# Windows (PowerShell)
winget install Google.CloudSDK
```

Instaladores oficiais (todos os sistemas, incluindo Linux): https://cloud.google.com/sdk/docs/install

**3. Faça login e selecione o projeto** (abre o navegador):

```bash
gcloud auth login
gcloud config set project SEU-PROJECT-ID
```

**4. Verifique:**

```bash
gcloud config list            # mostra conta + projeto
iacmp doctor
```

Para deploys no GCP, defina o projeto também no `iacmp.json`:

```json
{ "provider": "gcp", "projectId": "SEU-PROJECT-ID" }
```

## Terraform (opcional)

Só é necessário para deploys no GCP e para as saídas `--format tf`:

```bash
# macOS
brew install terraform

# Windows (PowerShell)
winget install Hashicorp.Terraform
```

Instaladores oficiais: https://developer.hashicorp.com/terraform/install

## Pronto — deploy

Com qualquer uma das nuvens configurada:

```bash
iacmp deploy --dry-run --provider aws   # mostra o plano, não toca em nada
iacmp deploy --provider aws             # deploy de verdade (pede confirmação)
iacmp destroy --provider aws            # remove tudo quando terminar
```

O `iacmp doctor` é seu amigo em cada passo — checa CLIs, credenciais e versões, e `iacmp doctor --fix` instala o que faltar.
