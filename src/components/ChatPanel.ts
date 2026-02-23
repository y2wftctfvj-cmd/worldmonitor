/**
 * Chat Panel — slide-out intelligence analyst for querying dashboard data.
 *
 * How it works:
 *   1. User opens chat via a button in the header
 *   2. Types a question about current events / dashboard data
 *   3. We gather context from visible panels (headlines, signals, alerts)
 *   4. Send question + context + conversation history to /api/chat (multi-turn)
 *   5. Display the AI response in the chat
 *
 * Primary: POST /api/chat  (server-side LLM via Groq / OpenRouter)
 * Fallback: browser-side ML worker (Transformers.js T5) if API is unreachable.
 */

import { mlWorker } from '@/services/ml-worker';

// -- Types ------------------------------------------------------------------

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

// -- Component --------------------------------------------------------------

export class ChatPanel {
  private isOpen = false;
  private panelEl: HTMLElement | null = null;
  private messages: ChatMessage[] = [];
  private isLoading = false;
  /** Callback to gather current dashboard context (headlines, signals, etc.) */
  private contextGetter: (() => string) | null = null;

  /**
   * Provide a function that returns the current dashboard context as text.
   * Called each time the user sends a message.
   */
  setContextGetter(fn: () => string): void {
    this.contextGetter = fn;
  }

  /**
   * Mount the chat button and slide-out panel into the DOM.
   */
  mount(headerRight: HTMLElement): void {
    // Create chat toggle button
    const chatBtn = document.createElement('button');
    chatBtn.className = 'chat-toggle-btn';
    chatBtn.title = 'Chat with AI';
    chatBtn.textContent = '💬';
    // Insert before settings
    const settingsBtn = headerRight.querySelector('.settings-btn');
    if (settingsBtn) {
      headerRight.insertBefore(chatBtn, settingsBtn);
    } else {
      headerRight.appendChild(chatBtn);
    }

    // Create slide-out panel
    this.panelEl = document.createElement('div');
    this.panelEl.className = 'chat-panel';
    this.buildPanelStructure();
    document.body.appendChild(this.panelEl);

    // Toggle on click
    chatBtn.addEventListener('click', () => this.toggle());

    // Close button inside panel
    this.panelEl.querySelector('.chat-close-btn')?.addEventListener('click', () => this.close());

    // Send on Enter or button click
    const input = this.panelEl.querySelector('.chat-input') as HTMLInputElement;
    const sendBtn = this.panelEl.querySelector('.chat-send-btn') as HTMLButtonElement;

    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage(input.value);
        input.value = '';
      }
    });

    sendBtn?.addEventListener('click', () => {
      if (input) {
        this.sendMessage(input.value);
        input.value = '';
      }
    });
  }

  // -- Private: DOM ----------------------------------------------------------

  private buildPanelStructure(): void {
    if (!this.panelEl) return;

    // Header
    const header = document.createElement('div');
    header.className = 'chat-panel-header';

    const title = document.createElement('span');
    title.className = 'chat-panel-title';
    title.textContent = 'Monitor';
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'chat-close-btn';
    closeBtn.textContent = '×';
    header.appendChild(closeBtn);

    this.panelEl.appendChild(header);

    // Messages container
    const messagesContainer = document.createElement('div');
    messagesContainer.className = 'chat-messages';
    messagesContainer.id = 'chatMessages';

    // Welcome message
    const welcome = document.createElement('div');
    welcome.className = 'chat-message assistant';
    welcome.textContent = 'I\'m Monitor, your intelligence analyst. Ask me about any region, threat, market move, or pattern on the dashboard.';
    messagesContainer.appendChild(welcome);

    this.panelEl.appendChild(messagesContainer);

    // Input area
    const inputArea = document.createElement('div');
    inputArea.className = 'chat-input-area';

    const input = document.createElement('input');
    input.className = 'chat-input';
    input.type = 'text';
    input.placeholder = 'Ask Monitor anything...';
    inputArea.appendChild(input);

    const sendBtn = document.createElement('button');
    sendBtn.className = 'chat-send-btn';
    sendBtn.textContent = '→';
    inputArea.appendChild(sendBtn);

    this.panelEl.appendChild(inputArea);
  }

  private toggle(): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  private open(): void {
    this.isOpen = true;
    this.panelEl?.classList.add('open');
    // Focus the input
    const input = this.panelEl?.querySelector('.chat-input') as HTMLInputElement;
    input?.focus();
  }

  private close(): void {
    this.isOpen = false;
    this.panelEl?.classList.remove('open');
  }

  private async sendMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.isLoading) return;

    // Add user message
    this.messages.push({ role: 'user', content: trimmed, timestamp: Date.now() });
    this.appendMessageToDOM('user', trimmed);

    // Show loading indicator
    this.isLoading = true;
    const loadingEl = this.appendMessageToDOM('assistant', 'Thinking...');
    loadingEl.classList.add('loading');

    try {
      // Gather dashboard context from visible panels
      const context = this.contextGetter?.() ?? '';

      // Build conversation history (last 10 messages) for multi-turn context
      const history = this.messages.slice(-10).map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      let response = '';

      // Primary path: call the server-side /api/chat endpoint
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: trimmed, context, history }),
        });

        if (!res.ok) {
          throw new Error(`API returned ${res.status}`);
        }

        const data = await res.json();
        response = data.reply;
      } catch (apiError) {
        // Fallback: browser-side ML worker (Transformers.js T5)
        console.warn('Chat API unavailable, falling back to ML worker:', apiError);

        const prompt = context
          ? `Dashboard context:\n${context}\n\nUser question: ${trimmed}\n\nAnswer concisely based on the dashboard data above.`
          : trimmed;

        if (mlWorker.isAvailable) {
          const results = await mlWorker.summarize([prompt]);
          response = results[0] || 'I could not generate a response. Try rephrasing your question.';
        } else {
          response = 'Monitor is temporarily unavailable. Please try again in a few seconds.';
        }
      }

      // Replace loading indicator with actual response
      loadingEl.textContent = response;
      loadingEl.classList.remove('loading');
      this.messages.push({ role: 'assistant', content: response, timestamp: Date.now() });
    } catch (error) {
      loadingEl.textContent = 'Sorry, I encountered an error. Please try again.';
      loadingEl.classList.remove('loading');
    } finally {
      this.isLoading = false;
    }

    this.scrollToBottom();
  }

  private appendMessageToDOM(role: 'user' | 'assistant', content: string): HTMLElement {
    const container = document.getElementById('chatMessages');
    if (!container) throw new Error('Chat messages container not found');

    const msg = document.createElement('div');
    msg.className = `chat-message ${role}`;
    msg.textContent = content; // safe: textContent escapes
    container.appendChild(msg);
    this.scrollToBottom();
    return msg;
  }

  private scrollToBottom(): void {
    const container = document.getElementById('chatMessages');
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }
}
