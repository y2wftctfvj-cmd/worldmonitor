/**
 * Fusion Schemas — data shape definitions for the evidence fusion pipeline.
 *
 * JSDoc typedefs only, no runtime cost. These types document the data
 * structures flowing through normalize -> cluster -> score -> promote.
 */

/**
 * A single normalized record from any data source.
 *
 * @typedef {Object} CanonicalRecord
 * @property {string} id - Unique ID: "sourceId:hash" (e.g., "telegram:intelslava:a3f8c1")
 * @property {string} sourceId - Source identifier (e.g., "telegram:intelslava", "headlines", "markets")
 * @property {string} sourceType - Reliability tier key from source-reliability.js (e.g., "wire", "social_verified")
 * @property {string} text - Normalized text content
 * @property {string[]} entities - Extracted entity names (canonical form)
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {Object} meta - Source-specific metadata (score, channel, magnitude, etc.)
 */

/**
 * A cluster of related records grouped by shared entities.
 *
 * @typedef {Object} EventCandidate
 * @property {string} clusterId - Hash of sorted entity set (e.g., "Iran+Nuclear")
 * @property {string[]} entities - Shared entities that define this cluster
 * @property {CanonicalRecord[]} records - All records belonging to this cluster
 * @property {number} confidence - Additive confidence score (0-100)
 * @property {Object} scoreBreakdown - Detailed score components
 * @property {number} scoreBreakdown.reliability - Best source reliability (0-40)
 * @property {number} scoreBreakdown.corroboration - Multi-source agreement (0-25)
 * @property {number} scoreBreakdown.recency - How recent the data is (0-15)
 * @property {number} scoreBreakdown.crossDomain - Source type diversity (0-15)
 * @property {number} scoreBreakdown.novelty - Bonus for records not seen last cycle (0-10)
 * @property {number} scoreBreakdown.contradiction - Penalty for opposing signals (0-25)
 * @property {string} severity - "routine" | "notable" | "urgent" (set by promotion rules)
 * @property {string|null} watchlistMatch - Matched watchlist term, or null
 */

// No runtime exports — this file exists purely for documentation
export {};
