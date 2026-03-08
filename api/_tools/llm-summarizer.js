/**
 * LLM Summarizer — writes intelligence analysis for pre-scored fusion candidates.
 *
 * Extracted from monitor-check.js to keep file sizes manageable.
 * The LLM writes analysis + watch_next for each candidate.
 * It does NOT set severity or confidence — those come from the fusion engine.
 */

import { callLLM } from './llm-provider.js';
import { formatSourceName } from './alert-sender.js';

/**
 * Build analysis context section for the LLM prompt.
 * Contains anomalies, convergences, and historical context from deterministic analysis.
 */
export function buildAnalysisSection(analysisResults) {
  const sections = [];

  if (analysisResults.anomalies?.length > 0) {
    const lines = analysisResults.anomalies.map(a =>
      `- ${a.displayName}: ${a.ratio}x above baseline (${a.currentSources} sources, normally ${a.baselineDaily}/day)`
    );
    sections.push(`ANOMALIES DETECTED:\n${lines.join('\n')}`);
  }

  if (analysisResults.convergences?.length > 0) {
    const lines = analysisResults.convergences.map(c =>
      `- ${c.displayName}: signals from ${c.domains.join(' + ')} (${c.domainCount} domains)`
    );
    sections.push(`CROSS-DOMAIN CONVERGENCE:\n${lines.join('\n')}`);
  }

  if (analysisResults.escalations?.length > 0) {
    const lines = analysisResults.escalations.map(e =>
      `- ${e.displayName}: severity rising (delta +${e.severityDelta}), ${e.escalationsThisMonth} notable+ events this month`
    );
    sections.push(`ESCALATION DETECTED:\n${lines.join('\n')}`);
  }

  if (analysisResults.historicalContext?.length > 0) {
    sections.push(`HISTORICAL CONTEXT:\n${analysisResults.historicalContext.map(l => `- ${l}`).join('\n')}`);
  }

  return sections.length > 0 ? '\n' + sections.join('\n\n') : '';
}

/**
 * Summarize pre-scored fusion candidates using LLM.
 *
 * @param {Array} promotedCandidates - Candidates to summarize
 * @param {Array} developingItems - Developing items from previous cycles
 * @param {string} openRouterKey - OpenRouter API key
 * @param {string} groqKey - Groq API key
 * @param {Object} analysisResults - Deterministic analysis results
 * @param {Function} buildStructuredFinding - Function to build structured findings
 * @param {number} maxTokens - Max LLM response tokens
 * @returns {Promise<{findings: Array|null, provider?: string, errors?: Array}>}
 */
