// Gmail Order Tracker Content Script - Essential Functions Only

// Message types constants (duplicated to avoid import issues in content script)
const MESSAGE_TYPES = {
  PROGRESS_UPDATE: 'PROGRESS_UPDATE',
  GET_SCANNING_STATE: 'GET_SCANNING_STATE',
  DESTROY_LLM_SESSION: 'DESTROY_LLM_SESSION',
  PROCESS_PACKAGE_EMAILS: 'PROCESS_PACKAGE_EMAILS',
  GET_UNPICKED_PACKAGES: 'GET_UNPICKED_PACKAGES',
  MARK_PACKAGE_PICKED_UP: 'MARK_PACKAGE_PICKED_UP',
  GET_SCAN_HISTORY: 'GET_SCAN_HISTORY',
  SCANNING_STATE_CHANGED: 'SCANNING_STATE_CHANGED',
  SCAN_SUBSCRIPTION_EMAILS: 'SCAN_SUBSCRIPTION_EMAILS',
  CLEANUP_SCAN_STATES: 'CLEANUP_SCAN_STATES'
};

// Package config constants (duplicated to avoid import issues in content script)
const PACKAGE_CONFIG = {
  DEFAULT_START_DATE: (() => {
    const date = new Date();
    date.setDate(date.getDate() - 7);
    return date.toISOString().split('T')[0];
  })(),
  DEFAULT_END_DATE: new Date().toISOString().split('T')[0],
  DEFAULT_SEARCH_KEYWORDS: [
    'delivered',
    'shipment delivered',
    'delivery confirmation',
    'package has arrived',
    'delivered to'
  ]
};

class GmailContentScript {
  /**
   * Safe wrapper for chrome.runtime.sendMessage with timeout and null checks
   */
  async sendMessageSafely(message, timeout = null) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      
      // Ensure response is a proper object with required properties
      if (!response) {
        return { success: false, error: 'No response from background script' };
      }
      
      // Ensure error property exists when success is false
      if (response.success === false && !response.error) {
        response.error = 'Unknown error occurred';
      }
      
