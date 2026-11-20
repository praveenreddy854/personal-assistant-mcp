# PostgreSQL as the primary memory store

Status: superseded on 2026-11-15 by [ADR 0004](0004-cosmos-serverless-memory-store.md) after the user chose Cosmos DB to avoid provisioned database compute. The text below records the original decision.

Use Azure Database for PostgreSQL Flexible Server, with a small generic relational core and extensible JSONB values, to represent the personal memory graph and its evidence, history, and form records. The agreed lifecycle benefits from relational queries, constraints, and transactions; Cosmos DB NoSQL would require application-managed cross-document traversal, despite its useful consumption billing and native hybrid search. Accept provisioned database capacity, connection-pool management, and application or SQL logic for combining keyword and vector rankings; Azure Functions remains the MCP host.
