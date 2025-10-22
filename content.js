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
  SCANNING_STATE_CHANGED: 'SCANNING_STATE_CHANGED'
};

class GmailContentScript {
  constructor() {
    this.isGmailActive = false;
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

    chrome.runtime.sendMessage({
      type: 'GMAIL_STATE_CHANGE',
      active: true,
      url: window.location.href
    }).catch(() => {
      // Ignore errors if background service not ready
    });
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
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
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
        this.updateWidgetProgress(request.data);

        // Update toggle button with progress
        const isScanning = request.data.step !== 'complete' && request.data.step !== 'error';
        this.updateToggleButtonScanning(isScanning, request.data.progress);

        // If scanning is complete, reset UI
        if (request.data.step === 'complete' || request.data.step === 'error') {
          setTimeout(() => {
            const scanBtn = this.floatingWidget?.querySelector('#widget-scanBtn');
            if (scanBtn) {
              scanBtn.disabled = false;
              scanBtn.textContent = '🔍 Scan for Package Deliveries';
              if (request.data.step === 'complete') {
                this.hideProgress();
                this.loadUnpickedPackages();
              }
            }
            // Ensure toggle button is reset to normal state
            this.updateToggleButtonScanning(false);
          }, 2000); // Give user time to see the completion message
        }
        return false;
      }

      if (request.type === 'SCANNING_STATE_CHANGED') {
        const { isScanning, progress, message, step } = request.data;
        this.applyScanningState(isScanning, progress, message, step);
        
        if (!isScanning && step === 'complete') {
          this.loadUnpickedPackages();
        }
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
    toggleButton.title = 'Toggle Package Tracker';

    toggleButton.addEventListener('click', async () => {
      await this.toggleWidget();
    });

    document.body.appendChild(toggleButton);
    this.toggleButton = toggleButton;
  }

  // Get widget HTML structure
  getWidgetHTML() {
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    return `
      <div class="widget-header">
        <span class="widget-icon">📦</span>
        <span class="widget-title">Package Tracker</span>
        <div class="widget-controls">
          <button class="widget-minimize" title="Minimize">−</button>
          <button class="widget-close" title="Close">×</button>
        </div>
      </div>
      
      <div class="widget-content">
        <div class="date-range-section">
          <label for="widget-startDate">From:</label>
          <input type="date" id="widget-startDate" class="date-input" value="${weekAgo}">
          <label for="widget-endDate">To:</label>
          <input type="date" id="widget-endDate" class="date-input" value="${today}">
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

    // Scan button
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

      if (response.success && response.scanningState.isScanning) {
        const state = response.scanningState;
        this.applyScanningState(true, state.progress, state.message, state.step, state.options);
      } else {
        this.applyScanningState(false);
      }
    } catch (error) {
      this.applyScanningState(false);
    }
  }

  // Apply scanning state to UI
  applyScanningState(isScanning, progress = 0, message = '', step = '', options = null) {
    // Update toggle button
    this.updateToggleButtonScanning(isScanning, progress);

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

  // Handle scan packages
  async handleScanPackages() {
    try {
      // First check if scanning is already in progress
      const stateResponse = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.GET_SCANNING_STATE
      });

      if (stateResponse.success && stateResponse.scanningState.isScanning) {
        this.showResult('Scan already in progress. Please wait for it to complete.');
        return;
      }

      const startDate = this.floatingWidget.querySelector('#widget-startDate').value;
      const endDate = this.floatingWidget.querySelector('#widget-endDate').value;
      const scanBtn = this.floatingWidget.querySelector('#widget-scanBtn');

      if (!startDate || !endDate) {
        this.showResult('Please select both start and end dates');
        return;
      }

      // Disable button and show progress
      scanBtn.disabled = true;
      scanBtn.textContent = 'Scanning...';
      this.showProgress();

      // Update toggle button to show scanning state
      this.updateToggleButtonScanning(true, 0);

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
        keywords: ['delivered', 'shipment delivered', 'delivery confirmation', 'package has arrived', 'delivered to']
      };

      const response = await chrome.runtime.sendMessage({
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
      const scanBtn = this.floatingWidget.querySelector('#widget-scanBtn');
      scanBtn.disabled = false;
      scanBtn.textContent = '🔍 Scan for Package Deliveries';
      this.hideProgress();

      // Reset toggle button to normal state
      this.updateToggleButtonScanning(false);
    }
  }

  // Load unpicked packages
  async loadUnpickedPackages() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.GET_UNPICKED_PACKAGES
      });

      if (response.success) {
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

  // Show progress
  showProgress() {
    const progressSection = this.floatingWidget.querySelector('#widget-progress');
    progressSection.style.display = 'block';
    this.updateProgress({ progress: 0, message: 'Initializing...' });
  }

  // Hide progress
  hideProgress() {
    const progressSection = this.floatingWidget.querySelector('#widget-progress');
    progressSection.style.display = 'none';
  }

  // Update progress
  updateProgress(data) {
    const progressFill = this.floatingWidget.querySelector('#widget-progressFill');
    const progressText = this.floatingWidget.querySelector('#widget-progressText');

    if (progressFill && progressText) {
      const progress = Math.max(0, Math.min(100, data.progress || 0)); // Ensure progress is between 0-100
      progressFill.style.width = `${progress}%`;
      progressText.textContent = data.message || 'Processing...';
    }
  }

  // Update widget progress from background messages
  updateWidgetProgress(data) {
    if (this.floatingWidget) {
      this.updateProgress(data);
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

  // Update toggle button to show scanning state
  updateToggleButtonScanning(isScanning, progress = 0) {
    if (!this.toggleButton) {
      return;
    }

    if (isScanning) {
      this.toggleButton.classList.add('scanning');
      this.toggleButton.innerHTML = '⏳';
      this.toggleButton.title = `Package Tracker - Scanning... ${Math.round(progress)}%`;
    } else {
      this.toggleButton.classList.remove('scanning');
      this.toggleButton.innerHTML = '📦';
      this.toggleButton.title = 'Toggle Package Tracker';
    }
  }
}

// Initialize the Gmail content script
new GmailContentScript();