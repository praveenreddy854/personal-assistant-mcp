# Azure setup checklist

This is a public checklist, not a status report for a particular subscription. All names, IDs and URLs below are dummy values. See [the resource reference](azure-resources.md) for the full inventory and [the deployment guide](deployment.md) for commands.

Use the [launch runbook](launch-runbook.md) for the detailed authentication, owner invitation, client connection and verification procedure.

## Infrastructure and code deployment

- [ ] Select the intended subscription and a dedicated resource group, such as `example-memory-rg`.
- [ ] Confirm `Microsoft.App` is registered and the region supports the selected Functions/Cosmos configuration.
- [ ] Copy `infra/parameters.example.json` to an ignored local parameter file; set actual model and OAuth values there.
- [ ] Validate and deploy Bicep. Confirm the ARM deployment succeeds with no failed operations.
- [ ] Confirm Cosmos is serverless, uses Strong consistency and the expected backup policy, and disables public access and account keys.
- [ ] Verify container partition keys and the 1536-dimensional cosine vector policy/index.
- [ ] Confirm the private endpoint is Succeeded/Approved and private DNS is linked to the Function VNet.
- [ ] Verify the Function identity has vault-container write access and identity-directory read access, with no directory write grant.
- [ ] Verify scoped storage and existing-model inference permissions.
- [ ] Build, test and package the server. Verify the uploaded ZIP checksum against the locally built artifact.
- [ ] Publish the package and confirm the code deployment succeeds.
- [ ] Check `/healthz` and verify memory/capture requests remain blocked while serving is paused.

## Authentication and user readiness

- [ ] Configure the Google-federated External ID tenant, API audience/scope and separate OAuth client registrations.
- [ ] Configure the exact issuer, signing-key endpoint, authorization server and client callbacks.
- [ ] Resolve the Entra discovery/PKCE metadata compatibility gate for ChatGPT and verify actual client OAuth flows.
- [ ] Verify the store from a trusted private administrative runner.
- [ ] Enable serving only after store and authentication configuration are ready.
- [ ] Call `whoami`, invite the verified owner identity, and confirm uninvited identities cannot access memory.
- [ ] Run signed-in client checks for ChatGPT, Claude and GitHub Copilot.
- [ ] Test synthetic remember, recall, scoped correction approval, form capture/finalization and forgetting.
- [ ] Confirm old request IDs and queued capture events cannot restore forgotten data.
- [ ] Validate model quality and export deletion receipts independently before using real personal data.

## Expected endpoint behavior

| State | Health | Memory/capture | OAuth discovery |
|---|---|---|---|
| Store initialized; serving paused; OAuth incomplete | 200 | 503 `serving_paused` | 503 configuration pending |
| Store initialized; serving paused; OAuth configured | 200 | 503 `serving_paused` | Resource metadata |
| Serving enabled; OAuth configured | 200 | Requires verified user identity or session-scoped capture token | Resource metadata |

Health confirms server/store startup, not completion of OAuth setup or signed-in client verification. Follow [the authenticated smoke procedure](deployment.md#verify-the-deployment) before marking an environment ready.

## Private deployment record template

Copy this dummy template into an ignored `docs/*.local.md` file. Fill in real values only in that local record. Keep credentials in the appropriate identity/secret environment rather than this record.

```text
Environment: EXAMPLE_ENVIRONMENT
Subscription: EXAMPLE_SUBSCRIPTION_ID
Tenant: EXAMPLE_TENANT_ID
Resource group: example-memory-rg
Function App: examplememory-abc123
MCP URL: https://examplememory-abc123.azurewebsites.net/mcp
Cosmos account: examplememory-cosmos-abc123
Infrastructure deployment: EXAMPLE_INFRASTRUCTURE_DEPLOYMENT_ID
Code deployment: EXAMPLE_CODE_DEPLOYMENT_ID
Package SHA-256: EXAMPLE_PACKAGE_SHA256
Verification date: YYYY-MM-DD
Infrastructure result: NOT_CHECKED
Code deployment result: NOT_CHECKED
Private networking and role checks: NOT_CHECKED
Health and paused-access checks: NOT_CHECKED
Google/OIDC and client checks: NOT_CHECKED
Outstanding work: EXAMPLE_NEXT_STEP
```

Do not replace the dummy values in the public version with a real environment's identifiers, test results or approval history. Review staged files before publishing; ignore rules do not remove previously tracked files or history.
