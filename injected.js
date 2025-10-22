// Gmail Order Tracker Injected Script - Essential LLM Functions Only

(async () => {
  let aiSession = null;

  class GmailInjector {
    constructor() {
      this.init();
    }

    async init() {
      this.setupMessageHandlers();
      console.log('Gmail Order Tracker injected script loaded');
      console.log('LanguageModel available:', !!window.LanguageModel);
    }

    // Setup message handlers for LLM communication
    setupMessageHandlers() {
      window.addEventListener('message', async (event) => {
        if (event.source !== window) return;

        // Handle LLM extraction requests
        if (event.data.type === 'LLM_EXTRACT') {
          console.log('Injected script received LLM_EXTRACT request');
          const result = await this.handleLLMExtraction(event.data.prompt);
          console.log('Injected script LLM extraction result:', result);
          window.lastAIResponse = {
            action: 'LLM_EXTRACT',
            data: result
          };
        }
      });
    }

    // Initialize AI session
    async initAI() {
      try {
        if (!window.LanguageModel) {
          return {
            success: false,
            error: 'Chrome Prompt API not available. Please ensure you have Chrome 127+ with AI features enabled.'
          };
        }

        const availability = await window.LanguageModel.availability();

        if (availability === "available") {
          aiSession = await window.LanguageModel.create({
            initialPrompts: [
              {
                role: 'system',
                content: 'You are an AI assistant that helps with data extraction and analysis.'
              }
            ]
          });
          return { success: true, status: 'ready' };
        } else if (availability === "after-download") {
          return { success: false, status: 'AI model is downloading, please wait and try again...' };
        } else {
          return { success: false, status: `AI model not available: ${availability}` };
        }
      } catch (error) {
        console.error('AI initialization error:', error);
        return {
          success: false,
          error: `AI initialization failed: ${error.message}`
        };
      }
    }

    // Handle LLM extraction requests
    async handleLLMExtraction(prompt) {
      try {
        console.log('Injected script handleLLMExtraction called with prompt length:', prompt.length);

        if (!window.LanguageModel) {
          console.error('LanguageModel API not available');
          return {
            success: false,
            error: 'Chrome Prompt API not available. Please ensure you have Chrome 127+ with AI features enabled.'
          };
        }

        if (!aiSession) {
          console.log('AI session not initialized, initializing...');
          const initResult = await this.initAI();
          console.log('AI initialization result:', initResult);
          if (!initResult.success) {
            return {
              success: false,
              error: initResult.error || initResult.status || 'AI not available'
            };
          }
        }

        console.log('Sending prompt to AI session...');
        const result = await aiSession.prompt(prompt);
        console.log('AI session returned result successfully');

        return { success: true, result: result };
      } catch (error) {
        console.error('LLM extraction error:', error);
        return { success: false, error: error.message };
      }
    }
  }

  // Initialize the Gmail injector
  new GmailInjector();
})();