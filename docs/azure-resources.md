# Azure resource reference

All deployment-specific names, IDs and URLs in this document are dummy examples. They do not identify a running environment. Bicep generates a unique suffix, so use deployment outputs for your own resource names and keep those values in ignored local records.

Azure provider names, built-in roles and the required private DNS zone are public platform constants. The generic database/container names `memory`, `vaults`, `identities` and `deployments` are defaults defined by the template, not identifiers for a particular account.

## Example environment

| Setting | Dummy value |
|---|---|
| Subscription | `EXAMPLE_SUBSCRIPTION_ID` |
| Tenant | `EXAMPLE_TENANT_ID` |
| Resource group | `example-memory-rg` |
| Region | `centralus` |
| Prefix | `examplememory` |
| Illustrative generated suffix | `abc123` |
| MCP URL | `https://examplememory-abc123.azurewebsites.net/mcp` |
| Health URL | `https://examplememory-abc123.azurewebsites.net/healthz` |
| Cosmos endpoint | `https://examplememory-cosmos-abc123.documents.azure.com/` |
| Existing model account | `example-ai-account` in `example-ai-rg` |

The suffix above is illustrative, not an instruction to override `uniqueString`. Copy [the example parameter file](../infra/parameters.example.json) into an ignored `*.parameters.local.json` file and replace its placeholders there.

## Resources provisioned by Bicep

[The main template](../infra/main.bicep) creates the following resources. Names in this table use the dummy environment above.

| Resource | Example name or scope | Purpose |
|---|---|---|
| Virtual network | `examplememory-vnet` | Provides Functions integration and private endpoint connectivity. |
| Private DNS zone | `privatelink.documents.azure.com` | Resolves Cosmos private endpoints. This exact Azure-defined zone is required. |
| DNS virtual network link | `memory-network` under the private zone | Links private DNS resolution to the VNet; automatic registration is disabled. |
| Cosmos DB account | `examplememory-cosmos-abc123` | Hosts NoSQL serverless data with Strong consistency and seven-day continuous backups. |
| Cosmos database | `memory` under the example account | Groups memory and identity-directory containers. |
| Memory container | `memory/vaults` | Stores generic graph, evidence, form, approval and deletion documents, partitioned by `/vault_id`. |
| Identity directory container | `memory/identities` | Maps verified identities to vaults, partitioned by `/id`. |
| Private endpoint | `examplememory-cosmos-private` | Connects the Cosmos `Sql` service to the private endpoint subnet. |
| Private endpoint DNS zone group | `default` under the private endpoint | Maintains DNS records for the Cosmos private endpoint. |
| Storage account | `memoryabc123` | Holds Functions host state and deployment packages; shared-key and anonymous blob access are disabled. |
| Blob service | `default` under the storage account | Hosts the deployment container. |
| Deployment blob container | `deployments` | Stores the ready-to-run Functions ZIP package. |
| Functions hosting plan | `examplememory-plan` | Provides Linux Flex Consumption hosting. |
| Function App | `examplememory-abc123` | Runs the Node.js 22 MCP custom handler with a system-assigned identity, HTTPS and VNet integration. |
| Function App settings | `appsettings` under the Function App | Configures Cosmos, OAuth and model deployments; starts with `SERVING_ENABLED=false`. |
| Storage role assignment | Function identity → deployment storage account | Grants Storage Blob Data Owner for host state and package access. |
| Memory role assignment | Function identity → `memory/vaults` | Grants Cosmos DB Built-in Data Contributor. |
| Directory role assignment | Function identity → `memory/identities` | Grants Cosmos DB Built-in Data Reader. |
| Model-access nested deployment | `memory-model-access-abc123` in the model resource group | Applies [the model-access module](../infra/model-access.bicep), granting Cognitive Services OpenAI User on the existing model account. |

The VNet contains `functions` (`10.40.1.0/24`, delegated to `Microsoft.App/environments`) and `private-endpoints` (`10.40.2.0/24`) subnets within `10.40.0.0/16`. These are example private address ranges; check for conflicts with connected networks before deployment.

Cosmos disables public network access and account-key authentication. The memory container has a 1536-dimensional float32 cosine embedding policy and a native DiskANN index. Raw embedding arrays and compressed journal/proposal payloads are excluded from ordinary indexing. Serverless containers have no provisioned RU/s setting.

## Existing resources and external prerequisites

The template reuses an Azure OpenAI account in the same subscription, optionally in a separate resource group. It does not create model deployments. Supply a structured-output chat deployment and a 1536-dimensional embedding deployment; the generic example deployment names are `memory-reasoning` and `memory-embedding`.

Google federation, an Entra External ID customer tenant, API/client OAuth registrations, private administrative connectivity and owner invitations are configured separately. See [the deployment guide](deployment.md). The template creates no PostgreSQL server, database password, new Key Vault, Azure AI Search service or separate graph database. It does not automatically remove resources from an earlier deployment.

## Access boundaries

The Function identity can write the memory container and only read the identity directory. Invitations and receipt administration require a separate administrative Entra principal with the appropriate data-plane roles and private network connectivity. The runtime receives no administrative database credential or model API key.

Cosmos roles are scoped to containers, not individual users. The trusted service resolves the verified issuer/subject to a vault and supplies its partition key on every memory operation. Remembered relatives do not receive access. [The implementation architecture](implementation.md) describes isolation, conditional commits and journal recovery.

The MCP HTTPS endpoint is reachable by agent clients; application OAuth protects memory access. The database is reachable through its private endpoint. Public Functions reachability does not imply public database access or anonymous memory access.

## Configuration and outputs

The template outputs `functionAppName`, `mcpUrl`, `cosmosEndpoint`, `cosmosAccountName`, `databaseName` and `subnetForAdminRunner`. Store actual output values locally, not in this reference.

The runtime uses `PUBLIC_URL`, `COSMOS_ENDPOINT`, `COSMOS_DATABASE`, `COSMOS_CONTAINER`, `COSMOS_DIRECTORY_CONTAINER`, the `AUTH_*` settings, `AUTHORIZATION_SERVER`, Azure OpenAI deployment settings and `EMBEDDING_VERSION`. Use managed identity in Azure; `COSMOS_KEY` is supported only for the local emulator. [The environment example](../.env.example) and [deployment guide](deployment.md) explain these settings.

With serving paused, `/healthz` can return 200 once store initialization succeeds, while memory/capture requests return 503 `serving_paused`. OAuth discovery also returns 503 when its configuration is incomplete. A successful infrastructure or package deployment alone does not mean the memory tools are ready for users. Complete [the setup checklist](azure-setup-status.md) before enabling access.

## Operations and costs

Monitor request units, throttling, host errors, latency, stored form revisions and per-vault growth. Serverless database usage, private networking, DNS, host storage and model inference have separate costs. A vault uses one logical partition; plan for its size limit before increasing workload limits. Backups can retain older data until expiry, so export deletion receipts independently and follow [the restore procedure](restore.md).

Keep actual deployment IDs, object IDs, account details, resource names, live URLs, package hashes, logs and approval records in ignored local files such as `docs/azure-setup-status.local.md`. Public documentation should describe configuration and expected behavior using dummy values only.
