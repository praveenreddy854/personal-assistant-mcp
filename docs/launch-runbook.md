# Launch runbook

Guidance checked against vendor documentation on 2026-11-16. All environment names, IDs, domains and addresses in this document are dummy examples. Substitute real values only in an ignored local record, private runner environment or client configuration. This is a procedure, not evidence that an environment has passed it.

Use this after [infrastructure and code deployment](deployment.md). The sequence is: Google federation, API/client registrations, OAuth compatibility, private administration, authenticated onboarding, live verification, then normal use.

## 1. Prepare the accounts and record the identifiers

Have an Azure administrator for the resource subscription, an administrator for the External ID customer tenant, access to a Google Cloud project, and the intended ChatGPT/Claude/Copilot accounts. One person can operate these accounts, but their identities and permissions serve different purposes.

| Item | Dummy example | Used for |
|---|---|---|
| Resource subscription | `EXAMPLE_SUBSCRIPTION_ID` | Functions, Cosmos, networking and Azure role assignments |
| Resource tenant | `EXAMPLE_RESOURCE_TENANT_ID` | Azure administrative and managed identities |
| Customer tenant | `EXAMPLE_CUSTOMER_TENANT_ID` | Google-federated users and OAuth applications |
| Customer subdomain | `examplecustomers` | Customer sign-in/discovery URLs |
| Function resource group | `example-memory-rg` | Function configuration commands |
| Function App | `examplememory-abc123` | Deployed MCP host |
| Public base URL | `https://examplememory-abc123.azurewebsites.net` | `PUBLIC_URL`; no trailing `/mcp` |
| MCP resource URL | `https://examplememory-abc123.azurewebsites.net/mcp` | Agent connections and protected-resource metadata |
| Cosmos account | `examplememory-cosmos-abc123` | Private database endpoint and data-plane role scopes |
| Memory API client ID | `EXAMPLE_MEMORY_API_CLIENT_ID` | Access-token audience for v2 API tokens |
| Per-product OAuth client ID | `EXAMPLE_PRODUCT_CLIENT_ID` | Identifies ChatGPT, Claude or Copilot; different from the API ID |
| Administrative principal object ID | `EXAMPLE_ADMIN_OBJECT_ID` | Separate Cosmos administrative access |

Keep the resource tenant and customer tenant distinct in your records. Creating a customer tenant does not require moving the existing Function App or Cosmos account into it. Do not assign Azure database administration to the Google customer identity merely because it is the vault owner.

## 2. Configure Google sign-in through External ID

### Create or select the customer tenant