export async function summarizeCandidates(promotedCandidates, developingItems, openRouterKey, groqKey, analysisResults, buildStructuredFinding, maxTokens = 1800) {
  const developingSection = developingItems.length > 0
    ? `\nDEVELOPING ITEMS FROM PREVIOUS CYCLES:\n${developingItems.map(d => `- "${d.topic}" (${d.count} consecutive cycles)`).join('\n')}`
    : '';

  // Build analysis context from deterministic intel analysis
  const analysisSection = buildAnalysisSection(analysisResults || {});

  // Build compact candidate summaries for the LLM
  const candidateSummaries = promotedCandidates.map((c, i) => {
    const sources = [...new Set(c.records.map(r => formatSourceName(r.sourceId)))];
    const sampleTexts = c.records.slice(0, 5).map(r => {
      const timeLabel = r.timestamp ? new Date(r.timestamp).toISOString().slice(11, 16) + ' UTC' : '';
      return `  - [${formatSourceName(r.sourceId)}] ${timeLabel ? `[${timeLabel}] ` : ''}${r.text.substring(0, 350)}`;
    }).join('\n');
    // Build MCP enrichment context lines
    const mcpLines = [];
    if (c.mcp?.sanctionsMatch) mcpLines.push('OFAC SANCTIONS MATCH: Entity appears on US Treasury SDN list');
    if (c.mcp?.marketProbability != null) mcpLines.push(`PREDICTION MARKET: ${c.mcp.marketProbability}% probability`);
    if (c.mcp?.entityContext?.summary) mcpLines.push(`ENTITY CONTEXT: ${c.mcp.entityContext.description} — ${c.mcp.entityContext.summary.substring(0, 200)}`);
    const mcpSection = mcpLines.length > 0 ? `MCP intelligence:\n${mcpLines.map(l => `  - ${l}`).join('\n')}\n` : '';

    return `EVENT ${i + 1} (severity: ${c.severity}, confidence: ${c.confidence}, entities: ${c.entities.join(', ')}):
Sources: ${sources.join(', ')}
Score breakdown: reliability=${c.scoreBreakdown.reliability}, corroboration=${c.scoreBreakdown.corroboration}, recency=${c.scoreBreakdown.recency}, cross_domain=${c.scoreBreakdown.crossDomain}, novelty=${c.scoreBreakdown.novelty}, contradiction=${c.scoreBreakdown.contradiction}
${c.watchlistMatch ? `Watchlist match: "${c.watchlistMatch}"\n` : ''}${mcpSection}Sample records:
${sampleTexts}`;
  }).join('\n\n');

  const analysisPrompt = `You are writing intelligence alert briefs. Read the SOURCE RECORDS below and write:

1. A single-sentence FACT LINE — concrete, factual, and anchored in the strongest reporting
2. A 3-5 sentence analysis: SITUATION (cite facts from records) -> ASSESSMENT (meaning) -> IMPLICATIONS (consequences)
3. A single-sentence WHY IT MATTERS summary
4. A single-sentence UNCERTAINTY line — what is not confirmed yet
5. 2-3 specific, measurable indicators to watch next

PRE-SCORED EVENTS WITH SOURCE RECORDS:
${candidateSummaries}
${developingSection}

ADDITIONAL CONTEXT (reference in assessment section, NEVER use in titles):
${analysisSection || 'No anomaly or escalation data available.'}

OUTPUT FORMAT (respond ONLY with valid JSON, no markdown code fences):
{
  "findings": [
    {
      "fact_line": "Single factual sentence anchored in the source records.",
      "analysis": "SITUATION: [what happened, cite sources]. ASSESSMENT: [what this means]. IMPLICATIONS: [consequences].",
      "why_matters": "Short sentence on why this matters now.",
      "uncertainty": "Short sentence on what remains unconfirmed.",
      "watch_next": ["specific measurable indicator", "concrete trigger to monitor"]
    }
  ]
}

OTHER RULES:
- Output exactly ${promotedCandidates.length} findings, one per event, in the same order.
- Reference specific details from source records — names, numbers, locations, times.
- Telegram-only claims should note "UNVERIFIED" in analysis.
- FACT LINE must be a plain factual sentence, not analysis or speculation.
- UNCERTAINTY must describe what is still unknown, not repeat the confirmed facts.
- watch_next must be specific. BAD: "further developments". GOOD: "IAEA Board emergency session".
- Never use: "situation developing", "remains to be seen", "could potentially escalate", "bears watching".`;

  const messages = [
    { role: 'system', content: `You are Monitor, a senior intelligence analyst writing alerts for a geopolitical dashboard.

Your job: turn raw multi-source intelligence into concise, actionable analysis.

Writing style:
- Lead with specific facts, not vague summaries
- Name specific actors, locations, numbers, dates from the source data
- Structure: WHAT is happening -> WHY it matters -> SO WHAT (implications)
- If sources disagree or only one domain reports, say so explicitly
- Include one line on what remains unknown
- Never use filler: "situation developing", "remains to be seen", "could escalate"

Output ONLY valid JSON. No markdown fences.` },
    { role: 'user', content: analysisPrompt },
  ];

  try {
    const result = await callLLM({
      messages,
      maxTokens,
      temperature: 0.2,
      json: true,
      groqKey,
      openRouterKey,
    });

    const parsed = result.parsed;
    if (!parsed) throw new Error('LLM returned non-JSON content');

    // Merge LLM output back into fusion candidates
    const mergedFindings = promotedCandidates.map((candidate, i) => {
      const llmFinding = parsed.findings?.[i] || {};
      return buildStructuredFinding(candidate, llmFinding, analysisResults);
    });

    // Log first finding for quality verification
    if (mergedFindings.length > 0) {
      const sample = mergedFindings[0];
      console.log(`[llm-summarizer] Sample finding: "${sample.title}" | fact: ${(sample.fact_line || '').substring(0, 160)} | uncertainty: ${(sample.uncertainty || '').substring(0, 120)} | watch_next: ${JSON.stringify(sample.watch_next)}`);
    }
    console.log(`[llm-summarizer] ${result.provider} summarized ${mergedFindings.length} candidates`);
    return { findings: mergedFindings, provider: result.provider };
  } catch (err) {
    const errors = err.providerErrors || [`${(err.message || String(err)).substring(0, 200)}`];
    console.error('[llm-summarizer] All LLM providers failed for summarization');
    return { findings: null, errors };
  }
}
