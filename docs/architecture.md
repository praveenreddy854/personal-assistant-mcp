# Agreed architecture

The interview decisions are implemented in the first version. The user ended the interview and authorized reasonable defaults for remaining choices. See [implementation details](implementation.md), [deployment](deployment.md), and [restore](restore.md).

## Ownership and access

- One private Memory Vault per owner; describing relatives or other people grants them no access.
- The pilot serves the owner and invited testers using Google sign-in.
- Every connected agent reaches the same owner vault through its verified identity. Agent accounts and memory identities are distinct.
- Authorized agents share ordinary recall, new-memory and form-capture access. Edits and deletion require scoped chat approval.
- A fully specified direct user edit/delete instruction counts as approval. Inferred or broader effects require a preview and an additional confirmation. The service trusts the authorized client to relay that decision faithfully.

## Knowledge and time

- The service performs interpretation and retrieval reasoning using its own Azure-hosted models.
- Store only source-supported assertions; model guesses do not become facts. Calculations may be returned with their basis without being persisted.
- Organize arbitrary entities, attributes, relationships, and events in a generic graph with extensible JSON values. Family/health/work are useful views, not rigid storage trees.
- Preserve original evidence and the distinction between effective time and recorded time.
- Corrections preserve mistaken versions for explicit revision-history questions and exclude them from ordinary answers.
- Genuine changes retain prior periods as history and establish a separate new assertion.
- Return evidence-backed answers with exact claims, dates, uncertainty, conflicts, and gaps.

## Memory levels

- L0: compact life overview.
- L1: relevant domain context, such as active allergies and recent sleep patterns.
- L2: precise reusable records, source evidence, and history, including facts needed for forms.
- Levels are views over the same underlying knowledge. Validity, recency, and retention are independent; appearing in L1 does not expire an allergy.
- Exact form answers use L2 evidence, not a summary alone.

## Form capture

- Include an MCP service and companion browser integration to capture manual as well as agent-entered edits in an explicitly paired Form Session.
- Persist drafts and field revisions immediately. Preserve arbitrary and application-specific answers in their form context.
- The owner's indication that answers are final triggers one finalization operation, independent of successful website submission.
- Obtain a fresh snapshot and promote supported facts at finalization. Existing-fact changes remain subject to approval; draft revisions do not require per-field prompts.
- Preserve who a field describes and what it means; desired salary is not current earnings, and a contact's details are not automatically the owner's.
- Known copied values retain original provenance and do not automatically become fresh measurements.

## Forgetting

- Forget means removal, including corrected versions, known supporting representations, and derived search records.
- Preserve unrelated claims and redact mixed-source evidence honestly.
- Invalidate pending plans and old/in-flight write requests so retries cannot restore forgotten information.
- Remove identified captured fields and block their stale queued events. Whole-form deletion also handles unclassified draft entries.
- Retain content-free deletion receipts and replay them before serving restored data. Backups expire under their configured retention policy; offline browser queues purge at their next successful sync.

## Selected platform and implementation defaults

- Azure Cosmos DB for NoSQL serverless is the primary store; Azure Functions hosts the MCP server. This supersedes the earlier PostgreSQL choice at the user’s request. [Current database decision](adr/0004-cosmos-serverless-memory-store.md)
- Use generic JSON documents partitioned by vault, native vector queries, indexed keyword tokens, and bounded graph traversal. [Temporal graph decision](adr/0002-evidence-backed-temporal-graph.md)
- Use TypeScript/Node.js 22 and the official SDK with stateless Streamable HTTP.
- Use Google federation through a managed issuer; the deployment guide defaults to Entra External ID and pre-registered OAuth clients.
- Target GitHub Copilot in VS Code, ChatGPT remote MCP, and Claude remote connectors. Microsoft 365 Copilot is outside the initial scope. Signed-in product compatibility is a deployment check, not implied by passing SDK tests.
- Start with Chromium HTML-form capture: standard controls, open shadow roots, and same-origin frames. Capture coverage and offline limits are specified in the README.
- Azure-hosted model deployments perform extraction, embeddings, and answer generation. Actual deployments, quota, cost, and model quality require target-environment configuration.
- The infrastructure defaults to centralus, single-region Cosmos serverless with Strong consistency, and seven-day continuous backups. These are deployment defaults, not a claim that every model call stays in that exact region or that a particular production capacity is sufficient.
- Chat-mediated approval is a deliberate client-trust boundary. [Approval decision](adr/0003-chat-mediated-approval.md)
