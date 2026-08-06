import { monotonicFactory } from "ulid";

import {
  CandidateIdSchema,
  EventIdSchema,
  EvidenceIdSchema,
  JobIdSchema,
  KnowledgeIdSchema,
  ObservationIdSchema,
  ReceiptIdSchema,
  SnapshotIdSchema,
  TransactionIdSchema,
} from "./domain-schemas.js";

const nextUlid = monotonicFactory();

export const DOMAIN_ID_PREFIXES = {
  candidate: "cand",
  event: "evt",
  evidence: "ev",
  job: "job",
  knowledge: "kn",
  observation: "obs",
  receipt: "rcpt",
  snapshot: "snap",
  transaction: "txn",
} as const;

export type DomainIdKind = keyof typeof DOMAIN_ID_PREFIXES;

const DOMAIN_ID_SCHEMAS = {
  candidate: CandidateIdSchema,
  event: EventIdSchema,
  evidence: EvidenceIdSchema,
  job: JobIdSchema,
  knowledge: KnowledgeIdSchema,
  observation: ObservationIdSchema,
  receipt: ReceiptIdSchema,
  snapshot: SnapshotIdSchema,
  transaction: TransactionIdSchema,
} as const;

/** Creates a collision-resistant, lexically sortable ID for a domain entity. */
export function createDomainId(
  kind: DomainIdKind,
  timestamp = Date.now(),
): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError("timestamp must be a non-negative safe integer");
  }

  const id = `${DOMAIN_ID_PREFIXES[kind]}_${nextUlid(timestamp)}`;
  return DOMAIN_ID_SCHEMAS[kind].parse(id);
}
