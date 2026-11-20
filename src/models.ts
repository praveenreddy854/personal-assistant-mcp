import { z } from 'zod';

export type Actor = { issuer: string; subject: string; clientId: string };
export const ContextSchema = z.object({
  occurred_at: z.iso.datetime({ offset: true }),
  timezone: z.string().refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }, 'Use an IANA timezone'),
  conversation_context: z.string().max(12000).default('')
});
export type Context = z.infer<typeof ContextSchema>;
export const EntityDraftSchema = z.object({
  ref: z.string().min(1).max(100), existing_id: z.uuid().nullable(),
  kind: z.string().min(1).max(80), name: z.string().min(1).max(200),
  aliases: z.array(z.string().max(200)).max(20)
});
export const ClaimDraftSchema = z.object({
  subject_ref: z.string(), predicate: z.string().min(1).max(120),
  object_ref: z.string().nullable(), value: z.json().nullable(),
  domain: z.string().min(1).max(80),
  valid_from: z.iso.date().nullable(), valid_to: z.iso.date().nullable(),
  modality: z.enum(['asserted', 'planned', 'uncertain', 'negated']),
  qualifiers: z.record(z.string(), z.json()),
  quote: z.string().min(1),
  value_quote: z.string().min(1),
  change: z.enum(['add', 'correction', 'transition', 'retraction']),
  replaces: z.array(z.uuid()).max(50)
});
export const ExtractionSchema = z.object({
  clarification: z.string().nullable(),
  entities: z.array(EntityDraftSchema).max(50),
  claims: z.array(ClaimDraftSchema).max(100)
});
export type Extraction = z.infer<typeof ExtractionSchema>;
export type ClaimDraft = z.infer<typeof ClaimDraftSchema>;
export const AnswerSchema = z.object({
  answer: z.string(), used_claim_ids: z.array(z.uuid()),
  missing_information: z.array(z.string()), conflicts: z.array(z.string())
});
export type Answer = z.infer<typeof AnswerSchema>;
export type Entity = { id: string; kind: string; name: string; aliases: string[]; is_self: boolean };
export type Claim = {
  id: string; subject_id: string; predicate: string; object_id: string | null;
  value: unknown; domain: string; valid_from: string | null; valid_to: string | null;
  modality: string; qualifiers: Record<string, unknown>; status: string;
  lineage_id: string; version: number; search_text: string;
  recorded_at: string; superseded_at: string | null;
};
export type Snapshot = { revision: number; entities: Entity[]; claims: Claim[]; truncated: boolean };
export type Evidence = { claim_id: string; source_id: string; quote: string; relation:string; kind: string; recorded_at: string; redacted: boolean };
export interface MemoryAI {
  extract(text: string, context: Context, snapshot: Snapshot): Promise<Extraction>;
  embed(text: string): Promise<number[]>;
  embedMany(texts: string[]): Promise<number[][]>;
  answer(question: string, level: number, records: unknown[]): Promise<Answer>;
}
export const FieldSchema = z.object({
  event_id: z.uuid(), device_id: z.uuid(), sequence: z.number().int().nonnegative(),
  field_key: z.string().regex(/^(?:[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,'Use an opaque UUID or SHA-256 field key, never a field value'), label: z.string().max(500),
  value: z.json(), input_type: z.string().max(80),
  observed_at: z.iso.datetime({ offset: true }),
  page_path: z.string().max(1000).default('/'),
  origin: z.enum(['user', 'programmatic', 'snapshot', 'agent']).default('snapshot')
});
export type Field = z.infer<typeof FieldSchema>;
export const CaptureSchema = z.object({ events: z.array(FieldSchema).min(1).max(100) });
export type SourceInput = { text: string; context: Context; kind: 'statement' | 'form'; form_session_id?: string; form_revision?: number; fields?: { key: string; label: string; value: unknown; start: number; end: number }[] };
export type PlannedClaim = ClaimDraft & { id: string; subject_id: string; object_id: string | null; targets: { id: string; version: number }[]; lineage_id: string; embedding: number[]; search_text: string };
export type Plan = { entities: Entity[]; claims: PlannedClaim[]; source: SourceInput };
