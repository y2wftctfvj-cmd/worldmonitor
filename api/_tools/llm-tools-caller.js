/**
 * LLM Tool Caller — handles multi-turn LLM calls with tool-calling support.
 *
 * Wraps callLLMRaw with a loop that processes tool calls and feeds results
 * back to the LLM, up to a configurable maximum number of rounds.
 */

import { TOOL_DEFINITIONS, runTool } from './monitor-tools.js';

const MAX_TOOL_CALLS_PER_TURN = 3;

/**
 * Call the LLM with tool-calling support.
 * Handles up to MAX_TOOL_CALLS_PER_TURN tool call rounds.
 *
 * @param {Array} messages - Chat messages array
 * @param {string} openRouterKey - OpenRouter API key
 * @param {string} groqKey - Groq API key
 * @param {Function} callLLMRaw - Raw LLM call function
 * @returns {Promise<string>} Final text reply from the LLM
 */
export async function callLLMWithTools(messages, openRouterKey, groqKey, callLLMRaw) {
  let currentMessages = [...messages];
  let toolCallsUsed = 0;

  while (toolCallsUsed < MAX_TOOL_CALLS_PER_TURN) {
    const response = await callLLMRaw(currentMessages, openRouterKey, groqKey, true);
    const choice = response?.choices?.[0];

    if (!choice) throw new Error('LLM returned no choices');

    const assistantMessage = choice.message;

    // If there are tool calls, process them
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      // Add the assistant's message (with tool_calls) to the conversation
      currentMessages = [...currentMessages, assistantMessage];

      // Process each tool call
      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function?.name;
        let toolArgs = {};
        try {
          toolArgs = JSON.parse(toolCall.function?.arguments || '{}');
        } catch {
          toolArgs = {};
        }

        console.log(`[llm-tools-caller] Tool call: ${toolName}(${JSON.stringify(toolArgs)})`);
        let toolResult;
        try {
          toolResult = await runTool(toolName, toolArgs);
        } catch (toolErr) {
          console.error(`[llm-tools-caller] Tool ${toolName} failed:`, toolErr.message || toolErr);
          toolResult = `Tool "${toolName}" failed: ${toolErr.message || 'unknown error'}. Try a different approach.`;
        }

        // Add the tool result
        currentMessages = [...currentMessages, {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult,
        }];
      }

      toolCallsUsed++;
      continue;
    }

    // No tool calls — return the text reply
    const reply = assistantMessage.content;
    if (!reply) throw new Error('LLM returned no content');
    return reply;
  }

  // Hit tool call limit — do one final call without tools
  const finalResponse = await callLLMRaw(currentMessages, openRouterKey, groqKey, false);
  const reply = finalResponse?.choices?.[0]?.message?.content;
  if (!reply) throw new Error('LLM returned no content after tool calls');
  return reply;
}