      return response;
    } catch (error) {
      console.error('Message send error:', error);
      return { success: false, error: error.message || 'Communication error' };
    }
  }

  constructor() {
    this.isGmailActive = false;
    
    // Add cleanup on page unload
    window.addEventListener('beforeunload', () => {
      this.cleanup();
    });
    this.currentUrl = window.location.href;
    this.floatingWidget = null;
    this.isWidgetVisible = false;
    this.init();
  }

  async init() {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      await new Promise(resolve => {
        document.addEventListener('DOMContentLoaded', resolve);
      });
    }

    if (this.isGmailUrl(window.location.href)) {
      await this.waitForGmailReady();
    }

    this.detectGmailPage();
    this.setupBackgroundCommunication();

    // Always create the floating widget on any website
    this.createFloatingWidget();
    
    // Set up periodic scanning state check
    this.setupPeriodicStateCheck();
  }

  // Check if URL is a Gmail page
  isGmailUrl(url) {
    return url.includes('mail.google.com') || url.includes('gmail.com');
  }

  // Check if Gmail interface is loaded
  isGmailInterfaceLoaded() {
    const basicGmailIndicators = [
      '[role="main"]',
      '.nH',
      '.gb_A',
      '.T-I'
    ];

    const hasBasicStructure = basicGmailIndicators.some(selector =>
      document.querySelector(selector) !== null
    );

    if (hasBasicStructure) {
      return true;
    }

    if (this.isGmailUrl(window.location.href) && document.readyState === 'complete') {
      return true;
    }

    return false;
  }

  // Detect if we're on a Gmail page
  detectGmailPage() {
    const isGmail = this.isGmailUrl(window.location.href) && this.isGmailInterfaceLoaded();

    if (isGmail && !this.isGmailActive) {
      this.activateGmailScanner();
    } else if (!isGmail && this.isGmailActive) {
      this.deactivateGmailScanner();
    }
  }

  // Activate Gmail scanner when on Gmail
  activateGmailScanner() {
    this.isGmailActive = true;

    // Check if chrome.runtime is available before using it
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'GMAIL_STATE_CHANGE',
        active: true,
        url: window.location.href
      }).catch(() => {
        // Ignore errors if background service not ready
      });
    }
  }

  // Deactivate Gmail scanner when leaving Gmail
  deactivateGmailScanner() {
    this.isGmailActive = false;

    chrome.runtime.sendMessage({
      type: 'GMAIL_STATE_CHANGE',
      active: false,
      url: window.location.href
    }).catch(() => {
      // Ignore errors if background service not ready
    });
  }

  // Wait for Gmail to be fully loaded
  async waitForGmailReady(maxWaitTime = 10000) {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      if (this.isGmailInterfaceLoaded()) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return false;
  }

  // Setup communication with background service
  setupBackgroundCommunication() {
    chrome.runtime.onMessage.addListener(async (request, _sender, sendResponse) => {
      if (request.type === 'GET_GMAIL_STATE') {
        sendResponse({
          isActive: this.isGmailActive,
          url: this.currentUrl
        });
        return false;
      }

      if (request.action === 'getPageText') {
        const pageText = document.body.innerText.substring(0, 2000);
        sendResponse({ text: pageText });
        return false;
      }

      if (request.type === MESSAGE_TYPES.PROGRESS_UPDATE) {
        // Handle cleanup message
        if (request.data.scanType === 'cleanup' || request.data.step === 'cleanup') {
          console.log('Content: Received cleanup message - resetting all scan states');
          this.resetAllScanStates();
          return false;
        }
      }

      if (request.type === MESSAGE_TYPES.CLEANUP_SCAN_STATES) {
        console.log('Content: Received cleanup scan states message');
        this.resetAllScanStates();
        return false;
      }

      if (request.type === MESSAGE_TYPES.PROGRESS_UPDATE) {
        // Determine if this is a subscription or package scan
        const isSubscriptionScan = request.data.scanType === 'subscription' || 
          request.data.step === 'subscription_scan' || 
          (request.data.message && (
            request.data.message.includes('subscription') || 
            request.data.message.includes('Subscription')
          ));

        this.updateWidgetProgress(request.data);

        // Store progress state for persistence
        try {
          await this.storeProgressState(request.data, isSubscriptionScan);
        } catch (error) {
          console.error('Failed to store progress state:', error);
        }

        // Update toggle button with progress - only if any scan is active
        const isScanning = request.data.step !== 'complete' && request.data.step !== 'error';
        if (isScanning) {
          const scanType = isSubscriptionScan ? 'subscription' : 'package';
          this.updateToggleButtonScanning(true, request.data.progress, scanType);
        } else {
          // Check if other scan type is still active before resetting toggle
          this.checkOtherScanActive(isSubscriptionScan);
        }

        // If scanning is complete, reset UI for this scan type only
        if (request.data.step === 'complete' || request.data.step === 'error') {
          // Clear progress state
          try {
            await this.clearProgressState(isSubscriptionScan);
          } catch (error) {
            console.error('Failed to clear progress state:', error);
          }
          
          setTimeout(() => {
            if (isSubscriptionScan) {
              // Reset subscription UI
              const subscriptionBtn = this.floatingWidget?.querySelector('#widget-scanSubscriptionsBtn');
              if (subscriptionBtn) {
                subscriptionBtn.disabled = false;
                subscriptionBtn.textContent = '🔍 Scan Current Month Subscriptions';
              }
            } else {
              // Reset package UI
              const scanBtn = this.floatingWidget?.querySelector('#widget-scanBtn');
              if (scanBtn) {
                scanBtn.disabled = false;
                scanBtn.textContent = '🔍 Scan for Package Deliveries';
                if (request.data.step === 'complete') {
                  this.hideProgress();
                  this.loadUnpickedPackages();
                }
              }
            }
            // Check if other scan is still active before resetting toggle
            this.checkOtherScanActive(isSubscriptionScan);
          }, 2000); // Give user time to see the completion message
        }
        return false;
      }

      if (request.type === 'SCANNING_STATE_CHANGED') {
        const { isScanning, progress, message, step, scanType } = request.data;
        
        // Determine scan type and apply appropriate state
        const isSubscriptionScan = scanType === 'subscription' || 
          step === 'subscription_scan' || 
          (message && message.includes('subscription'));
        
        console.log('SCANNING_STATE_CHANGED - scanType:', scanType, 'step:', step, 'isSubscriptionScan:', isSubscriptionScan);
        
        // Update toggle button with scan type
        this.updateToggleButtonScanning(isScanning, progress, scanType);
        
        // Apply state to appropriate scan type only
        if (isSubscriptionScan) {
          this.applySubscriptionScanningState(isScanning, progress, message, step);
        } else {
          this.applyPackageScanningState(isScanning, progress, message, step);
        }
        
        if (!isScanning && step === 'complete') {
          this.loadUnpickedPackages();
        }
        return false;
      }

      if (request.type === 'SCAN_STARTED') {
        const { scanType } = request.data;
        console.log('Content: Received SCAN_STARTED for', scanType);
        this.updateToggleButtonScanning(true, 0, scanType);
        return false;
      }

      if (request.type === 'SCAN_STOPPED') {
        const { scanType } = request.data;
        console.log('Content: Received SCAN_STOPPED for', scanType);
        // Small delay before resetting to show completion
        setTimeout(() => {
          this.updateToggleButtonScanning(false);
        }, 2000);
        return false;
      }

      return false;
    });
  }

  // Create floating widget
  createFloatingWidget() {
    if (this.floatingWidget) return;

    try {
      // Create toggle button first
      this.createToggleButton();

      // Create widget container
      this.floatingWidget = document.createElement('div');
      this.floatingWidget.id = 'package-tracker-widget';
      this.floatingWidget.innerHTML = this.getWidgetHTML();

      // Add styles
      this.addWidgetStyles();

      // Add to page
      document.body.appendChild(this.floatingWidget);

      // Setup event listeners
      this.setupWidgetEventListeners();

      // Initialize widget data
      this.initializeWidget();

      // Start with widget hidden
      this.hideWidget();
    } catch (error) {
      // If widget creation fails, at least try to create the toggle button
      if (!this.toggleButton) {
        this.createToggleButton();
      }
    }
  }

  // Create toggle button
  createToggleButton() {

    // Remove existing toggle button if it exists
    const existingToggle = document.getElementById('package-tracker-toggle');
    if (existingToggle) {
      existingToggle.remove();
    }

    const toggleButton = document.createElement('div');
    toggleButton.id = 'package-tracker-toggle';
    toggleButton.innerHTML = '📦';
    toggleButton.title = 'Gmail Tracker - Click to open, Right-click for quick actions';

    // Left click - toggle widget
    toggleButton.addEventListener('click', async () => {
      await this.toggleWidget();
    });

    // Right click - show quick action menu
    toggleButton.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showQuickActionMenu(e);
    });

    document.body.appendChild(toggleButton);
    this.toggleButton = toggleButton;
    
    // Check scanning state immediately after creating toggle button
    this.checkScanningState();
  }

  // Get widget HTML structure
  getWidgetHTML() {
    return `
      <div class="widget-header">
        <span class="widget-icon">📦</span>
        <span class="widget-title">Gmail Tracker</span>
        <div class="widget-controls">
          <button class="widget-minimize" title="Minimize">−</button>
          <button class="widget-close" title="Close">×</button>
        </div>
      </div>
      
      <div class="widget-content">
        <div class="subscription-section">
          <h3 style="margin: 0 0 8px 0; font-size: 12px; color: #202124;">💳 Subscription Tracker</h3>
          <button class="scan-button subscription-button" id="widget-scanSubscriptionsBtn">
            🔍 Scan Current Month Subscriptions
          </button>
          
          <div class="progress-section" id="widget-subscriptionProgress" style="display: none;">
            <div class="progress-bar">
              <div class="progress-fill" id="widget-subscriptionProgressFill"></div>
            </div>
            <div class="progress-text" id="widget-subscriptionProgressText">Initializing...</div>
          </div>
          
          <div class="subscription-results" id="widget-subscriptionResults"></div>
        </div>

        <div class="package-section" style="margin-top: 16px; padding-top: 12px; border-top: 1px solid #f1f3f4;">
          <h3 style="margin: 0 0 8px 0; font-size: 12px; color: #202124;">📦 Package Tracking</h3>
          <div class="date-range-section">
            <label for="widget-startDate">From:</label>
            <input type="date" id="widget-startDate" class="date-input" value="${PACKAGE_CONFIG.DEFAULT_START_DATE}">
            <label for="widget-endDate">To:</label>
            <input type="date" id="widget-endDate" class="date-input" value="${PACKAGE_CONFIG.DEFAULT_END_DATE}">
          </div>

          <button class="scan-button" id="widget-scanBtn">
            🔍 Scan for Package Deliveries
          </button>

          <div class="progress-section" id="widget-progress" style="display: none;">
            <div class="progress-bar">
              <div class="progress-fill" id="widget-progressFill"></div>
            </div>
            <div class="progress-text" id="widget-progressText">Initializing...</div>
          </div>

          <div class="packages-list" id="widget-packagesList"></div>
        </div>
        
        <div class="result-area" id="widget-resultArea" style="display: none;">
          Results will appear here...
        </div>
      </div>
    `;
  }

  // Add widget styles
  addWidgetStyles() {
    if (document.getElementById('package-tracker-styles')) return;

    const styles = document.createElement('style');
    styles.id = 'package-tracker-styles';
    styles.textContent = `
      #package-tracker-widget {
        position: fixed;
        top: 20px;
        right: 20px;
        width: 350px;
        background: #ffffff;
        border: 1px solid #e8eaed;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.15);
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        font-size: 12px;
        z-index: 10000;
        max-height: 80vh;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      #package-tracker-widget.minimized .widget-content {
        display: none;
      }

      .widget-header {
        display: flex;
        align-items: center;
        padding: 12px 16px;
        background: #f8f9fa;
        border-bottom: 1px solid #e8eaed;
        cursor: move;
        user-select: none;
      }

      .widget-icon {
        font-size: 16px;
        margin-right: 8px;
      }

      .widget-title {
        flex: 1;
        font-weight: 500;
        color: #202124;
      }

      .widget-controls {
        display: flex;
        gap: 4px;
      }

      .widget-minimize, .widget-close {
        width: 24px;
        height: 24px;
        border: none;
        background: none;
        cursor: pointer;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        color: #5f6368;
      }

      .widget-minimize:hover, .widget-close:hover {
        background: #f1f3f4;
      }

      .widget-content {
        padding: 16px;
        overflow-y: auto;
        max-height: calc(80vh - 60px);
      }

      .date-range-section {
        display: grid;
        grid-template-columns: auto 1fr auto 1fr;
        gap: 8px;
        align-items: center;
        margin-bottom: 12px;
        font-size: 11px;
      }

      .date-input {
        padding: 4px 6px;
        border: 1px solid #dadce0;
        border-radius: 4px;
        font-size: 11px;
      }

      .scan-button {
        width: 100%;
        padding: 8px 12px;
        background: #34a853;
        color: white;
        border: none;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: background-color 0.2s;
        margin-bottom: 12px;
      }

      .scan-button:hover:not(:disabled) {
        background: #2d8f47;
      }

      .scan-button:disabled {
        background: #f1f3f4;
        color: #9aa0a6;
        cursor: not-allowed;
      }

      .subscription-button {
        background: #9c27b0;
        margin-bottom: 8px;
      }

      .subscription-button:hover:not(:disabled) {
        background: #7b1fa2;
      }

      .subscription-results {
        margin-bottom: 8px;
      }

      .subscription-item {
        background: #f3e5f5;
        border: 1px solid #e1bee7;
        border-radius: 4px;
        padding: 8px;
        margin-bottom: 6px;
        font-size: 10px;
      }

      .subscription-name {
        font-weight: 500;
        color: #4a148c;
        margin-bottom: 2px;
      }

      .subscription-amount {
        color: #6a1b9a;
        font-size: 9px;
      }

      .subscription-reminder {
        color: #8e24aa;
        font-size: 9px;
        margin-top: 2px;
      }

      .progress-section {
        margin-bottom: 12px;
      }

      .progress-bar {
        width: 100%;
        height: 4px;
        background: #f1f3f4;
        border-radius: 2px;
        overflow: hidden;
        margin-bottom: 6px;
      }

      .progress-fill {
        height: 100%;
        background: #1a73e8;
        width: 0%;
        transition: width 0.3s ease;
      }

      .progress-text {
        font-size: 10px;
        color: #5f6368;
        text-align: center;
      }

      .packages-list {
        margin-bottom: 12px;
      }

      .month-group {
        margin-bottom: 12px;
      }

      .month-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: #e8f0fe;
        border: 1px solid #dadce0;
        border-radius: 6px;
        padding: 8px 12px;
        cursor: pointer;
        transition: background-color 0.2s;
        margin-bottom: 6px;
      }

      .month-header:hover {
        background: #d2e3fc;
      }

      .month-title {
        font-weight: 500;
        color: #1a73e8;
        font-size: 11px;
      }

      .month-toggle {
        font-size: 10px;
        color: #5f6368;
        transition: transform 0.2s;
      }

      .month-toggle.collapsed {
        transform: rotate(-90deg);
      }

      .month-packages {
        margin-left: 6px;
        transition: max-height 0.3s ease-out, opacity 0.3s ease-out;
        overflow: hidden;
        max-height: 1000px;
        opacity: 1;
      }

      .month-packages.collapsed {
        max-height: 0;
        opacity: 0;
      }

      .package-item {
        background: #f8f9fa;
        border: 1px solid #e8eaed;
        border-radius: 6px;
        padding: 10px;
        margin-bottom: 8px;
      }

      .package-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
      }

      .package-sender {
        font-weight: 500;
        color: #202124;
        text-transform: capitalize;
        font-size: 11px;
      }

      .package-date {
        font-size: 10px;
        color: #5f6368;
      }

      .package-details {
        font-size: 10px;
        color: #5f6368;
        margin-bottom: 6px;
      }

      .package-email-link {
        margin-bottom: 6px;
      }

      .email-link {
        color: #1a73e8;
        text-decoration: none;
        font-size: 10px;
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }

      .email-link:hover {
        text-decoration: underline;
      }

      .pickup-button {
        background: #ea4335;
        color: white;
        border: none;
        border-radius: 4px;
        padding: 4px 8px;
        font-size: 10px;
        cursor: pointer;
        transition: background-color 0.2s;
        width: 100%;
      }

      .pickup-button:hover {
        background: #d33b2c;
      }

      .no-packages {
        text-align: center;
        color: #5f6368;
        font-size: 11px;
        padding: 16px;
        font-style: italic;
      }

      .result-area {
        background: #f8f9fa;
        border-radius: 6px;
        padding: 10px;
        font-size: 11px;
        color: #5f6368;
        max-height: 100px;
        overflow-y: auto;
      }

      .scan-info {
        text-align: center;
        margin-bottom: 8px;
      }

      .scan-info small {
        color: #5f6368;
        font-size: 10px;
      }

      #package-tracker-toggle {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 50px;
        height: 50px;
        background: #34a853;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 20px;
        cursor: pointer;
        box-shadow: 0 4px 16px rgba(0,0,0,0.15);
        z-index: 9999;
        transition: all 0.3s ease;
        user-select: none;
      }

      #package-tracker-toggle:hover {
        background: #2d8f47;
        transform: scale(1.1);
      }

      #package-tracker-toggle.scanning {
        background: #1a73e8;
        animation: pulse-scanning 2s infinite;
      }

      #package-tracker-toggle.scanning:hover {
        background: #1557b0;
      }

      @keyframes pulse-scanning {
        0% {
          box-shadow: 0 4px 16px rgba(0,0,0,0.15);
        }
        50% {
          box-shadow: 0 4px 20px rgba(26, 115, 232, 0.4);
          transform: scale(1.05);
        }
        100% {
          box-shadow: 0 4px 16px rgba(0,0,0,0.15);
        }
      }
    `;

    document.head.appendChild(styles);
  }

  // Setup widget event listeners
  setupWidgetEventListeners() {
    const widget = this.floatingWidget;

    // Close button
    widget.querySelector('.widget-close').addEventListener('click', () => {
      this.hideWidget();
    });

    // Minimize button
    widget.querySelector('.widget-minimize').addEventListener('click', () => {
      widget.classList.toggle('minimized');
    });

    // Subscription scan button
    widget.querySelector('#widget-scanSubscriptionsBtn').addEventListener('click', () => {
      this.handleScanSubscriptions();
    });

    // Package scan button
    widget.querySelector('#widget-scanBtn').addEventListener('click', () => {
      this.handleScanPackages();
    });

    // Make widget draggable
    this.makeDraggable(widget);
  }

  // Make widget draggable
  makeDraggable(element) {
    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;
    let xOffset = 0;
    let yOffset = 0;

    const header = element.querySelector('.widget-header');

    header.addEventListener('mousedown', (e) => {
      initialX = e.clientX - xOffset;
      initialY = e.clientY - yOffset;

      if (e.target === header || header.contains(e.target)) {
        isDragging = true;
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        e.preventDefault();
        currentX = e.clientX - initialX;
        currentY = e.clientY - initialY;

        xOffset = currentX;
        yOffset = currentY;

        element.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
      }
    });

    document.addEventListener('mouseup', () => {
      initialX = currentX;
      initialY = currentY;
      isDragging = false;
    });
  }

  // Initialize widget with data
  async initializeWidget() {
    try {
      // Check if scanning is already in progress (this will also update the toggle button)
      await this.checkScanningState();

      await this.loadUnpickedPackages();
      await this.loadSubscriptionResults();
      await this.loadProgressState();
      await this.showScanOptimizationInfo();
    } catch (error) {
      console.error('Failed to initialize widget:', error);
    }
  }

  // Check if scanning is already in progress
  async checkScanningState() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.GET_SCANNING_STATE
      });

      if (response.success) {
        const subscriptionActive = response.subscriptionScanningState?.isScanning || false;
        const packageActive = response.packageScanningState?.isScanning || false;
        
        // Apply subscription scanning state
        if (subscriptionActive) {
          const state = response.subscriptionScanningState;
          this.applySubscriptionScanningState(true, state.progress, state.message, state.step, state.options);
        } else {
          this.applySubscriptionScanningState(false);
        }
        
        // Apply package scanning state
        if (packageActive) {
          const state = response.packageScanningState;
          this.applyPackageScanningState(true, state.progress, state.message, state.step, state.options);
        } else {
          this.applyPackageScanningState(false);
        }
        
        // Update toggle button based on any active scan
        if (subscriptionActive || packageActive) {
          const activeState = subscriptionActive ? response.subscriptionScanningState : response.packageScanningState;
          const scanType = subscriptionActive ? 'subscription' : 'package';
          this.updateToggleButtonScanning(true, activeState.progress, scanType);
        } else {
          this.updateToggleButtonScanning(false);
        }
      } else {
        this.applyScanningState(false);
      }
    } catch (error) {
      this.applyScanningState(false);
    }
  }

  // Apply subscription scanning state to UI
  applySubscriptionScanningState(isScanning, progress = 0, message = '', step = '', options = null) {
    // Update widget if exists
    if (this.floatingWidget) {
      const subscriptionBtn = this.floatingWidget.querySelector('#widget-scanSubscriptionsBtn');
      if (subscriptionBtn) {
        if (isScanning) {
          subscriptionBtn.disabled = true;
          subscriptionBtn.textContent = 'Scanning...';
          this.showSubscriptionProgress();
          this.updateSubscriptionProgress({ progress, message, step });
        } else {
          subscriptionBtn.disabled = false;
          subscriptionBtn.textContent = '🔍 Scan Current Month Subscriptions';
          this.hideSubscriptionProgress();
        }
      }
    }
  }

  // Apply package scanning state to UI
  applyPackageScanningState(isScanning, progress = 0, message = '', step = '', options = null) {
    // Update widget if exists
    if (this.floatingWidget) {
      const scanBtn = this.floatingWidget.querySelector('#widget-scanBtn');
      if (scanBtn) {
        if (isScanning) {
          scanBtn.disabled = true;
          scanBtn.textContent = 'Scanning...';
          this.showProgress();
          this.updateProgress({ progress, message, step });

          // Restore date inputs if options available
          if (options) {
            const startDateInput = this.floatingWidget.querySelector('#widget-startDate');
            const endDateInput = this.floatingWidget.querySelector('#widget-endDate');
            if (startDateInput) startDateInput.value = options.startDate || startDateInput.value;
            if (endDateInput) endDateInput.value = options.endDate || endDateInput.value;
          }
        } else {
          scanBtn.disabled = false;
          scanBtn.textContent = '🔍 Scan for Package Deliveries';
          this.hideProgress();
        }
      }
    }
  }

  // Apply scanning state to UI (backward compatibility)
  applyScanningState(isScanning, progress = 0, message = '', step = '', options = null) {
    // Update toggle button
    this.updateToggleButtonScanning(isScanning, progress);

    // Apply to both scan types for backward compatibility
    this.applySubscriptionScanningState(isScanning, progress, message, step, options);
    this.applyPackageScanningState(isScanning, progress, message, step, options);
    
    if (!isScanning) {
      this.hideProgress();
    }
  }

  // Handle scan subscriptions
  async handleScanSubscriptions() {
    try {
      const scanBtn = this.floatingWidget.querySelector('#widget-scanSubscriptionsBtn');

      // Check if already scanning
      if (scanBtn.disabled) {
        this.showResult('Subscription scan already in progress. Please wait for it to complete.');
        return;
      }

      // Disable button and show progress immediately
      scanBtn.disabled = true;
      scanBtn.textContent = 'Scanning...';
      this.showSubscriptionProgress();
      
      // Show immediate progress update
      this.updateSubscriptionProgress({ 
        step: 'subscription_scan', 
        progress: 0, 
        message: 'Starting subscription scan...' 
      });

      // Update toggle button to show scanning state
      this.updateToggleButtonScanning(true, 0, 'subscription');

      // Clear previous results and show progress bar
      const subscriptionResults = this.floatingWidget.querySelector('#widget-subscriptionResults');
      if (subscriptionResults) {
        subscriptionResults.innerHTML = '';
      }
      this.showSubscriptionProgress();

      // Destroy any existing LLM session
      this.updateSubscriptionProgress({ progress: 5, message: 'Preparing LLM session...' });
      try {
        await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.DESTROY_LLM_SESSION });
      } catch (sessionError) {
        // Continue anyway
      }

      const response = await this.sendMessageSafely({
        type: MESSAGE_TYPES.SCAN_SUBSCRIPTION_EMAILS
      });

      console.log('Subscription scan response:', response);

      if (response.success) {
        this.showResult(`Subscription scan complete! Created ${response.events.length} calendar reminders`);
        this.displaySubscriptionResults(response.events);
        // Store results for persistence
        await this.storeSubscriptionResults(response.events);
        // Reload subscription list to show new subscriptions
        await this.loadSubscriptionList();
      } else {
        const errorMessage = response.error || 'Unknown error occurred';
        this.showResult(`Error: ${errorMessage}`);
        // Show error progress update
        this.updateSubscriptionProgress({ 
          step: 'error', 
          progress: 100, 
          message: `Error: ${errorMessage}` 
        });
      }
    } catch (error) {
      this.showResult(`Error: ${error.message}`);
      // Show error progress update
      this.updateSubscriptionProgress({ 
        step: 'error', 
        progress: 100, 
        message: `Error: ${error.message}` 
      });
    } finally {
      // Re-enable button with a small delay to prevent rapid clicking
      setTimeout(() => {
        const scanBtn = this.floatingWidget.querySelector('#widget-scanSubscriptionsBtn');
        if (scanBtn) {
          scanBtn.disabled = false;
          scanBtn.textContent = '🔍 Scan Current Month Subscriptions';
        }
        this.hideSubscriptionProgress();
        // Reset toggle button
        this.updateToggleButtonScanning(false);
      }, 1000);
    }
  }

  // Handle scan packages
  async handleScanPackages() {
    try {
      const scanBtn = this.floatingWidget.querySelector('#widget-scanBtn');

      // Check if already scanning by button state
      if (scanBtn.disabled) {
        this.showResult('Package scan already in progress. Please wait for it to complete.');
        return;
      }

      // First check if package scanning is already in progress
      const stateResponse = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.GET_SCANNING_STATE
      });

      if (stateResponse && stateResponse.success && stateResponse.packageScanningState.isScanning) {
        this.showResult('Package scan already in progress. Please wait for it to complete.');
        return;
      }

      const startDate = this.floatingWidget.querySelector('#widget-startDate').value;
      const endDate = this.floatingWidget.querySelector('#widget-endDate').value;

      if (!startDate || !endDate) {
        this.showResult('Please select both start and end dates');
        return;
      }

      // Disable button and show progress immediately
      scanBtn.disabled = true;
      scanBtn.textContent = 'Scanning...';
      this.showProgress();
      
      // Show immediate progress update
      this.updateProgress({ 
        step: 'package_scan', 
        progress: 0, 
        message: 'Starting package scan...' 
      });

      // Update toggle button to show scanning state
      this.updateToggleButtonScanning(true, 0, 'package');

      // Clear previous results and show progress bar
      const packagesList = this.floatingWidget.querySelector('#widget-packagesList');
      if (packagesList) {
        packagesList.innerHTML = '';
      }
      this.showProgress();

      // Destroy any existing LLM session
      this.updateProgress({ progress: 5, message: 'Preparing LLM session...' });
      try {
        await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.DESTROY_LLM_SESSION });
      } catch (sessionError) {
        // Continue anyway
      }

      const options = {
        startDate,
        endDate,
        keywords: PACKAGE_CONFIG.DEFAULT_SEARCH_KEYWORDS
      };

      const response = await this.sendMessageSafely({
        type: MESSAGE_TYPES.PROCESS_PACKAGE_EMAILS,
        options
      });

      if (response.success) {
        this.showResult(`Scan complete! Found ${response.packages.length} new packages`);
        await this.loadUnpickedPackages();
      } else {
        this.showResult(`Error: ${response.error}`);
      }
    } catch (error) {
      this.showResult(`Error: ${error.message}`);
    } finally {
      setTimeout(() => {
        const scanBtn = this.floatingWidget.querySelector('#widget-scanBtn');
        if (scanBtn) {
          scanBtn.disabled = false;
          scanBtn.textContent = '🔍 Scan for Package Deliveries';
        }
        this.hideProgress();
        // Reset toggle button to normal state
        this.updateToggleButtonScanning(false);
      }, 1000);
    }
  }

  // Load unpicked packages
  async loadUnpickedPackages() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.GET_UNPICKED_PACKAGES
      });

      if (response && response.success) {
        this.displayPackages(response.packages);
      } else {
        console.error('Failed to load packages:', response.error);
      }
    } catch (error) {
      console.error('Load packages error:', error);
    }
  }

  // Display packages grouped by month
  displayPackages(packages) {
    const container = this.floatingWidget.querySelector('#widget-packagesList');
    container.innerHTML = '';

    if (packages.length === 0) {
      container.innerHTML = '<div class="no-packages">No packages waiting for pickup</div>';
      return;
    }

    // Group packages by month
    const packagesByMonth = this.groupPackagesByMonth(packages);

    // Create month groups
    Object.keys(packagesByMonth).forEach(monthKey => {
      const monthPackages = packagesByMonth[monthKey];
      const monthGroupElement = this.createMonthGroupElement(monthKey, monthPackages);
      container.appendChild(monthGroupElement);
    });
  }

  // Group packages by month
  groupPackagesByMonth(packages) {
    const grouped = {};

    packages.forEach(pkg => {
      // Use the correct field name from the database schema
      const deliveryTime = pkg.deliveryTime || pkg['deliveryTime'];
      const deliveryDate = new Date(deliveryTime);
      const monthKey = `${deliveryDate.getFullYear()}-${String(deliveryDate.getMonth() + 1).padStart(2, '0')}`;
      const monthLabel = deliveryDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });

      if (!grouped[monthKey]) {
        grouped[monthKey] = {
          label: monthLabel,
          packages: []
        };
      }

      grouped[monthKey].packages.push(pkg);
    });

    // Sort months in descending order (newest first)
    const sortedGrouped = {};
    Object.keys(grouped)
      .sort((a, b) => b.localeCompare(a))
      .forEach(key => {
        sortedGrouped[key] = grouped[key];
      });

    return sortedGrouped;
  }

  // Create month group element
  createMonthGroupElement(monthKey, monthData) {
    const monthGroup = document.createElement('div');
    monthGroup.className = 'month-group';

    const monthHeader = document.createElement('div');
    monthHeader.className = 'month-header';
    monthHeader.innerHTML = `
      <div class="month-title">${monthData.label} (${monthData.packages.length})</div>
      <div class="month-toggle">▼</div>
    `;

    const monthPackages = document.createElement('div');
    monthPackages.className = 'month-packages';

    // Add packages to the month group
    monthData.packages.forEach(pkg => {
      const packageElement = this.createPackageElement(pkg);
      monthPackages.appendChild(packageElement);
    });

    // Add click handler for collapsible functionality
    monthHeader.addEventListener('click', () => {
      const toggle = monthHeader.querySelector('.month-toggle');
      const isCollapsed = monthPackages.classList.contains('collapsed');

      if (isCollapsed) {
        monthPackages.classList.remove('collapsed');
        toggle.classList.remove('collapsed');
        toggle.textContent = '▼';
      } else {
        monthPackages.classList.add('collapsed');
        toggle.classList.add('collapsed');
        toggle.textContent = '▶';
      }
    });

    monthGroup.appendChild(monthHeader);
    monthGroup.appendChild(monthPackages);

    return monthGroup;
  }

  // Create package element
  createPackageElement(pkg) {
    const element = document.createElement('div');
    element.className = 'package-item';

    const deliveryDate = new Date(pkg.deliveryDate).toLocaleDateString();
    const deliveryTime = new Date(pkg.deliveryTime).toLocaleString();

    element.innerHTML = `
      <div class="package-header">
        <div class="package-sender">${pkg.sender}</div>
        <div class="package-date">${deliveryDate}</div>
      </div>
      <div class="package-details">
        Delivered: ${deliveryTime}
      </div>
      <div class="package-email-link">
        <a href="#" class="email-link" data-email-id="${pkg.emailId}">
          📧 View Original Email
        </a>
      </div>
      <button class="pickup-button" data-package-id="${pkg.id}">
        ✓ Mark as Picked Up
      </button>
    `;

    // Add click handlers
    const emailLink = element.querySelector('.email-link');
    const pickupBtn = element.querySelector('.pickup-button');

    emailLink.addEventListener('click', (e) => {
      e.preventDefault();
      const emailId = emailLink.dataset.emailId;
      const gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${emailId}`;
      window.open(gmailUrl, '_blank');
    });

    pickupBtn.addEventListener('click', () => this.handleMarkAsPickedUp(pkg.id));

    return element;
  }

  // Handle mark as picked up
  async handleMarkAsPickedUp(packageId) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.MARK_PACKAGE_PICKED_UP,
        packageId
      });

      if (response.success) {
        await this.loadUnpickedPackages();
        this.showResult('Package marked as picked up!');
      } else {
        this.showResult(`Error: ${response.error}`);
      }
    } catch (error) {
      this.showResult(`Error: ${error.message}`);
    }
  }

  // Reset all scan states (called on extension reload/cleanup)
  resetAllScanStates() {
    if (this.floatingWidget) {
      // Reset subscription scan state
      const subscriptionBtn = this.floatingWidget.querySelector('#widget-scanSubscriptionsBtn');
      if (subscriptionBtn) {
        subscriptionBtn.disabled = false;
        subscriptionBtn.textContent = '🔍 Scan Current Month Subscriptions';
      }
      
      // Reset package scan state
      const packageBtn = this.floatingWidget.querySelector('#widget-scanBtn');
      if (packageBtn) {
        packageBtn.disabled = false;
        packageBtn.textContent = '🔍 Scan for Package Deliveries';
      }
      
      // Hide all progress bars
      this.hideSubscriptionProgress();
      this.hideProgress();
      
      // Reset toggle button
      this.updateToggleButtonScanning(false);
      
      // Clear stored progress states
      chrome.storage.local.remove(['progressState', 'subscriptionProgressState']).catch(() => {
        // Ignore errors
      });
      
      // Clear any result messages
      this.showResult('Extension reloaded - scan states reset');
    }
    
    console.log('Content: All scan states reset');
  }

  // Cleanup function for page unload
  cleanup() {
    try {
      // Clear any stored progress states
      chrome.storage.local.remove(['progressState', 'subscriptionProgressState']).catch(() => {
        // Ignore errors
      });
      
      console.log('Content: Cleanup completed on page unload');
    } catch (error) {
      console.error('Error during content script cleanup:', error);
    }
  }

  // Show subscription progress
  showSubscriptionProgress() {
    const progressSection = this.floatingWidget.querySelector('#widget-subscriptionProgress');
    if (progressSection) {
      progressSection.style.display = 'block';
      this.updateSubscriptionProgress({ progress: 0, message: 'Initializing...' });
    }
  }

  // Hide subscription progress
  hideSubscriptionProgress() {
    const progressSection = this.floatingWidget.querySelector('#widget-subscriptionProgress');
    if (progressSection) {
      progressSection.style.display = 'none';
    }
  }

  // Show package progress
  showProgress() {
    const progressSection = this.floatingWidget.querySelector('#widget-progress');
    if (progressSection) {
      progressSection.style.display = 'block';
      this.updateProgress({ progress: 0, message: 'Initializing...' });
    }
  }

  // Hide package progress
  hideProgress() {
    const progressSection = this.floatingWidget.querySelector('#widget-progress');
    if (progressSection) {
      progressSection.style.display = 'none';
    }
  }

  // Store progress state
  async storeProgressState(data, isSubscription = false) {
    try {
      const key = isSubscription ? 'subscriptionProgressState' : 'packageProgressState';
      const stateData = {
        ...data,
        timestamp: Date.now()
      };
      console.log(`Storing ${key}:`, stateData);
      await chrome.storage.local.set({
        [key]: stateData
      });
    } catch (error) {
      console.error('Failed to store progress state:', error);
    }
  }

  // Load and restore progress state
  async loadProgressState() {
    try {
      const result = await chrome.storage.local.get(['subscriptionProgressState', 'packageProgressState']);
      
      console.log('Loading progress state:', result);
      
      // Check subscription progress
      if (result.subscriptionProgressState) {
        const state = result.subscriptionProgressState;
        const fiveMinutes = 5 * 60 * 1000;
        const age = Date.now() - state.timestamp;
        
        console.log(`Subscription progress age: ${Math.round(age / 1000)} seconds, step: ${state.step}`);
        
        // Only restore if less than 5 minutes old and not complete
        if (age < fiveMinutes && state.step !== 'complete' && state.step !== 'error') {
          console.log('Restoring subscription progress:', state);
          const subscriptionBtn = this.floatingWidget.querySelector('#widget-scanSubscriptionsBtn');
          if (subscriptionBtn) {
            subscriptionBtn.disabled = true;
            subscriptionBtn.textContent = 'Scanning...';
          }
          this.showSubscriptionProgress();
          this.updateSubscriptionProgress(state);
          this.updateToggleButtonScanning(true, state.progress, 'subscription');
        } else {
          console.log('Subscription progress expired or complete, not restoring');
        }
      }

      // Check package progress
      if (result.packageProgressState) {
        const state = result.packageProgressState;
        const fiveMinutes = 5 * 60 * 1000;
        const age = Date.now() - state.timestamp;
        
        console.log(`Package progress age: ${Math.round(age / 1000)} seconds, step: ${state.step}`);
        
        // Only restore if less than 5 minutes old and not complete
        if (age < fiveMinutes && state.step !== 'complete' && state.step !== 'error') {
          console.log('Restoring package progress:', state);
          const packageBtn = this.floatingWidget.querySelector('#widget-scanBtn');
          if (packageBtn) {
            packageBtn.disabled = true;
            packageBtn.textContent = 'Scanning...';
          }
          this.showProgress();
          this.updateProgress(state);
          this.updateToggleButtonScanning(true, state.progress, 'package');
        } else {
          console.log('Package progress expired or complete, not restoring');
        }
      }
      
      if (!result.subscriptionProgressState && !result.packageProgressState) {
        console.log('No progress state found in storage');
      }
    } catch (error) {
      console.error('Failed to load progress state:', error);
    }
  }

  // Clear progress state
  async clearProgressState(isSubscription = false) {
    try {
      const key = isSubscription ? 'subscriptionProgressState' : 'packageProgressState';
      await chrome.storage.local.remove(key);
    } catch (error) {
      console.error('Failed to clear progress state:', error);
    }
  }

  // Update subscription progress
  updateSubscriptionProgress(data) {
    if (!this.floatingWidget) return;
    
    const progressFill = this.floatingWidget.querySelector('#widget-subscriptionProgressFill');
    const progressText = this.floatingWidget.querySelector('#widget-subscriptionProgressText');

    if (progressFill && progressText) {
      const progress = Math.max(0, Math.min(100, data.progress || 0));
      progressFill.style.width = `${progress}%`;
      progressText.textContent = data.message || 'Processing...';
      
      // Also update the result area with the current progress message
      this.showResult(data.message || 'Processing...');
    }
  }

  // Update package progress
  updateProgress(data) {
    if (!this.floatingWidget) return;
    
    const progressFill = this.floatingWidget.querySelector('#widget-progressFill');
    const progressText = this.floatingWidget.querySelector('#widget-progressText');

    if (progressFill && progressText) {
      const progress = Math.max(0, Math.min(100, data.progress || 0)); // Ensure progress is between 0-100
      progressFill.style.width = `${progress}%`;
      progressText.textContent = data.message || 'Processing...';
      
      // Also update the result area with the current progress message
      this.showResult(data.message || 'Processing...');
    }
  }

  // Update widget progress from background messages
  updateWidgetProgress(data) {
    if (this.floatingWidget) {
      // Determine if this is a subscription or package scan
      const isSubscriptionScan = data.scanType === 'subscription' || 
        data.step === 'subscription_scan' || 
        (data.message && (
          data.message.includes('subscription') || 
          data.message.includes('Subscription')
        ));

      console.log('updateWidgetProgress - step:', data.step, 'scanType:', data.scanType, 'message:', data.message, 'isSubscriptionScan:', isSubscriptionScan);

      if (isSubscriptionScan) {
        console.log('Updating subscription progress bar');
        this.updateSubscriptionProgress(data);
      } else {
        console.log('Updating package progress bar');
        this.updateProgress(data);
      }
    }
  }

  // Show result
  showResult(text) {
    const resultArea = this.floatingWidget.querySelector('#widget-resultArea');
    resultArea.textContent = text;
    resultArea.style.display = 'block';

    // Hide after 5 seconds
    setTimeout(() => {
      resultArea.style.display = 'none';
    }, 5000);
  }

  // Show scan optimization info
  async showScanOptimizationInfo() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.GET_SCAN_HISTORY
      });

      if (response.success && response.scanHistory.length > 0) {
        const latestScan = response.scanHistory[0];
        const scanDate = new Date(latestScan.scanDate).toLocaleDateString();
        const emailsScanned = latestScan.emailsScanned;

        const infoElement = document.createElement('div');
        infoElement.className = 'scan-info';
        infoElement.innerHTML = `
          <small>💡 Last scan: ${scanDate} (${emailsScanned} emails checked)</small>
        `;

        const scanButton = this.floatingWidget.querySelector('#widget-scanBtn');
        scanButton.parentNode.insertBefore(infoElement, scanButton.nextSibling);
      }
    } catch (error) {
      // Don't show error to user, this is just optimization info
    }
  }

  // Hide widget
  hideWidget() {
    if (this.floatingWidget) {
      this.floatingWidget.style.display = 'none';
      this.isWidgetVisible = false;
    }
  }

  // Show widget
  async showWidget() {
    if (this.floatingWidget) {
      this.floatingWidget.style.display = 'flex';
      this.isWidgetVisible = true;
      
      // Check scanning state when widget is shown to sync with popup
      await this.checkScanningState();
      
      // Load progress state to restore any active scans
      await this.loadProgressState();
      
      // Load subscription results when widget is shown
      await this.loadSubscriptionResults();
      
      // Load unpicked packages to refresh data
      await this.loadUnpickedPackages();
    }
  }

  // Toggle widget visibility
  async toggleWidget() {
    if (this.isWidgetVisible) {
      this.hideWidget();
    } else {
      await this.showWidget();
    }
  }

  // Store subscription results in chrome storage
  async storeSubscriptionResults(events) {
    try {
      console.log('Storing subscription results:', events);
      await chrome.storage.local.set({
        'subscriptionResults': events,
        'subscriptionResultsTimestamp': Date.now()
      });
      console.log('Subscription results stored successfully');
    } catch (error) {
      console.error('Failed to store subscription results:', error);
    }
  }

  // Load subscription results from chrome storage
  async loadSubscriptionResults() {
    try {
      const result = await chrome.storage.local.get(['subscriptionResults', 'subscriptionResultsTimestamp']);
      
      console.log('Loading subscription results:', result);
      
      if (result.subscriptionResults && result.subscriptionResultsTimestamp) {
        // Only show results if they're less than 24 hours old
        const twentyFourHours = 24 * 60 * 60 * 1000;
        const age = Date.now() - result.subscriptionResultsTimestamp;
        console.log(`Subscription results age: ${Math.round(age / (60 * 60 * 1000))} hours`);
        
        if (age < twentyFourHours) {
          console.log('Displaying stored subscription results:', result.subscriptionResults);
          this.displaySubscriptionResults(result.subscriptionResults);
        } else {
          console.log('Subscription results expired, not displaying');
        }
      } else {
        console.log('No subscription results found in storage');
      }
    } catch (error) {
      console.error('Failed to load subscription results:', error);
    }
  }

  // Display subscription results
  displaySubscriptionResults(events) {
    const container = this.floatingWidget.querySelector('#widget-subscriptionResults');
    container.innerHTML = '';

    if (events.length === 0) {
      container.innerHTML = '<div style="text-align: center; color: #5f6368; font-style: italic; padding: 8px; font-size: 10px;">No subscriptions found</div>';
      return;
    }

    events.forEach(event => {
      const item = document.createElement('div');
      item.className = 'subscription-item';
      
      item.innerHTML = `
        <div class="subscription-name">${event.subscriptionName || 'Unknown Service'}</div>
        <div class="subscription-amount">Amount: ${event.amount || 'N/A'}</div>
        <div class="subscription-reminder">Reminder: ${event.reminderDate}</div>
      `;
      
      container.appendChild(item);
    });

    // Store the results for persistence
    this.storeSubscriptionResults(events);
  }

  // Show quick action menu
  showQuickActionMenu(event) {
    // Remove existing menu if any
    const existingMenu = document.getElementById('tracker-quick-menu');
    if (existingMenu) {
      existingMenu.remove();
    }

    const menu = document.createElement('div');
    menu.id = 'tracker-quick-menu';
    menu.innerHTML = `
      <div class="quick-menu-item" data-action="scan-subscriptions">
        💳 Scan Subscriptions
      </div>
      <div class="quick-menu-item" data-action="scan-packages">
        📦 Scan Packages
      </div>
      <div class="quick-menu-item" data-action="open-widget">
        ⚙️ Open Full Widget
      </div>
    `;

    // Position menu near the toggle button
    const rect = this.toggleButton.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.right = '70px';
    menu.style.bottom = '20px';
    menu.style.background = '#ffffff';
    menu.style.border = '1px solid #e8eaed';
    menu.style.borderRadius = '8px';
    menu.style.boxShadow = '0 4px 16px rgba(0,0,0,0.15)';
    menu.style.zIndex = '10001';
    menu.style.minWidth = '160px';
    menu.style.fontSize = '12px';
    menu.style.fontFamily = "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif";

    // Add menu item styles
    const style = document.createElement('style');
    style.textContent = `
      .quick-menu-item {
        padding: 10px 12px;
        cursor: pointer;
        border-bottom: 1px solid #f1f3f4;
        transition: background-color 0.2s;
      }
      .quick-menu-item:last-child {
        border-bottom: none;
      }
      .quick-menu-item:hover {
        background-color: #f8f9fa;
      }
    `;
    document.head.appendChild(style);

    // Add click handlers
    menu.addEventListener('click', async (e) => {
      const action = e.target.dataset.action;
      menu.remove();
      
      switch (action) {
        case 'scan-subscriptions':
          await this.quickScanSubscriptions();
          break;
        case 'scan-packages':
          await this.quickScanPackages();
          break;
        case 'open-widget':
          await this.showWidget();
          break;
      }
    });

    // Close menu when clicking outside
    const closeMenu = (e) => {
      if (!menu.contains(e.target) && e.target !== this.toggleButton) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 100);

    document.body.appendChild(menu);
  }

  // Quick scan subscriptions
  async quickScanSubscriptions() {
    try {
      this.updateToggleButtonScanning(true, 0, 'subscription');

      const response = await this.sendMessageSafely({
        type: MESSAGE_TYPES.SCAN_SUBSCRIPTION_EMAILS
      });

      if (response.success) {
        this.toggleButton.innerHTML = '✅';
        this.toggleButton.title = `Found ${response.events.length} subscriptions! Click to view details.`;
        
        // Reset after 3 seconds
        setTimeout(() => {
          this.updateToggleButtonScanning(false);
        }, 3000);
      } else {
        this.toggleButton.innerHTML = '❌';
        this.toggleButton.title = `Error: ${response.error}`;
        setTimeout(() => {
          this.updateToggleButtonScanning(false);
        }, 3000);
      }
    } catch (error) {
      this.toggleButton.innerHTML = '❌';
      this.toggleButton.title = `Error: ${error.message}`;
      setTimeout(() => {
        this.updateToggleButtonScanning(false);
      }, 3000);
    }
  }

  // Quick scan packages
  async quickScanPackages() {
    try {
      this.updateToggleButtonScanning(true, 0, 'package');

      // Use default date range
      const options = {
        startDate: PACKAGE_CONFIG.DEFAULT_START_DATE,
        endDate: PACKAGE_CONFIG.DEFAULT_END_DATE,
        keywords: PACKAGE_CONFIG.DEFAULT_SEARCH_KEYWORDS
      };

      const response = await this.sendMessageSafely({
        type: MESSAGE_TYPES.PROCESS_PACKAGE_EMAILS,
        options
      });

      if (response.success) {
        this.toggleButton.innerHTML = '✅';
        this.toggleButton.title = `Found ${response.packages.length} packages! Click to view details.`;
        
        // Reset after 3 seconds
        setTimeout(() => {
          this.updateToggleButtonScanning(false);
        }, 3000);
      } else {
        this.toggleButton.innerHTML = '❌';
        this.toggleButton.title = `Error: ${response.error}`;
        setTimeout(() => {
          this.updateToggleButtonScanning(false);
        }, 3000);
      }
    } catch (error) {
      this.toggleButton.innerHTML = '❌';
      this.toggleButton.title = `Error: ${error.message}`;
      setTimeout(() => {
        this.updateToggleButtonScanning(false);
      }, 3000);
    }
  }

  // Check if other scan type is still active
  async checkOtherScanActive(completedSubscriptionScan) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.GET_SCANNING_STATE
      });

      if (response.success) {
        const subscriptionActive = response.subscriptionScanningState?.isScanning || false;
        const packageActive = response.packageScanningState?.isScanning || false;
        
        // If no scans are active, reset toggle button
        if (!subscriptionActive && !packageActive) {
          this.updateToggleButtonScanning(false);
        }
      }
    } catch (error) {
      // If we can't check, assume no scans are active
      this.updateToggleButtonScanning(false);
    }
  }

  // Setup periodic scanning state check
  setupPeriodicStateCheck() {
    // Check scanning state every 2 seconds to keep UI in sync
    setInterval(async () => {
      try {
        await this.checkScanningState();
        await this.pollProgressUpdates();
      } catch (error) {
        // Ignore errors in periodic check
      }
    }, 2000);
  }

  // Poll for progress updates from storage
  async pollProgressUpdates() {
    try {
      const result = await chrome.storage.local.get(['currentSubscriptionProgress', 'currentPackageProgress']);
      
      // Check subscription progress
      if (result.currentSubscriptionProgress) {
        const progressData = result.currentSubscriptionProgress;
        this.updateWidgetProgress(progressData);
        this.updateToggleButtonScanning(true, progressData.progress, 'subscription');
        
        // Show subscription progress bar in widget and update button state
        if (this.floatingWidget) {
          const subscriptionBtn = this.floatingWidget.querySelector('#widget-scanSubscriptionsBtn');
          if (subscriptionBtn) {
            subscriptionBtn.disabled = true;
            subscriptionBtn.textContent = 'Scanning...';
          }
          this.showSubscriptionProgress();
          this.updateSubscriptionProgress(progressData);
          
          // Show result message in widget
          this.showResult(progressData.message);
        }
        
        // If complete, clear the progress and reset toggle
        if (progressData.step === 'complete' || progressData.step === 'error') {
          // Reset widget UI immediately
          if (this.floatingWidget) {
            const subscriptionBtn = this.floatingWidget.querySelector('#widget-scanSubscriptionsBtn');
            if (subscriptionBtn) {
              subscriptionBtn.disabled = false;
              subscriptionBtn.textContent = '🔍 Scan Current Month Subscriptions';
            }
            
            // Show completion message and hide progress
            if (progressData.step === 'complete') {
              this.showResult(`Subscription scan complete! Created ${progressData.message.match(/\d+/)?.[0] || 0} calendar reminders`);
              // Reload subscription results in widget
              this.loadSubscriptionResults();
            }
            
            // Hide progress bar immediately
            this.hideSubscriptionProgress();
          }
          
          // Show completion state briefly, then reset toggle
          this.updateToggleButtonScanning(false);
          if (progressData.step === 'complete') {
            this.toggleButton.innerHTML = '✅';
            this.toggleButton.title = `Subscription scan complete! Created ${progressData.message.match(/\d+/)?.[0] || 0} subscriptions.`;
            setTimeout(() => {
              this.toggleButton.innerHTML = '📦';
              this.toggleButton.title = 'Gmail Tracker - Click to open, Right-click for quick actions';
            }, 3000);
          }
        }
      }
      
      // Check package progress
      if (result.currentPackageProgress) {
        const progressData = result.currentPackageProgress;
        this.updateWidgetProgress(progressData);
        this.updateToggleButtonScanning(true, progressData.progress, 'package');
        
        // Show package progress bar in widget and update button state
        if (this.floatingWidget) {
          const packageBtn = this.floatingWidget.querySelector('#widget-scanBtn');
          if (packageBtn) {
            packageBtn.disabled = true;
            packageBtn.textContent = 'Scanning...';
          }
          this.showProgress();
          this.updateProgress(progressData);
          
          // Show result message in widget
          this.showResult(progressData.message);
        }
        
        // If complete, clear the progress and reset toggle
        if (progressData.step === 'complete' || progressData.step === 'error') {
          // Reset widget UI immediately
          if (this.floatingWidget) {
            const packageBtn = this.floatingWidget.querySelector('#widget-scanBtn');
            if (packageBtn) {
              packageBtn.disabled = false;
              packageBtn.textContent = '🔍 Scan for Package Deliveries';
            }
            
            // Show completion message and hide progress
            if (progressData.step === 'complete') {
              this.showResult(`Package scan complete! Found ${progressData.message.match(/\d+/)?.[0] || 0} packages`);
              // Reload packages in widget
              this.loadUnpickedPackages();
            }
            
            // Hide progress bar immediately
            this.hideProgress();
          }
          
          // Show completion state briefly, then reset toggle
          this.updateToggleButtonScanning(false);
          if (progressData.step === 'complete') {
            this.toggleButton.innerHTML = '✅';
            this.toggleButton.title = `Package scan complete! Created ${progressData.message.match(/\d+/)?.[0] || 0} packages.`;
            setTimeout(() => {
              this.toggleButton.innerHTML = '📦';
              this.toggleButton.title = 'Gmail Tracker - Click to open, Right-click for quick actions';
            }, 3000);
          }
        }
      }
      
      // If no progress data, make sure toggle button is not in scanning state and hide progress bars
      if (!result.currentSubscriptionProgress && !result.currentPackageProgress) {
        // Only reset if not already in normal state
        if (this.toggleButton && this.toggleButton.classList.contains('scanning')) {
          this.updateToggleButtonScanning(false);
        }
        // Hide progress bars and reset buttons if no active scans
        if (this.floatingWidget) {
          this.hideSubscriptionProgress();
          this.hideProgress();
          
          // Reset button states
          const subscriptionBtn = this.floatingWidget.querySelector('#widget-scanSubscriptionsBtn');
          if (subscriptionBtn && subscriptionBtn.disabled) {
            subscriptionBtn.disabled = false;
            subscriptionBtn.textContent = '🔍 Scan Current Month Subscriptions';
          }
          
          const packageBtn = this.floatingWidget.querySelector('#widget-scanBtn');
          if (packageBtn && packageBtn.disabled) {
            packageBtn.disabled = false;
            packageBtn.textContent = '🔍 Scan for Package Deliveries';
          }
        }
      }
    } catch (error) {
      // Ignore polling errors
    }
  }

  // Update toggle button to show scanning state
  updateToggleButtonScanning(isScanning, progress = 0, scanType = null) {
    if (!this.toggleButton) {
      return;
    }

    if (isScanning) {
      this.toggleButton.classList.add('scanning');
      
      // Show different icons based on scan type
      if (scanType === 'subscription') {
        this.toggleButton.innerHTML = '💳';
        this.toggleButton.title = `Gmail Tracker - Scanning subscriptions... ${Math.round(progress)}%`;
      } else if (scanType === 'package') {
        this.toggleButton.innerHTML = '📦';
        this.toggleButton.title = `Gmail Tracker - Scanning packages... ${Math.round(progress)}%`;
      } else {
        this.toggleButton.innerHTML = '⏳';
        this.toggleButton.title = `Gmail Tracker - Scanning... ${Math.round(progress)}%`;
      }
    } else {
      this.toggleButton.classList.remove('scanning');
      this.toggleButton.innerHTML = '📦';
      this.toggleButton.title = 'Gmail Tracker - Click to open, Right-click for quick actions';
    }
  }
}

// Initialize the Gmail content script
new GmailContentScript();