1. Open the [Microsoft Entra admin center](https://entra.microsoft.com).
2. Go to **Entra ID > Overview > Manage tenants > Create** and choose **External**.
3. Enter a customer tenant name/subdomain, select its country/region and associate the intended Azure subscription/resource group when using a subscription-backed tenant.
4. Complete creation, switch into the new external tenant, and record its tenant ID and primary domain privately.

Use an existing suitable external tenant if available. [Microsoft tenant creation procedure](https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-create-external-tenant-portal).

### Connect Google

1. In [Google Cloud Console](https://console.cloud.google.com), select or create a project, such as `example-memory-login`.
2. Configure the OAuth consent screen/Google Auth Platform branding and audience: application name, support/contact email and External audience. Use Testing for the pilot and add intended test accounts where applicable. Basic identity scopes have an exception to the test-user restriction; the memory invitation remains the access gate. [Google publishing states](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview).
3. Create a **Web application** OAuth client. Add the federation redirect URIs and authorized domains prescribed by [Microsoft's Google federation guide](https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-google-federation-customers), substituting the customer tenant details. A documented redirect example is `https://examplecustomers.ciamlogin.com/EXAMPLE_CUSTOMER_TENANT_ID/federation/oauth2`; use the complete applicable list from the guide.
4. Save the Google client ID and secret securely.
5. In the customer tenant, open **External Identities > All identity providers > Google > Configure**, enter those Google credentials and save.

The Google client is for federation into Entra. Each agent's callback is registered on its separate Entra client, not on this Google client.

### Create the user flow

Under **External Identities > User flows**, create a browser-based sign-up/sign-in flow, such as `ExampleMemorySignIn`, and select Google. Configure Google as the only application sign-in method and verify the resulting page. If the tenant UI requires an additional local-account method, resolve that policy requirement before launch; hiding a button is not enforcement.

Collect only the profile attributes needed for onboarding. Associate each interactive OAuth client from the next section with this flow through **User flow > Applications > Add application**. The API itself does not host an interactive login. [User-flow creation](https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-user-flow-sign-up-sign-in-customers), [application association](https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-user-flow-add-application).

## 3. Register the memory API and the agent clients

### Memory API

1. In the **customer tenant**, select **App registrations > New registration**.
2. Name it `example-memory-api`, use the single-tenant account type and register it. An API does not need an interactive redirect URI.
3. Record its **Application (client) ID**.
4. In **Expose an API**, save an Application ID URI. The default `api://EXAMPLE_MEMORY_API_CLIENT_ID` avoids assuming ownership of an Azure hostname's domain.
5. Add the enabled delegated scope **memory.access**. Describe it as access to the signed-in user's invited memory vault, including writes subject to application approval rules.
6. In the Microsoft Graph format **Manifest**, set `api.requestedAccessTokenVersion` to `2`, preserving the other API properties and scopes. Older manifest formats name this setting `accessTokenAcceptedVersion`.

With the default URI, the full requested scope is `api://EXAMPLE_MEMORY_API_CLIENT_ID/memory.access`. The server separately checks the short `scp` value `memory.access`. Its `AUTH_AUDIENCE` must match the API access token's actual `aud`, normally the API client ID for v2 tokens. The canonical MCP HTTPS resource URL remains the URL advertised in protected-resource metadata; do not confuse these identifiers. [API scopes](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-configure-app-expose-web-apis), [manifest token version](https://learn.microsoft.com/en-us/entra/identity-platform/reference-microsoft-graph-app-manifest).

### Separate clients

Create three further single-tenant app registrations in the customer tenant:

| Dummy client | Callback registration | Client type |
|---|---|---|
| `example-memory-chatgpt` | Exact redirect URI shown by ChatGPT's MCP configuration | Web/confidential when using a secret; follow the product's displayed requirements |
| `example-memory-claude` | `https://claude.ai/api/mcp/auth_callback`, verified against current product guidance | Web/confidential when using a secret |
| `example-memory-copilot` | Current VS Code guidance includes `http://127.0.0.1:33418` and `https://vscode.dev/redirect` | Public/native where supported; configure the platform types required by the installed client |

For each registration:

1. Add its exact callbacks under **Authentication > Add a platform**. Avoid wildcards and unrelated callbacks. Do not enable implicit grants.
2. Under **API permissions > Add a permission > My APIs**, select the memory API, **Delegated permissions > memory.access**, then add it. Have the customer-tenant administrator grant the required consent. Customer-user self-consent must not be assumed.
3. Configure the supported OpenID/refresh-token scopes, including `openid` and `offline_access` where required. Check the actual scopes requested by each client; do not give it unrelated Google or Microsoft Graph data access.
4. Associate the interactive client with the Google user flow.
5. For a confidential client, create a secret under **Certificates & secrets**, copy its **value**, record its expiry and enter it only into that product's secure configuration. Do not send the secret to the memory Function or include it in shared JSON.

Use authorization-code flow with PKCE/S256. This is delegated user access, not client-credentials flow. [API permission configuration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-configure-app-access-web-apis), [External ID supported permissions/consent](https://learn.microsoft.com/en-us/entra/external-id/customers/concept-supported-features-customers).

## 4. Check OAuth compatibility before enabling access

This is an unresolved integration gate, not a routine checkbox. The repository validates access tokens and publishes protected-resource metadata. It does not implement an authorization server, discovery adapter, registration proxy or OAuth broker.

1. Open the actual tenant's OIDC discovery document. A tenant-specific starting pattern is:

   ```text
   https://examplecustomers.ciamlogin.com/EXAMPLE_CUSTOMER_TENANT_ID/v2.0/.well-known/openid-configuration
   ```

2. Record the returned `issuer`, `jwks_uri`, `authorization_endpoint` and `token_endpoint` exactly. The issuer can use a tenant-GUID hostname even when discovery was fetched using a named hostname. Do not construct `AUTH_ISSUER` from an example.
3. Verify that a client can discover metadata for the exact issuer advertised by the MCP server.
4. Confirm `code_challenge_methods_supported` includes `S256`, the token-endpoint authentication method matches the client, and the requested memory scope produces an access token for this API.
5. Check refresh-token renewal, callback matching and handling of the MCP `resource` parameter in the real flow.

Current OpenAI guidance rejects authorization-server metadata that omits S256. Microsoft documents that Entra v2 discovery omits the PKCE field and binds token audience using scopes rather than the OAuth `resource` parameter. That creates a compatibility risk requiring a test against this customer tenant. A successful standalone Entra login does not establish ChatGPT compatibility. [OpenAI authentication requirements](https://developers.openai.com/plugins/build/auth), [Microsoft's Entra MCP compatibility notes](https://github.com/microsoft/entrabot/blob/main/docs/platform-docs/agent-id-blueprints-and-users.md#working-around-entra-oauth-metadata-gaps).

If the discovery check fails, pause the affected client rollout. A standards-compliant integration or broker must be implemented and tested before promising support. Serving an added metadata file on the Function hostname is insufficient when clients still discover the Entra issuer directly. An adapter must preserve discovery/issuer consistency; a broker that issues its own tokens changes the trusted issuer, audience and stable owner identity. Review that identity change before invitations. This runbook does not claim that either integration already exists.

## 5. Configure the deployed Function while paused

In Azure Portal, switch back to the **resource tenant/subscription**, open the Function App and select **Settings > Environment variables** (or Configuration in an older portal layout). Preserve storage, Cosmos, model and Functions host settings. Set:

| Application setting | Value to enter |
|---|---|
| `NODE_ENV` | `production` |
| `AUTH_MODE` | `oidc` |
| `PUBLIC_URL` | The deployed base HTTPS URL, without `/mcp` |
| `AUTH_ISSUER` | Exact trusted token/discovery issuer |
| `AUTH_JWKS_URL` | Trusted discovery document's `jwks_uri` |
| `AUTH_AUDIENCE` | This memory API's actual access-token `aud` |
| `AUTHORIZATION_SERVER` | Exact working authorization-server issuer advertised to MCP clients |
| `AUTH_SCOPE` | `memory.access` |
| `AUTH_REQUEST_SCOPE` | Full scope from Expose an API, e.g. `api://EXAMPLE_MEMORY_API_CLIENT_ID/memory.access` |
| `SERVING_ENABLED` | `false` during preparation |

Save/apply and allow the app to restart. Do not enable development authentication or add a Cosmos account key. Add `ALLOWED_ORIGINS` only for browser origins actually making direct MCP calls and requiring access; follow the client's observed flow.

Visit `/healthz` and `/.well-known/oauth-protected-resource/mcp` on the deployed base URL. Health should return 200 after database startup checks. Once auth is configured, resource metadata should return the exact MCP URL, authorization server and full scope. Memory requests remain paused.

Update the corresponding OAuth values in the ignored local deployment parameter file too. Otherwise a later full Bicep deployment can overwrite portal configuration and will reset serving to false. Client secrets do not belong in those parameters.

## 6. Establish private database administration

### Provide connectivity

Use an existing trusted runner connected to the Function VNet, a peered network or a VPN with private DNS resolution. Ordinary Cloud Shell and an unconnected laptop cannot administer this private Cosmos endpoint merely by signing in.

If no connected runner exists, create a dedicated temporary Linux administrative VM in a new subnet of the same VNet, such as `admin` with `10.40.3.0/24` after checking for address overlap. Do not use the delegated `functions` subnet or the `private-endpoints` subnet. Give the VM a system-assigned identity, leave public inbound access disabled and connect through an available Bastion/private route. A VM and any Bastion service introduce separate Azure costs; retain them only as long as needed.

On the runner, install Node.js 22+, npm and the current project source/package lock; run `npm ci`. For human Azure CLI authentication, install Azure CLI and sign in to the resource tenant. For a VM identity, `DefaultAzureCredential` can obtain its managed identity directly. A managed identity needs no Cosmos password or account key.

### Grant the separate principal the required data roles

From an Azure administrator's CLI in the resource tenant, fill these dummy values privately and run:

```bash
az login --tenant EXAMPLE_RESOURCE_TENANT_ID
az account set --subscription EXAMPLE_SUBSCRIPTION_ID

az cosmosdb sql role assignment create \
  --resource-group example-memory-rg \
  --account-name examplememory-cosmos-abc123 \
  --role-definition-id 00000000-0000-0000-0000-000000000002 \
  --principal-id EXAMPLE_ADMIN_OBJECT_ID \
  --scope /dbs/memory/colls/vaults

az cosmosdb sql role assignment create \
  --resource-group example-memory-rg \
  --account-name examplememory-cosmos-abc123 \
  --role-definition-id 00000000-0000-0000-0000-000000000002 \
  --principal-id EXAMPLE_ADMIN_OBJECT_ID \
  --scope /dbs/memory/colls/identities
```

`EXAMPLE_ADMIN_OBJECT_ID` is the runner's managed-identity principal ID or the signed-in administrator's directory object ID, depending on which credentials the runner uses. Role assignment is a management-plane action; it does not need Cosmos private-endpoint connectivity. Actual initialization/invitation does. These are Cosmos data-plane roles; Azure subscription Contributor alone does not grant memory document access. [Cosmos RBAC](https://learn.microsoft.com/en-us/azure/cosmos-db/how-to-connect-role-based-access-control).

The Function retains Data Contributor on `vaults` and Data Reader on `identities`. It must not acquire the administrator's directory write role.

### Verify from the runner

Use a clean working copy without a development `.env`, or explicitly disable dotenv loading. `src/admin.ts` loads `.env` by default; an emulator `COSMOS_KEY` must not leak into cloud administration. For a managed-identity runner, also clear unrelated `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` and `AZURE_TENANT_ID` credential overrides so the intended identity is selected.

```bash
export DOTENV_CONFIG_PATH=/dev/null
unset COSMOS_KEY
export COSMOS_ENDPOINT='https://examplememory-cosmos-abc123.documents.azure.com/'
export COSMOS_DATABASE='memory'
export COSMOS_CONTAINER='vaults'
export COSMOS_DIRECTORY_CONTAINER='identities'

nslookup examplememory-cosmos-abc123.documents.azure.com
npm run db:initialize
```

DNS must resolve through the configured private endpoint, and initialization must print that Cosmos containers were verified. If it fails, fix connectivity, DNS, credential selection or role propagation. Keep public access and local account-key authentication disabled.

## 7. Enable authenticated onboarding and invite the owner

The first enable operation makes OAuth-protected endpoints available for pilot onboarding. It does not automatically create a vault. Complete the store/authentication checks first, then run in the resource subscription:

```bash
az functionapp config appsettings set \
  --resource-group example-memory-rg \
  --name examplememory-abc123 \
  --settings SERVING_ENABLED=true \
  --output none
```

After restart:

1. Send an anonymous POST to `/mcp`; expect HTTP 401 with the protected-resource discovery challenge. A plain browser GET can also encounter method/transport restrictions; test POST.
2. Connect one registered client through Google sign-in and call `whoami`.
3. Copy its verified `issuer` and `subject` privately. The server uses Entra `oid` when present, falling back to `sub`. Do not substitute an email address or an unverified decoded token.
4. Before invitation, attempt `recall`; it must fail with `not_invited`. This tool-level error can be inside an HTTP 200 MCP response, so inspect the result rather than only the HTTP status.
5. From the private administrative runner configured in step 6, run:

   ```bash
   npm run invite -- 'EXACT_VERIFIED_ISSUER' 'VERIFIED_STABLE_SUBJECT' 'owner@example.com'
   ```

6. Record the generated vault ID privately. The email is only an administrative display label.
7. Retry the client call. An empty memory is a valid result; `not_invited` is not.

Every agent signed in as the same owner should return the same stable issuer/subject and reach the same vault. If they differ, investigate the tenant, broker, sign-in method and identifier mapping. Do not invite separate identities assuming their matching emails merge vaults. New unrelated users require separate invitations and isolated vaults.

If onboarding exposes a configuration error, pause again using the same command with `SERVING_ENABLED=false` while fixing it. The current server has one serving gate, not a separate public beta mode.

## 8. Connect the three agent products

### GitHub Copilot in VS Code

For current Copilot sessions, open **Chat: Open Customizations > MCP Servers > Add Server**, choose HTTP and a personal Copilot destination. Configure the endpoint and pre-registered client ID. Current portable Copilot configuration uses `mcpServers` and a flat `oauthClientId`, for example:

```json
{
  "mcpServers": {
    "personal-memory": {
      "type": "http",
      "url": "https://examplememory-abc123.azurewebsites.net/mcp",
      "oauthClientId": "EXAMPLE_COPILOT_CLIENT_ID",
      "tools": ["*"]
    }
  }
}
```

Authenticate when prompted and call `whoami`. Put real values in personal configuration. The repository's `examples/vscode.remote.mcp.json` is the older editor-managed `servers`/nested `oauth` format. Use it only with a matching editor-managed connection; its input prompts are not portable to the native Copilot harness. [Current configuration format](https://code.visualstudio.com/docs/agents/reference/mcp-configuration), [OAuth callbacks](https://code.visualstudio.com/api/extension-guides/ai/mcp).

### Claude

1. Open **Customize > Connectors > Add > Add custom connector**.
2. Enter a name and the complete HTTPS `/mcp` URL.
3. Review detected authentication, choose sign-in and **Use your own OAuth client**.
4. Enter the Claude-specific client ID and secret if issued, then connect through Google.
5. Enable the connector in a conversation and call `whoami`.

Use the documented `https://claude.ai/api/mcp/auth_callback` callback and verify current product guidance. Organizational connector creation can require an owner/admin. Claude's remote connection originates from Anthropic's cloud; the Function's HTTPS endpoint must be reachable there, while Cosmos stays private. [Claude setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

### ChatGPT

1. Complete step 4's discovery compatibility gate first.
2. Open [ChatGPT Plugins](https://chatgpt.com/plugins), select **+ > Add custom MCP server**, and enter the name, description and HTTPS `/mcp` URL.
3. Select OAuth and the predefined client option; enter the ChatGPT-specific client ID and secret when required.
4. Copy the exact callback displayed by this connection into that Entra client's redirect allowlist. Depending on issuer identification, ChatGPT uses a connection-specific or stable callback; do not guess it from an old example.
5. Complete creation, review the discovered tools, install/enable it and call `whoami` from a conversation.

Account/workspace policy controls whether custom MCP setup is available. Callback and menu details can change. [Official connection procedure](https://developers.openai.com/plugins/deploy/connect-chatgpt), [OAuth requirements and callbacks](https://developers.openai.com/plugins/build/auth).

## 9. Verify live memory and AI behavior

Use a test-only vault or clearly synthetic records. The automated tests use controlled model responses, so deployed model quality needs separate verification. New writes need a fresh opaque UUID; retries reuse that UUID for exactly the same request. Supply the actual request time and IANA timezone when a tool requires `context`.

Run these checks through a connected agent and inspect actual tool results:

| Check | Suggested instruction | Expected result |
|---|---|---|
| New fact | "For a synthetic test, remember that Example Child's birthday is May 12, 2020." | Supported fact saved with a claim ID and source evidence |
| Recall | "What birthday did I save for Example Child? Show the evidence." | Correct subject, exact date and source; no invented details |
| Levels | Ask for family overview at L0, domain context at L1, then exact birthday at L2 | Appropriate detail from the same underlying records; exact form data grounded at L2 |
| Correction preview | "Prepare a correction to May 21, 2020, but do not apply it yet." | An approval proposal; ordinary recall still shows the prior value |
| Correction decision | Approve the shown exact change in the same client | Updated normal recall; correction history only when requested |
| Temporal event | "In this synthetic scenario, I moved from Exampletown to Sampleville on June 1, 2025." | Before/after location questions respect the date |
| Identity ambiguity | Introduce two synthetic people with the same name | Clarification rather than silently merging people |
| Unknown fact | Ask for a synthetic child's school when none was supplied | Missing-information answer |
| Isolation | Sign in with a second, uninvited test account | `whoami` works, memory access denied; a separately invited test vault sees none of the first owner's records |

Test a fully specified direct edit separately: it can count as the user's approval under this application's contract. The preview-only wording above deliberately withholds approval. Decisions are scoped to the proposing OAuth client and expire; changing clients is not an approval transfer.

A successful remember/recall exercises live chat extraction/answering and embeddings. Inspect Function logs for failures without logging memory content. Verify the intended model deployments, 1536-dimensional embeddings, managed-identity inference and quota before changing any model configuration. Preserve `EMBEDDING_VERSION` for the deployed index contract.

The optional host smoke command lists tools and calls `whoami`; it does not test AI quality or vault writes:

```bash
export DOTENV_CONFIG_PATH=/dev/null
export PUBLIC_URL='https://examplememory-abc123.azurewebsites.net'
# Inject a short-lived delegated access token as MCP_ACCESS_TOKEN through a
# private runner's secure environment; do not paste tokens into shared files.
npm run smoke:functions
```

Use a token obtained through the registered delegated flow. An Azure CLI management token, Function key, Google ID token or service-principal token does not replace it.

## 10. Verify form capture and forgetting

### Capture a synthetic form

1. Open `chrome://extensions`, enable Developer mode and **Load unpacked**, selecting the project's `extension/` directory. This is a manual pilot installation, not Chrome Web Store publication.
2. Use an HTML test form with standard named text/date/select/checkbox fields and synthetic data. It needs an exact HTTP(S) website origin. Native PDF viewers, file contents, passwords, closed shadow roots and cross-origin frame fields are outside the supported capture surface.
3. Ask the agent to call `start_form` with a title, exact `page_origin` and correct subject; owner is the default.
4. On that form tab, open the extension, enter the server base URL and one-time pairing code, choose **Start capture** and grant its requested site/server access.
5. Enter synthetic answers manually and modify at least one value. Ask the agent for `get_form`; confirm draft field values/revisions are present.
6. Briefly disconnect the browser network, edit a supported field, reconnect and confirm retry catches up. Do not delete local buffers to simulate an ordinary connection interruption.
7. Say the answers are final. The agent calls `finalize_form`, waits for the extension's fresh checkpoint and retries as directed using the same idempotency key. Capture must remain connected for this step.
8. Verify the session is final and supported facts are recalled with source evidence. Review any proposed change to existing memory before approval. Contextual answers such as desired salary must remain distinguishable from existing salary.

This process saves drafts and final supported facts without submitting the website form. Verify only the stated capture surface; the extension cannot promise to capture every field on every website. See [form usage and limits](../README.md#capture-forms).

### Forget and check retries

1. Recall the synthetic fact and retain its claim IDs and original write request UUID in a private test record.
2. Ask to preview forgetting that exact fact, including its correction history. Review the proposed scope and approve it in the proposing client.
3. Recall the fact and explicitly request its revision history: the deleted lineage must be absent from memory results.
4. Retry the original write with the same request UUID: it must not restore the fact.
5. For a captured fact, verify that identified source field copies/revisions are removed. A delayed event carrying an old value must not recreate deleted data. Whole unclassified drafts need the explicit `discard_form` preview/approval flow.
6. Export content-free deletion receipts from the private runner to an independently protected location:

   ```bash
   npm run export:deletions -- /secure-independent-location/memory-deletions.json
   ```

7. For a restore rehearsal, use an isolated test restore and follow [the restore runbook](restore.md), keeping serving paused until receipts are replayed and verified. Never restore over the live database merely to test this checklist.

Online devices synchronize queue deletion; offline devices do so on their next connection. Cosmos backup expiry, third-party website copies and already-delivered chat messages have separate boundaries. Export after future deletions too; no independent archive destination or scheduled export is provisioned by this repository.

## 11. Finish the pilot and keep a private readiness record

Record the checks, client versions and results in an ignored `docs/*.local.md` file. Keep the public checklist generic.

- The configured issuer, scope, audience, discovery and PKCE flow pass for every claimed client.
- Anonymous requests are rejected, the intended owner is invited, and other vaults remain isolated.
- Each product reaches the same owner identity and recalls the same synthetic record.
- Live model output, correction approvals, form capture, forgetting and stale retries pass.
- An independent deletion receipt export exists and the restore procedure is understood.

If all checks pass and serving is still enabled from onboarding, there is no second publication switch. Begin normal use and remove temporary administrative access/resources when no longer needed. If it was paused, enable it only after the failed checks are resolved.

This finishes a private invited-user MCP deployment. Public marketplace listing, Google app production review and browser-extension store distribution are separate release processes; they are not performed by the Azure deployment script.
