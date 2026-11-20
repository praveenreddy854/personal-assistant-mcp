# Personal Memory MCP

A private memory service for MCP agents, backed by Azure Cosmos DB for NoSQL (serverless) and Azure-hosted AI. A Chromium extension captures form edits made by you or an agent. The server speaks stateless Streamable HTTP at `/mcp` and includes an Azure Functions deployment package.

The domain is a graph of entities and evidence-backed claims. Family, health, education, work, and future subjects use the same records; adding a new kind of information does not require a new domain schema.

## Behavior

- **Remember:** preserve the source, interpret it in the service, and save supported new facts. Uncertain identity or meaning returns a clarification request.
- **Change:** corrections, replacements, and retractions produce a concrete proposal. A fully specified direct user instruction counts as approval; otherwise the agent shows the preview and asks. Approval expires after 15 minutes and is bound to the owner, client, and vault revision.
- **Recall:** combine keyword search, vectors, and bounded graph traversal; return an answer, source quotations, exact claims, dates, conflicts, and gaps. L0 is an overview, L1 domain context, and L2 detailed records. All are views over the same evidence.
- **Forms:** persist draft field revisions immediately. When you say the answers are final, obtain a fresh browser snapshot and promote supported facts. Changes to existing facts still require approval. Finalization never submits a form.
- **Forget:** remove selected claim lineages, including corrected versions and their known source representations. Purge linked form revisions and prevent queued events or old MCP retries from restoring them. `discard_form` also removes an entire draft/final form and facts that have no other evidence.

Chat approval deliberately trusts the authorized agent to report your actual instruction. It does not provide independent proof of a human action. Each Google identity owns a separate vault; being someone’s relative provides no access.

## Run locally

Prerequisites: Node.js 22+, npm, and Docker. Real extraction and answers require configured Azure deployments; the automated tests use a scripted AI and make no model calls.

```sh
npm ci
npm run db:start
cp .env.example .env
```

In `.env`, set an unpredictable local `DEV_TOKEN`, your Azure OpenAI endpoint, and the names of deployed chat and embedding models. The chat deployment must support structured JSON-schema output; the embedding deployment must support 1536 dimensions. Set `AZURE_OPENAI_API_KEY` locally, or use Azure credentials supported by `DefaultAzureCredential`. Production uses the Function App’s managed identity.

```sh
npm run db:initialize
npm run invite -- local-development local-user
npm run dev
```

The local Cosmos emulator listens only on `127.0.0.1:8081` (explorer: `http://127.0.0.1:1234`). `db:start` also works without Docker Compose; `docker compose up -d` is an alternative. Stop the named development container with `npm run db:stop`. The synthetic emulator key is local only. Azure disables account-key authentication and uses managed identity. The emulator does not enforce production RBAC.

