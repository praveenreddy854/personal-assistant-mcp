# Forgetting and restore

Active deletion and backup expiration are different operations. Cosmos continuous backups retain older content until their configured expiry. Browser devices that are offline purge affected queues on their next successful synchronization. Third-party forms and already-delivered agent conversations are not controlled by this service.

The server stores content-free deletion receipts with affected lineage, source, claim, session, field, and request identifiers. Opaque operation UUIDs are retained as tombstones so old retries cannot reintroduce forgotten information. A new, explicit user request can remember the information again with a new UUID.

## Maintain an independent receipt export

From a trusted administrative runner with database connectivity:

```sh
npm run export:deletions -- /secure-independent-location/memory-deletions.json
```

The file is written with owner-only permissions. Store it separately from the database backup being restored, under the same administrative access controls. Run the export after deletions and include it in the operational backup workflow; no external archive destination is provisioned automatically. Losing receipts newer than a backup prevents a safe assertion that all later deletions were reapplied.

## Restore without serving older personal data

1. Set the Function App’s `SERVING_ENABLED=false` and stop active capture before replacing the database.
2. Restore Cosmos using Azure’s supported point-in-time restore procedure. Restore both `vaults` and `identities` to a consistent point, and keep application access disabled. Reapply disabled public/key access, private endpoint/DNS, and data-plane role assignments; these network/security settings are not restored automatically.
3. Point a private administrative runner at the restored `COSMOS_ENDPOINT` using a separate Entra principal. Run `npm run db:initialize` to verify partition/vector policies and Strong consistency. Update the Function endpoint only while serving remains disabled.
4. Replay an independent receipt export covering all deletions after the restored point:

   ```sh
   SERVING_ENABLED=false npm run restore:deletions -- /secure-independent-location/memory-deletions.json
   ```

   `export-deletions` also writes `<export>.grants.json`, the current family token grants. Keep it next to the receipt export. Replay deletes any restored family grant that isn't listed, so members removed after the backup stay removed. If family grants exist and that file is missing, replay stops; export again before enabling serving.

5. Verify affected claims, source values, draft revisions, proposal payloads and retry responses are gone. Check that unrelated vaults remain isolated.
6. Reconnect capture sessions with new pairing codes; restore replay invalidates restored capture secrets and pending proposals.
7. Re-enable `SERVING_ENABLED` only after the replay and checks succeed.

Replay uses the same scoped document operations and recoverable commit protocol as the service, including revoked vaults. It completes any restored pending journal before erasing the receipt’s scope; requests stay disabled for the entire replay. It repeats lineage deletion/redaction, removes identified form fields/sessions, restores request tombstones, and preserves the receipt. Synthetic integration tests restore pre-deletion documents and verify replay, including revoked-vault erasure and isolation from another vault. Reapplying a receipt is safe. An interrupted replay must be completed before enabling service.

## Scope limits

Fact deletion follows the selected correction lineages, tracked evidence spans, and identified fields. An unrelated paraphrase or an unclassified draft may require additional scope. `discard_form` explicitly removes a whole form and any claims that lose their only supporting evidence; independent sources remain. Always review the proposal’s actual scope. An agent may use a direct user instruction as approval only when it covers that scope exactly.
