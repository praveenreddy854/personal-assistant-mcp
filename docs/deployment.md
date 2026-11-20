# Azure deployment

All subscription IDs, tenant IDs, resource names and endpoints in this guide are placeholders or dummy examples. Replace them only in your ignored local parameter files and administrative environment. See the [resource reference](azure-resources.md) for the complete inventory and [setup checklist](azure-setup-status.md) for verification.

Follow the [launch runbook](launch-runbook.md) for detailed Google federation, OAuth registrations, private owner invitation and live client checks. It also records the unresolved Entra discovery/ChatGPT PKCE compatibility gate.

## Prerequisites

- An Azure subscription and permission to create the resources and role assignments in `infra/main.bicep`.
- Azure CLI, a current Bicep compiler, Node.js 22, npm, and current Azure Functions Core Tools.
- Register `Microsoft.App` in the target subscription before using Functions VNet integration. This supporting provider is not automatically registered by the template. The deployment helper checks registration and conflicting VNet locations before building or creating resources. Cosmos serverless/vector availability is validated by the Azure deployment.
- An Azure OpenAI account in the same subscription, with a structured-output chat deployment and a 1536-dimensional embedding deployment. Set `modelResourceGroup` if reusing an account in another resource group. Deployment names default to `memory-reasoning` and `memory-embedding`. The code does not assume a particular model version.
- A Microsoft Entra External ID external tenant with Google as the only enabled sign-in provider for this application’s browser-delegated user flow. [Microsoft configuration guidance](https://learn.microsoft.com/en-us/entra/external-id/customers/concept-authentication-methods-customers)

## OAuth configuration

Register the memory service as an API and expose the delegated scope `memory.access`. Require authorization-code flow with PKCE/S256 and v2 resource access tokens. The default Entra API URI `api://API_CLIENT_ID` gives the requested scope `api://API_CLIENT_ID/memory.access`; the canonical HTTPS `/mcp` resource URL is advertised separately. Copy the exact issuer and signing-key URL from trusted discovery rather than constructing them from a tenant-name example.

Set these service values from the actual tenant/application configuration:

| Setting | Meaning |
|---|---|
| `AUTH_ISSUER` | Exact issuer in access tokens |
| `AUTH_JWKS_URL` | Trusted issuer’s HTTPS signing-key endpoint |
| `AUTH_AUDIENCE` | API audience actually issued in `aud` |
| `AUTHORIZATION_SERVER` | Authorization-server issuer advertised through protected-resource metadata |
| `AUTH_SCOPE` | Scope string inside token `scp`, default `memory.access` |
| `AUTH_REQUEST_SCOPE` | Full delegated scope URI requested by OAuth clients |

The server publishes `/.well-known/oauth-protected-resource/mcp`. The authorization provider must publish discovery metadata, authorize clients, handle refresh tokens, and issue tokens intended for the memory resource. The application validates tokens independently; Function keys are not user identities. No custom OAuth server or dynamic-registration proxy is implemented here.

Before claiming client compatibility, verify the provider's discovery document advertises `code_challenge_methods_supported: ["S256"]` and that requested scopes produce the correct API audience. Current OpenAI guidance requires that PKCE metadata, while Microsoft documents its omission from Entra v2 discovery. A compatible integration may therefore require additional implementation; this repository does not supply an adapter or broker. See the [launch compatibility gate](launch-runbook.md#4-check-oauth-compatibility-before-enabling-access), [OpenAI requirements](https://developers.openai.com/plugins/build/auth) and [Microsoft's integration notes](https://github.com/microsoft/entrabot/blob/main/docs/platform-docs/agent-id-blueprints-and-users.md#working-around-entra-oauth-metadata-gaps).

For this pilot, pre-register a separate OAuth client for each target product. Configure the exact redirect URI displayed by that product and its public/confidential client requirements. Do not automatically merge accounts by email. The server uses Entra `oid` plus issuer when available, falling back to verified `sub` for other configured providers.

## Client setup

- **GitHub Copilot in VS Code:** follow the [current configuration guidance](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) and [runbook example](launch-runbook.md#github-copilot-in-vs-code). Native Copilot uses `mcpServers` with `oauthClientId`; `examples/vscode.remote.mcp.json` is the older editor-managed format. Register the callbacks required by the installed client. [VS Code OAuth integration](https://code.visualstudio.com/api/extension-guides/ai/mcp)
- **ChatGPT:** add the deployed remote MCP endpoint through the available custom MCP/plugin configuration and choose the pre-defined OAuth client path. Use its displayed client/redirect configuration. Discovery must advertise S256 and the correct resource/scopes. [Official OpenAI authentication guidance](https://developers.openai.com/plugins/build/auth)
- **Claude:** add a custom remote connector for the deployed endpoint and select its own OAuth client option. Enter the registered client ID and a secret if the client is confidential. Claude currently documents `https://claude.ai/api/mcp/auth_callback`; verify the displayed value before registration. Remote connectors connect from Anthropic’s infrastructure, including when used in Claude Desktop. [Claude connector guidance](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

Client product availability, settings, and callbacks can change. The repository’s protocol tests verify the official SDK transport; they do not replace signed-in smoke tests for the actual pilot accounts.

## Provision and initialize

Create a private parameter file from `infra/parameters.example.json`, with your existing model resource/deployment names and actual OAuth settings. No database password or account key is required. Use a dedicated resource group, such as the dummy name `example-memory-rg`, to isolate the deployment from other workloads.

```sh
npm run deploy:azure -- --resource-group example-memory-rg --parameters memory.parameters.local.json --dry-run
npm run deploy:azure -- --resource-group example-memory-rg --parameters memory.parameters.local.json
```

The helper builds, runs server/deployment/browser tests, packages production dependencies, validates/provisions Bicep and publishes the ZIP. Start the local emulator first (`npm run db:start`); install Playwright Chromium for browser tests. A dry run executes nothing and prints no parameter values. `--subscription ID` selects an account without changing the CLI default; `--location REGION` overrides both parameter-file location and resource-group metadata. The default is `centralus`. A VNet already created in another region cannot move in place; use a fresh group/prefix and review cleanup separately.

Bicep provisions Cosmos DB for NoSQL serverless (no provisioned RU/s), Strong consistency, seven-day continuous backups, a `/vault_id` partitioned memory container with 1536-dimensional cosine/DiskANN indexing, and an `/id` partitioned identity directory. Public database networking and account-key authentication are disabled. The Function VNet reaches Cosmos through a private endpoint and private DNS. No PostgreSQL, database password, or new Key Vault is created.

The Function managed identity gets Cosmos Data Contributor only on `/dbs/memory/colls/vaults` and Cosmos Data Reader only on `/dbs/memory/colls/identities`. It also receives access to host deployment storage and the existing Azure OpenAI account (including a different resource group). The application owns vault scoping inside the memory container; these roles do not enforce per-user row isolation.

The initial deployment sets `SERVING_ENABLED=false`. Infrastructure and the paused server can bootstrap with empty OAuth values. The health endpoint runs; memory/capture endpoints and incomplete OAuth discovery return 503 until configuration is complete. Enabling serving requires all trusted OAuth settings. The Google-federated tenant, model deployments and quotas remain prerequisites.

Set `COSMOS_ENDPOINT` to the deployment output and `COSMOS_DATABASE=memory` on a trusted administrative runner connected to the VNet (VPN, peered network, or a private CI runner). Ordinary Cloud Shell and your laptop cannot reach the private endpoint without connectivity. Use Entra credentials through `DefaultAzureCredential` (`az login` locally or managed/workload identity in CI); do not set `COSMOS_KEY` in Azure.

An administrator with permission to assign Cosmos data-plane roles grants the dedicated administrative principal Data Contributor on both containers. Do not give the Function identity directory write access. For example, replace the dummy resource group, account and administrator object ID in your private runner environment:

```sh
az cosmosdb sql role assignment create --resource-group example-memory-rg --account-name COSMOS_ACCOUNT --role-definition-id 00000000-0000-0000-0000-000000000002 --principal-id ADMIN_OBJECT_ID --scope /dbs/memory/colls/vaults
az cosmosdb sql role assignment create --resource-group example-memory-rg --account-name COSMOS_ACCOUNT --role-definition-id 00000000-0000-0000-0000-000000000002 --principal-id ADMIN_OBJECT_ID --scope /dbs/memory/colls/identities
npm run db:initialize
```

Bicep creates cloud containers. `db:initialize` verifies partition keys, vector policy and Strong account consistency; it creates containers only for the local emulator. No SQL migration is needed. Role assignments may take time to propagate. Confirm private DNS resolves the endpoint privately from the Function and admin runner, and verify the runtime cannot write the directory before enabling serving.

From that runner, `--initialize` verifies the containers before publishing; `--initialize --enable-serving` also enables serving at the end. If initialized separately and OAuth/invitations are verified, use `--store-ready --enable-serving`. The helper refuses an initialization endpoint that differs from this deployment. It does not load a development `.env`.

For subsequent code-only updates, preserving infrastructure and the serving setting:

```sh
npm run deploy:azure -- --resource-group example-memory-rg --code-only --function-app FUNCTION_APP_NAME
```

Code-only initialization additionally requires `--cosmos-endpoint https://COSMOS_ACCOUNT.documents.azure.com/`. Use `--skip-tests` only for an artifact already validated by your pipeline. `test:deploy` verifies helper behavior with a controlled CLI; it does not create cloud resources.

Set `PUBLIC_URL` to the exact deployed hostname, and confirm issuer, audience, scope and metadata. Configure `ALLOWED_ORIGINS` only for browser clients that send an Origin header. Native/cloud MCP clients usually do not need browser CORS access. After configuration and store verification, enable serving:

```sh
az functionapp config appsettings set --resource-group example-memory-rg --name FUNCTION_APP_NAME --settings SERVING_ENABLED=true
```

Connect a pilot client through Google and call `whoami`. The administrator invites its verified issuer/subject pair from the private runner:

```sh
npm run invite -- ISSUER STABLE_SUBJECT OPTIONAL_DISPLAY_EMAIL
```

Uninvited identities can obtain their own identity for onboarding but cannot access a vault. The optional email is an administrative label, never an authorization key. OAuth identity discovery requires serving enabled; no private vault exists until explicitly invited.

## Verify the deployment

1. Confirm anonymous protected requests return 401 and point to the correct discovery document.
2. Obtain an access token through the registered OAuth client and run `npm run smoke:functions` with `PUBLIC_URL` and `MCP_ACCESS_TOKEN` set. The smoke test reads no private memories.
3. From each signed-in target client, remember a synthetic fact, recall its evidence, correct it, and approve the exact proposal.
4. Pair the extension with a synthetic HTML form, edit manually, disconnect/reconnect, and finalize. Confirm that a changed field invalidates an older checkpoint/proposal.
5. Forget that test fact and confirm old MCP request UUIDs and queued field events cannot restore it.

The custom-handler host uses the current [Azure Functions MCP hosting preview](https://learn.microsoft.com/en-us/azure/azure-functions/self-hosted-mcp-servers) on Flex Consumption. Local host testing uses Functions Core Tools with `FUNCTIONS_WORKER_RUNTIME=node`; the MCP profile starts the custom Node server. Production host storage uses managed identity. Local hosting needs Azurite when `AzureWebJobsStorage=UseDevelopmentStorage=true`.

## Operations

- Keep account keys disabled, public networking disabled, and the Function identity read-only on the directory. Administrative identity access is separate from runtime access.
- Monitor consumed RUs, 429 retries, latency, revision growth and per-vault storage. Serverless suits idle-heavy traffic but has variable usage costs; Strong reads and vector scans consume RUs. Private endpoint/DNS, Functions storage and model inference remain separately billed. [Cosmos serverless](https://learn.microsoft.com/en-us/azure/cosmos-db/serverless)
- Each vault uses one logical partition (20 GB limit); serverless is single-region and capped per physical partition. Redesign before exceeding those limits. Do not silently change the partition key or weaken consistency.
- Backups use seven-day continuous retention. Export deletion receipts independently after deletions and follow [restore instructions](restore.md). Restoring an account does not restore private endpoint/firewall/data-plane roles; reapply those before any access. [Restore behavior](https://learn.microsoft.com/en-us/azure/cosmos-db/continuous-backup-restore-introduction)
- Never log request bodies, model prompts/results, form values, capture tokens or secrets. The application does not log them.
- Keep `EMBEDDING_VERSION` stable for the deployed model/dimension contract. A model change requires explicit reindexing; do not mix vector versions. The current container uses 1536 dimensions. DiskANN scans below 1,000 vectors and can cost more per query for small collections. [Vector limits](https://learn.microsoft.com/en-us/azure/cosmos-db/vector-search)
- Validate chosen model quality on relative dates, ambiguous people, future births, measurements, corrections and contextual form fields before using real personal data. Controlled-response tests verify invariants, not semantic accuracy.

## Public documentation and local records

Publish generic architecture, resource definitions, permissions, deployment steps and verification procedures. Keep actual subscription/tenant IDs, resource names, deployed URLs, object IDs, deployment IDs, package checksums tied to a deployment, logs and approval records in ignored local files. `memory.parameters.local.json`, `.env`, `local.settings.json`, `artifacts/` and `docs/*.local.md` are excluded from source control. Cloud credentials belong in the appropriate identity provider or secret environment. Review staged files before publishing; ignore rules do not remove already tracked files or previous Git history.