Copy `examples/vscode.local.mcp.json` into your editor-managed VS Code MCP configuration and enter your development token when prompted. The matching remote editor example is `examples/vscode.remote.mcp.json`; current native Copilot sessions use the different format in the [launch runbook](docs/launch-runbook.md#github-copilot-in-vs-code). Browser-based remote connectors require the deployed HTTPS endpoint, not your laptop’s localhost URL.

## Use from an agent

Examples of user requests:

> Remember that my daughter Maya starts kindergarten in September 2027.
>
> Where was I living when Maya was born?
>
> Correct Maya’s birthday to May 21. Keep the correction history.
>
> Help with this medical form and remember the information I enter.
>
> These form answers are final.
>
> Forget Maya’s birthday.

The tools are `whoami`, `remember`, `recall`, `forget`, `decide_change`, `start_form`, `pair_form`, `record_form_fields`, `get_form`, `finalize_form`, and `discard_form`. Tool descriptions explain the source, approval, retry, and finalization contracts. Generate an opaque UUID for each new write request and reuse it only for retries of that exact request. A forgotten request UUID is permanently invalidated; deliberate reintroduction requires a new user request and UUID.

`remember` interprets natural language inside the service. Agents do not submit arbitrary SQL or unchecked graph mutations. To edit a fact, submit its correction through `remember`; to forget, resolve the requested scope with `recall` and use its claim IDs. An approval applies only the server’s stored proposal and cannot substitute a different payload.

## Capture forms

1. Load the `extension/` directory as an unpacked extension in a Chromium browser. Chromium is tested; Chrome/Edge are the intended distribution targets.
2. Ask your agent to call `start_form` with a form title, the exact website origin, and optionally the remembered subject’s entity ID.
3. On that form tab, open the extension, enter the memory server URL and one-time pairing code, and choose **Start capture**. Grant access to that website and the memory server.
4. Fill the form normally. The extension captures input/change events and polls for programmatic updates. It buffers interrupted uploads locally and retries using stable event IDs.
5. Tell the agent the answers are final. `finalize_form` requests a final snapshot; retry after the extension checkpoints its queue. This is one completion signal, not per-field approval.
6. Use `pair_form` to resume an unfinished session after a browser restart or expired pairing code.

Capture supports standard `input`, `textarea`, and `select` controls, open shadow roots, and same-origin frames in the explicitly paired tab. It excludes passwords, authentication-code controls, hidden fields, file contents, closed shadow roots, cross-origin frames, native dialogs, and PDF viewers. It samples field values rather than logging every keystroke. A single extension binding is active at a time; re-pair a previous draft to resume its queued uploads.

Only finalized, supported facts become reusable memory. All captured fields remain in their form context, including application-specific answers that should not become general profile facts. For example, desired salary does not become current earnings. Source copying does not refresh an old measurement date.

Offline buffers live in the browser profile. Deletion notifications remove affected queued fields on the next successful synchronization; an offline device cannot be erased remotely. Website data and already-delivered agent conversations are outside the vault’s deletion boundary. Unknown/unclassified draft data can be removed with a scoped whole-form deletion.

## Test and package

The database must be running. The tests create separate synthetic vaults and exercise vault-scoped document queries, conditional transactional batches, native vector queries, and interrupted-journal recovery.

```sh
npm run build
npm test
npx playwright install chromium
npm run test:browser
npm run package:azure
```

The browser suite loads the actual unpacked extension in an isolated Chromium profile. Its test-only manifest pre-grants localhost access; production site-permission prompts remain a manual installation check. Azure AI tests validate HTTP/output contracts with controlled responses; they do not establish live model quality or live OAuth-client compatibility.

The production ZIP is `artifacts/personal-memory-azure.zip`, with a SHA-256 file beside it. It contains compiled code, production dependencies, and `host.json`; it excludes local settings, `.env`, tests, and browser-profile data.

For an actual local Azure Functions host smoke test, install current Functions Core Tools, copy `local.settings.example.json` to `local.settings.json`, and start Azurite. Export the same application environment used by `npm run dev`, with `PUBLIC_URL=http://localhost:7071`, then run `func start`. In another terminal with the same URL and token, run `npm run smoke:functions`.

## Deploy

All resource names in these instructions are dummy examples. Create a private Azure parameter file from `infra/parameters.example.json`, replace the example values locally, then preview or deploy:

```sh
npm run deploy:azure -- --resource-group example-memory-rg --parameters memory.parameters.local.json --dry-run
npm run deploy:azure -- --resource-group example-memory-rg --parameters memory.parameters.local.json
```

The script builds, tests, packages, provisions, and publishes. `--code-only --function-app NAME` publishes an existing app without reprovisioning. Initial serving remains paused until Cosmos and OAuth setup are ready; the deployment guide covers the initialization and enable flags.

See the [Azure resource reference](docs/azure-resources.md) and [setup checklist](docs/azure-setup-status.md) for the resources and validation required for your own deployment. Keep real subscriptions, tenant IDs, resource names, endpoints and deployment records in ignored local files.

Use the [launch runbook](docs/launch-runbook.md) for detailed Google sign-in, per-agent OAuth registration, private owner invitation and live verification. Entra discovery compatibility with ChatGPT remains a launch gate; registering a client alone does not establish compatibility.

See [Azure deployment](docs/deployment.md) for Google-only Entra External ID configuration, per-client OAuth registrations, private Cosmos networking, scoped data-plane roles, invitations, and deployment commands. The infrastructure starts with memory serving paused until initialization is complete. The SDK-based Azure Functions hosting path currently uses Microsoft’s MCP custom-handler preview on Flex Consumption. [Microsoft hosting guidance](https://learn.microsoft.com/en-us/azure/azure-functions/self-hosted-mcp-servers)

See [Implementation architecture](docs/implementation.md), [domain glossary](CONTEXT.md), and [restore procedure](docs/restore.md). Credentials, cloud resources, Google federation, real model deployments, and signed-in ChatGPT/Claude/Copilot smoke tests must be configured and verified in the target Azure environment; they are not supplied by this repository.

Cosmos serverless bills consumed request units and storage, avoiding provisioned database compute. Private endpoints, DNS, Functions storage, and Azure AI have separate costs. Vector search on small collections can cost more per query before DiskANN has enough vectors to build its index; monitor RU usage. A vault is one logical partition (20 GB limit). See [Cosmos decision and tradeoffs](docs/adr/0004-cosmos-serverless-memory-store.md).
