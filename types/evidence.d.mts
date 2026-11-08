import type { AuditCheckpoint, EvidenceEnvelope, JsonValue, VerifiedAuditExtension, VerifiedEvidence, VerifiedReceiptInAudit } from './contracts.mjs';

export type { AuditCheckpoint, AuditEvent, AuditPayload, EvidenceEnvelope, EvidenceHead, EvidencePayload, ReceiptPayload, VerifiedAuditExtension, VerifiedEvidence, VerifiedReceiptInAudit } from './contracts.mjs';

export function canonical(value: JsonValue, depth?: number): string;
export function digest(value: JsonValue): string;
/** SHA-256 of the Ed25519 public key's SPKI DER encoding. */
export function fingerprint(publicKey: string): string;
export function signedEnvelope<Payload extends JsonValue>(payload: Payload, privateKey: string, publicKey: string): EvidenceEnvelope<Payload>;
/** Verify untrusted evidence against a fingerprint obtained independently of it. */
export function verifyEvidence(envelope: unknown, trustedFingerprint: string): VerifiedEvidence;
/** Derive a checkpoint from verified audit evidence and retain it under the verifier's control. */
export function createAuditCheckpoint(envelope: unknown, trustedFingerprint: string): AuditCheckpoint;
/** Reject rollback and forks against an independently retained checkpoint. */
export function verifyAuditExtension(audit: unknown, trustedFingerprint: string, checkpoint: unknown): VerifiedAuditExtension;
/** Confirm a receipt's terminal event exists in the signed audit. */
export function verifyReceiptInAudit(receipt: unknown, audit: unknown, trustedFingerprint: string, checkpoint?: unknown): VerifiedReceiptInAudit;
