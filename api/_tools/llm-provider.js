/**
 * Shared LLM provider with cascade fallback.
 *
 * Consolidates LLM calling logic used by both monitor-check.js and telegram-webhook.js.
 * Provider cascade: Groq 70B → Groq 8B → OpenRouter Llama 70B.
 *
 * Usage:
 *   const result = await callLLM({ messages, maxTokens: 1800, temperature: 0.2 });
 *   // result = { content, provider, parsed? }
 */

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Call an LLM with automatic provider cascade.
 *
 * @param {Object} options
 * @param {Array} options.messages - Chat messages array
 * @param {number} [options.maxTokens=1800] - Max response tokens
 * @param {number} [options.temperature=0.2] - Sampling temperature
 * @param {boolean} [options.json=false] - Request JSON response format
 * @param {number} [options.timeoutMs=15000] - Timeout per provider attempt
 * @param {string} [options.groqKey] - Groq API key (env fallback: GROQ_API_KEY)
 * @param {string} [options.openRouterKey] - OpenRouter API key (env fallback: OPENROUTER_API_KEY)
 * @param {Array} [options.tools] - Tool definitions for tool-calling providers
 * @param {boolean} [options.rawResponse=false] - Return full API response instead of content string
 * @returns {Promise<{content: string, provider: string, parsed?: Object}>}
 */
export async function callLLM({
  messages,
  maxTokens = 1800,
  temperature = 0.2,
  json = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  groqKey,
  openRouterKey,
  tools,
  rawResponse = false,
}) {
  const gKey = groqKey || process.env.GROQ_API_KEY || '';
  const orKey = openRouterKey || process.env.OPENROUTER_API_KEY || '';

  // Build provider cascade
  const providers = [];

  if (gKey) {
    providers.push({
      name: 'Groq-70B',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.3-70b-versatile',
      apiKey: gKey,
      supportsTools: false,
    });
    providers.push({
      name: 'Groq-8B',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-8b-instant',
      apiKey: gKey,
      supportsTools: false,
    });
  }

  if (orKey) {
    providers.push({
      name: 'Llama-OpenRouter',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'meta-llama/llama-3.3-70b-instruct',
      apiKey: orKey,
      supportsTools: true,
    });
  }

  if (providers.length === 0) {
    throw new Error('No LLM provider configured (need GROQ_API_KEY or OPENROUTER_API_KEY)');
  }

  const errors = [];

  for (const provider of providers) {
    try {
      const body = {
        model: provider.model,
        messages,
        temperature,
        max_tokens: maxTokens,
      };

      if (json) {
        body.response_format = { type: 'json_object' };
      }

      // Only include tools for providers that support them
      if (tools && provider.supportsTools) {
        body.tools = tools;
      }

      const fetchStart = Date.now();
      const resp = await fetch(provider.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const elapsed = Date.now() - fetchStart;
      console.log(`[llm-provider] ${provider.name} responded in ${elapsed}ms (status: ${resp.status})`);

      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`${provider.name} returned ${resp.status}: ${errBody.substring(0, 300)}`);
      }

      const data = await resp.json();

      if (rawResponse) {
        return { data, provider: provider.name };
      }

      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error(`${provider.name} returned no content`);

      // Optionally parse JSON response
      const result = { content, provider: provider.name };
      if (json) {
        try {
          result.parsed = JSON.parse(content);
        } catch {
          // Content wasn't valid JSON — caller can handle raw content
        }
      }

      return result;
    } catch (err) {
      const errMsg = `${provider.name}: ${(err.message || String(err)).substring(0, 200)}`;
      console.error(`[llm-provider] ${errMsg}`);
      errors.push(errMsg);
    }
  }

  const error = new Error('All LLM providers failed');
  error.providerErrors = errors;
  throw error;
}
