/**
 * Schema Validator — validates records and candidates at pipeline boundaries.
 *
 * Catches malformed source data early (normalize boundary) and flags
 * internal bugs in candidate output (log-only, don't filter).
 *
 * Why validate at normalize(): That's the boundary where external data enters.
 * Everything after is produced by our deterministic code. Catching garbage at
 * entry prevents nonsensical clusters and scores.
 *
 * Why log-only for candidates: Invalid candidates mean our code has a bug.
 * We want visibility but shouldn't silently drop our own output.
 */

const VALID_SOURCE_TYPES = new Set([
  'wire', 'mainstream', 'domain', 'social_verified', 'social_raw', 'weak',
]);

const VALID_SEVERITIES = new Set(['routine', 'notable', 'urgent']);

/**
 * Validate a single CanonicalRecord.
 *
 * Checks required fields and types at the boundary where external
 * data enters the pipeline. Early-return on first failure.
 *
 * @param {Object} record
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
export function validateRecord(record) {
  if (!record || typeof record !== 'object') {
    return { valid: false, reason: 'record is not an object' };
  }
  if (typeof record.id !== 'string' || record.id.length === 0) {
    return { valid: false, reason: 'missing field id' };
  }
  if (typeof record.sourceId !== 'string' || record.sourceId.length === 0) {
    return { valid: false, reason: 'missing field sourceId' };
  }
  if (!VALID_SOURCE_TYPES.has(record.sourceType)) {
    return { valid: false, reason: `invalid sourceType "${record.sourceType}"` };
  }
  if (typeof record.text !== 'string' || record.text.length < 5) {
    return { valid: false, reason: 'text missing or too short (< 5 chars)' };
  }
  if (!Array.isArray(record.entities)) {
    return { valid: false, reason: 'missing field entities' };
  }
  if (isNaN(new Date(record.timestamp).getTime())) {
    return { valid: false, reason: 'timestamp not parseable as Date' };
  }
  if (!record.meta || typeof record.meta !== 'object' || Array.isArray(record.meta)) {
    return { valid: false, reason: 'meta must be a non-null object' };
  }
  return { valid: true };
}

/**
 * Validate a single EventCandidate.
 *
 * Used log-only after promote() — invalid candidates mean our
 * code has a bug, not bad input data.
 *
 * @param {Object} candidate
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
export function validateCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return { valid: false, reason: 'candidate is not an object' };
  }
  if (typeof candidate.clusterId !== 'string' || candidate.clusterId.length === 0) {
    return { valid: false, reason: 'missing field clusterId' };
  }
  if (!Array.isArray(candidate.entities) || candidate.entities.length === 0) {
    return { valid: false, reason: 'entities must be a non-empty array' };
  }
  if (!candidate.entities.every(e => typeof e === 'string')) {
    return { valid: false, reason: 'entities must contain only strings' };
  }
  if (!Array.isArray(candidate.records) || candidate.records.length === 0) {
    return { valid: false, reason: 'records must be a non-empty array' };
  }
  if (typeof candidate.confidence !== 'number' || candidate.confidence < 0 || candidate.confidence > 100) {
    return { valid: false, reason: 'confidence must be a number 0-100' };
  }
  if (!VALID_SEVERITIES.has(candidate.severity)) {
    return { valid: false, reason: `invalid severity "${candidate.severity}"` };
  }
  return { valid: true };
}

/**
 * Filter an array of records, returning valid ones and dropped with reasons.
 *
 * Logs dropped count via console.warn for observability.
 *
 * @param {Object[]} records
 * @returns {{ valid: Object[], dropped: Array<{ record: Object, reason: string }> }}
 */
export function filterValidRecords(records) {
  const valid = [];
  const dropped = [];

  for (const record of records) {
    const check = validateRecord(record);
    if (check.valid) {
      valid.push(record);
    } else {
      dropped.push({ record, reason: check.reason });
    }
  }

  return { valid, dropped };
}
