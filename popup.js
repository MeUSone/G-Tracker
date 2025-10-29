// Gmail Package Tracker Popup
import { MESSAGE_TYPES, UI_CONFIG, PACKAGE_CONFIG } from './constants.js';

class PopupController {
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
    this.elements = {
      resultArea: document.getElementById('resultArea'),
      // Subscription tracking elements
      scanSubscriptionsBtn: document.getElementById('scanSubscriptionsBtn'),
      subscriptionProgressSection: document.getElementById('subscriptionProgressSection'),
      subscriptionProgressFill: document.getElementById('subscriptionProgressFill'),
      subscriptionProgressText: document.getElementById('subscriptionProgressText'),
      subscriptionResults: document.getElementById('subscriptionResults'),
      // Package tracking elements
      startDate: document.getElementById('startDate'),
      endDate: document.getElementById('endDate'),
      scanPackagesBtn: document.getElementById('scanPackagesBtn'),
      progressSection: document.getElementById('progressSection'),
      progressFill: document.getElementById('progressFill'),
      progressText: document.getElementById('progressText'),
      packagesList: document.getElementById('packagesList')
    };

    this.init();
  }

  async init() {
    // Subscription tracking handlers
    this.elements.scanSubscriptionsBtn.addEventListener('click', () => this.handleScanSubscriptions());

    // Package tracking handlers
    this.elements.scanPackagesBtn.addEventListener('click', () => this.handleScanPackages());

    // Initialize date inputs with defaults
    this.elements.startDate.value = PACKAGE_CONFIG.DEFAULT_START_DATE;
    this.elements.endDate.value = PACKAGE_CONFIG.DEFAULT_END_DATE;

    // Listen for progress updates
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === MESSAGE_TYPES.PROGRESS_UPDATE) {
        // Determine if this is a subscription or package scan
        const isSubscriptionScan = message.data.scanType === 'subscription' ||
          message.data.step === 'subscription_scan' ||
          (message.data.message && (
            message.data.message.includes('subscription') ||
            message.data.message.includes('Subscription')
          ));

        console.log('Popup PROGRESS_UPDATE - scanType:', message.data.scanType, 'step:', message.data.step, 'message:', message.data.message, 'isSubscriptionScan:', isSubscriptionScan);

        // Handle cleanup message
        if (message.data.scanType === 'cleanup' || message.data.step === 'cleanup') {
          console.log('Popup: Received cleanup message - resetting all scan states');
          this.resetAllScanStates();
          return;
        }
      }

      if (message.type === MESSAGE_TYPES.CLEANUP_SCAN_STATES) {
        console.log('Popup: Received cleanup scan states message');
        this.resetAllScanStates();
        return;
      }

      if (message.type === MESSAGE_TYPES.PROGRESS_UPDATE) {
        if (isSubscriptionScan) {
          // Handle subscription progress
          console.log('Popup: Updating subscription progress via PROGRESS_UPDATE');
          this.updateSubscriptionProgress(message.data);

          // If scanning is complete, reset subscription UI and reload results
          if (message.data.step === 'complete' || message.data.step === 'error') {
            setTimeout(() => {
              this.elements.scanSubscriptionsBtn.disabled = false;
              this.elements.scanSubscriptionsBtn.textContent = '🔍 Scan My Current Month Subscriptions';
              if (message.data.step === 'complete') {
                this.hideSubscriptionProgress();
                this.loadSubscriptionsFromDB();
              }
            }, 2000);
          }
        } else {
          // Handle package progress
          console.log('Popup: Updating package progress via PROGRESS_UPDATE');
          this.updateProgress(message.data);

          // If scanning is complete, reset package UI
          if (message.data.step === 'complete' || message.data.step === 'error') {
            setTimeout(() => {
              this.elements.scanPackagesBtn.disabled = false;
              this.elements.scanPackagesBtn.textContent = '🔍 Scan for Package Deliveries';
              if (message.data.step === 'complete') {
                this.hideProgress();
                this.loadUnpickedPackages();
              }
            }, 2000); // Give user time to see the completion message
          }
        }
      }

      if (message.type === 'SCANNING_STATE_CHANGED') {
        const { isScanning, progress, message: statusMessage, step, scanType } = message.data;

        // Determine scan type and apply appropriate state
        const isSubscriptionScan = scanType === 'subscription' ||
          step === 'subscription_scan' ||
          (statusMessage && statusMessage.includes('subscription'));

        console.log('Popup SCANNING_STATE_CHANGED - scanType:', scanType, 'step:', step, 'isSubscriptionScan:', isSubscriptionScan);

        // Apply state to appropriate scan type only
        if (isSubscriptionScan) {
          this.applySubscriptionScanningState(isScanning, progress, statusMessage, step);
        } else {
          this.applyPackageScanningState(isScanning, progress, statusMessage, step);
        }

        if (!isScanning) {
          if (step === 'complete') {
            if (isSubscriptionScan) {
              this.loadSubscriptionsFromDB();
            } else {
              this.loadUnpickedPackages();
            }
          } else if (step === 'error') {
            this.showResult(statusMessage);
          }
        }
      }
    });

    // Check if scanning is already in progress
    await this.checkScanningState();

    // Load unpicked packages on startup
    this.loadUnpickedPackages();

    // Load subscriptions from IndexedDB on startup (like packages)
    await this.loadSubscriptionsFromDB();

    // Load subscription results from chrome storage on startup (fallback)
    this.loadSubscriptionResults();

    // Load progress state to restore any active scans
    this.loadProgressState();

    // Show scan optimization info
    this.showScanOptimizationInfo();
  }

  showResult(text) {
    this.elements.resultArea.textContent = text;
    this.elements.resultArea.classList.add(UI_CONFIG.RESULT_AREA_CLASSES.VISIBLE);

    // Clear the result after 5 seconds
    setTimeout(() => {
      this.clearResult();
    }, 5000);
  }

  clearResult() {
    this.elements.resultArea.textContent = '';
    this.elements.resultArea.classList.remove(UI_CONFIG.RESULT_AREA_CLASSES.VISIBLE);
  }

  /**
   * Handle scan subscriptions button click
   */
  async handleScanSubscriptions() {
    try {
      // Check if already scanning by button state
      if (this.elements.scanSubscriptionsBtn.disabled) {
        this.showResult('Subscription scan already in progress. Please wait for it to complete.');
        return;
      }

      // First check if subscription scanning is already in progress
      const stateResponse = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.GET_SCANNING_STATE
      });

      if (stateResponse && stateResponse.success && stateResponse.subscriptionScanningState?.isScanning) {
        this.showResult('Subscription scan already in progress. Please wait for it to complete.');
        return;
      }

      // Clear result messages but keep existing subscription results visible during scan
      this.clearResult();

      // Disable button and show progress immediately
      this.elements.scanSubscriptionsBtn.disabled = true;
      this.elements.scanSubscriptionsBtn.textContent = 'Scanning...';
      this.showSubscriptionProgress();

      // Show immediate progress update
      this.updateSubscriptionProgress({
        step: 'subscription_scan',
        progress: 0,
        message: 'Starting subscription scan...'
      });

      // Start polling for progress updates
      this.startProgressPolling('subscription');

      // Notify content scripts that scanning started
      this.notifyContentScripts('SCAN_STARTED', { scanType: 'subscription' });

      // Destroy any existing LLM session to start fresh
      this.updateSubscriptionProgress({ progress: 5, message: 'Preparing LLM session...' });
      try {
        await chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.DESTROY_LLM_SESSION
        });
        console.log('Existing LLM session destroyed');
      } catch (sessionError) {
        console.warn('Failed to destroy session:', sessionError);
        // Continue anyway
      }

      const response = await this.sendMessageSafely({
        type: MESSAGE_TYPES.SCAN_SUBSCRIPTION_EMAILS
      });

      console.log('Subscription scan response:', response);

      if (response.success) {
        console.log('Events received:', response.events);
        console.log('Events length:', response.events.length);
        console.log('First event structure:', response.events[0]);
        this.showResult(`Subscription scan complete! Created ${response.events.length} calendar reminders`);
        // Store results for persistence first
        await this.storeSubscriptionResults(response.events);
        // Reload subscriptions from IndexedDB to show updated subscriptions (like packages do)
        await this.loadSubscriptionsFromDB();
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

      // Stop progress polling
      this.stopProgressPolling();

      // Notify content scripts that scanning stopped
      this.notifyContentScripts('SCAN_STOPPED', { scanType: 'subscription' });
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
        this.elements.scanSubscriptionsBtn.disabled = false;
        this.elements.scanSubscriptionsBtn.textContent = '🔍 Scan My Current Month Subscriptions';
        this.hideSubscriptionProgress();
      }, 1000);
    }
  }

  /**
   * Handle scan packages button click
   */
  async handleScanPackages() {
    try {
      // Check if already scanning by button state
      if (this.elements.scanPackagesBtn.disabled) {
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

      const startDate = this.elements.startDate.value;
      const endDate = this.elements.endDate.value;

      if (!startDate || !endDate) {
        this.showResult('Please select both start and end dates');
        return;
      }

      // Disable button and show progress immediately
      this.elements.scanPackagesBtn.disabled = true;
      this.elements.scanPackagesBtn.textContent = 'Scanning...';
      this.showProgress();

      // Show immediate progress update
      this.updateProgress({
        step: 'package_scan',
        progress: 0,
        message: 'Starting package scan...'
      });

      // Start polling for progress updates
      this.startProgressPolling('package');

      // Notify content scripts that scanning started
      this.notifyContentScripts('SCAN_STARTED', { scanType: 'package' });

      // Destroy any existing LLM session to start fresh
      this.updateProgress({ progress: 5, message: 'Preparing LLM session...' });
      try {
        await chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.DESTROY_LLM_SESSION
        });
        console.log('Existing LLM session destroyed');
      } catch (sessionError) {
        console.warn('Failed to destroy session:', sessionError);
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

      // Stop progress polling
      this.stopProgressPolling();

      // Notify content scripts that scanning stopped
      this.notifyContentScripts('SCAN_STOPPED', { scanType: 'package' });
    } catch (error) {
      this.showResult(`Error: ${error.message}`);
    } finally {
      // Re-enable button
      this.elements.scanPackagesBtn.disabled = false;
      this.elements.scanPackagesBtn.textContent = '🔍 Scan for Package Deliveries';
      this.hideProgress();
    }
  }

  /**
   * Load and display unpicked packages
   */
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

  /**
   * Load and display subscriptions from IndexedDB
   */
  async loadSubscriptionsFromDB() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.GET_SUBSCRIPTIONS
      });

      if (response && response.success && response.subscriptions) {
        console.log('Loaded subscriptions from IndexedDB:', response.subscriptions);
        // Convert subscriptions to events format for display
        const events = response.subscriptions.map(sub => ({
          subscriptionName: sub.serviceName || sub.subscriptionName || 'Unknown Service',
          amount: sub.amount || 'N/A',
          reminderDate: sub.nextBillingDate || sub.reminderDate || 'N/A',
          // Include original subscription data
          ...sub
        }));

        if (events.length > 0) {
          this.displaySubscriptionResults(events);
          // Store results for persistence (with current timestamp)
          await this.storeSubscriptionResults(events);
        }
      } else {
        console.log('No subscriptions found in IndexedDB or failed to load:', response?.error);
      }
    } catch (error) {
      console.error('Load subscriptions from DB error:', error);
    }
  }

  /**
   * Display packages in the UI grouped by month
   */
  displayPackages(packages) {
    const container = this.elements.packagesList;
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

  /**
   * Group packages by month
   */
  groupPackagesByMonth(packages) {
    const grouped = {};

    packages.forEach(pkg => {
      // Use the correct field name from the database schema
      const deliveryDate = new Date(pkg.deliveryTime);
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

  /**
   * Create month group element
   */
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

  /**
   * Create package element
   */
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
      chrome.tabs.create({ url: gmailUrl });
    });

    pickupBtn.addEventListener('click', () => this.handleMarkAsPickedUp(pkg.id));

    return element;
  }



  /**
   * Handle mark as picked up
   */
  async handleMarkAsPickedUp(packageId) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.MARK_PACKAGE_PICKED_UP,
        packageId
      });

      if (response.success) {
        // Reload packages to update display
        await this.loadUnpickedPackages();
        this.showResult('Package marked as picked up!');
      } else {
        this.showResult(`Error: ${response.error}`);
      }
    } catch (error) {
      this.showResult(`Error: ${error.message}`);
    }
  }

  /**
   * Show progress section
   */
  showProgress() {
    console.log('Popup: Showing package progress bar');
    this.elements.progressSection.style.display = 'block';
    this.updateProgress({ progress: 0, message: 'Initializing...' });
  }

  /**
   * Hide progress section
   */
  hideProgress() {
    this.elements.progressSection.style.display = 'none';
  }

  /**
   * Update progress display
   */
  updateProgress(data) {
    if (this.elements.progressFill && this.elements.progressText) {
      const progress = Math.max(0, Math.min(100, data.progress || 0)); // Ensure progress is between 0-100
      this.elements.progressFill.style.width = `${progress}%`;
      this.elements.progressText.textContent = data.message || 'Processing...';

      // Store progress state for persistence
      this.storePackageProgressState(data);
    }
  }

  /**
   * Store package progress state
   */
  async storePackageProgressState(data) {
    try {
      const progressState = {
        ...data,
        timestamp: Date.now()
      };
      await chrome.storage.local.set({ 'packageProgressState': progressState });
    } catch (error) {
      console.error('Failed to store package progress state:', error);
    }
  }

  /**
   * Check if scanning is already in progress
   */
  async checkScanningState() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.GET_SCANNING_STATE
      });

      if (response.success) {
        const subscriptionActive = response.subscriptionScanningState?.isScanning || false;
        const packageActive = response.packageScanningState?.isScanning || false;

        console.log('Popup checkScanningState - subscriptionActive:', subscriptionActive, 'packageActive:', packageActive);

        // Apply subscription scanning state
        if (subscriptionActive) {
          const state = response.subscriptionScanningState;
          console.log('Popup: Applying subscription scanning state');
          this.applySubscriptionScanningState(true, state.progress, state.message, state.step, state.options);
        } else {
          this.applySubscriptionScanningState(false);
        }

        // Apply package scanning state
        if (packageActive) {
          const state = response.packageScanningState;
          console.log('Popup: Applying package scanning state');
          this.applyPackageScanningState(true, state.progress, state.message, state.step, state.options);
        } else {
          this.applyPackageScanningState(false);
        }
      } else {
        this.applySubscriptionScanningState(false);
        this.applyPackageScanningState(false);
      }
    } catch (error) {
      this.applySubscriptionScanningState(false);
      this.applyPackageScanningState(false);
    }
  }

  /**
   * Apply subscription scanning state to UI
   */
  applySubscriptionScanningState(isScanning, progress = 0, message = '', step = '', options = null) {
    if (isScanning) {
      this.elements.scanSubscriptionsBtn.disabled = true;
      this.elements.scanSubscriptionsBtn.textContent = 'Scanning...';
      this.showSubscriptionProgress();
      this.updateSubscriptionProgress({ progress, message, step });

      // Start progress polling to keep UI updated
      this.startProgressPolling('subscription');
    } else {
      this.elements.scanSubscriptionsBtn.disabled = false;
      this.elements.scanSubscriptionsBtn.textContent = '🔍 Scan My Current Month Subscriptions';
      this.hideSubscriptionProgress();

      // Stop progress polling
      this.stopProgressPolling();
    }
  }

  /**
   * Apply package scanning state to UI
   */
  applyPackageScanningState(isScanning, progress = 0, message = '', step = '', options = null) {
    if (isScanning) {
      this.elements.scanPackagesBtn.disabled = true;
      this.elements.scanPackagesBtn.textContent = 'Scanning...';
      this.showProgress();
      this.updateProgress({ progress, message, step });

      // Restore date inputs if options available
      if (options) {
        this.elements.startDate.value = options.startDate || this.elements.startDate.value;
        this.elements.endDate.value = options.endDate || this.elements.endDate.value;
      }

      // Start progress polling to keep UI updated
      this.startProgressPolling('package');
    } else {
      this.elements.scanPackagesBtn.disabled = false;
      this.elements.scanPackagesBtn.textContent = '🔍 Scan for Package Deliveries';
      this.hideProgress();

      // Stop progress polling
      this.stopProgressPolling();
    }
  }

  /**
   * Apply scanning state to UI (backward compatibility)
   */
  applyScanningState(isScanning, progress = 0, message = '', step = '', options = null) {
    // For backward compatibility, apply to package scanning
    this.applyPackageScanningState(isScanning, progress, message, step, options);
  }

  /**
   * Reset all scan states (called on extension reload/cleanup)
   */
  resetAllScanStates() {
    // Stop any active progress polling
    this.stopProgressPolling();

    // Reset subscription scan state
    this.elements.scanSubscriptionsBtn.disabled = false;
    this.elements.scanSubscriptionsBtn.textContent = '🔍 Scan My Current Month Subscriptions';
    this.hideSubscriptionProgress();

    // Reset package scan state
    this.elements.scanPackagesBtn.disabled = false;
    this.elements.scanPackagesBtn.textContent = '🔍 Scan for Package Deliveries';
    this.hideProgress();

    // Clear stored progress states
    chrome.storage.local.remove(['progressState', 'subscriptionProgressState', 'packageProgressState', 'currentSubscriptionProgress', 'currentPackageProgress']).catch(() => {
      // Ignore errors
    });

    // Clear any result messages
    this.showResult('Extension reloaded - scan states reset');

    console.log('Popup: All scan states reset');
  }

  /**
   * Show subscription progress section
   */
  showSubscriptionProgress() {
    console.log('Popup: Showing subscription progress bar');
    this.elements.subscriptionProgressSection.style.display = 'block';
    this.updateSubscriptionProgress({ progress: 0, message: 'Initializing...' });
  }

  /**
   * Hide subscription progress section
   */
  hideSubscriptionProgress() {
    this.elements.subscriptionProgressSection.style.display = 'none';
  }

  /**
   * Update subscription progress display
   */
  updateSubscriptionProgress(data) {
    if (this.elements.subscriptionProgressFill && this.elements.subscriptionProgressText) {
      const progress = Math.max(0, Math.min(100, data.progress || 0)); // Ensure progress is between 0-100
      this.elements.subscriptionProgressFill.style.width = `${progress}%`;
      this.elements.subscriptionProgressText.textContent = data.message || 'Processing...';

      // Store progress state for persistence
      this.storeSubscriptionProgressState(data);
    }
  }

  /**
   * Store subscription progress state
   */
  async storeSubscriptionProgressState(data) {
    try {
      const progressState = {
        ...data,
        timestamp: Date.now()
      };
      await chrome.storage.local.set({ 'subscriptionProgressState': progressState });
    } catch (error) {
      console.error('Failed to store subscription progress state:', error);
    }
  }

  /**
   * Store subscription results in chrome storage
   */
  async storeSubscriptionResults(events) {
    try {
      await chrome.storage.local.set({
        'subscriptionResults': events,
        'subscriptionResultsTimestamp': Date.now()
      });
    } catch (error) {
      console.error('Failed to store subscription results:', error);
    }
  }

  /**
   * Load subscription results from chrome storage
   */
  async loadSubscriptionResults() {
    try {
      const result = await chrome.storage.local.get(['subscriptionResults', 'subscriptionResultsTimestamp']);

      console.log('Popup loading subscription results:', result);

      if (result.subscriptionResults && result.subscriptionResultsTimestamp) {
        // Show results if they're less than 7 days old (similar to how packages persist)
        const sevenDays = 31 * 24 * 60 * 60 * 1000;
        const age = Date.now() - result.subscriptionResultsTimestamp;
        console.log(`Popup subscription results age: ${Math.round(age / (60 * 60 * 1000))} hours`);

        if (age < sevenDays) {
          console.log('Popup displaying stored subscription results:', result.subscriptionResults);
          this.displaySubscriptionResults(result.subscriptionResults);
        } else {
          console.log('Popup subscription results expired, not displaying');
        }
      } else {
        console.log('Popup no subscription results found in storage');
      }
    } catch (error) {
      console.error('Failed to load subscription results:', error);
    }
  }

  /**
   * Display subscription results
   */
  displaySubscriptionResults(events) {
    console.log('Displaying subscription results:', events);
    const container = this.elements.subscriptionResults;
    console.log('Subscription results container:', container);

    if (!container) {
      console.error('Subscription results container not found!');
      return;
    }

    container.innerHTML = '';

    if (events.length === 0) {
      container.innerHTML = '<div style="text-align: center; color: #5f6368; font-style: italic; padding: 16px;">No subscription emails found this month</div>';
      return;
    }

    events.forEach((event, index) => {
      console.log(`Event ${index}:`, event);
      const item = document.createElement('div');
      item.className = 'subscription-item';

      item.innerHTML = `
        <div class="subscription-name">${event.subscriptionName || 'Unknown Service'}</div>
        <div class="subscription-amount">Amount: ${event.amount || 'N/A'}</div>
        <div class="subscription-reminder">Reminder set for: ${event.reminderDate}</div>
      `;

      container.appendChild(item);
    });

    // Store the results for persistence
    this.storeSubscriptionResults(events);
  }

  /**
   * Load and restore progress state
   */
  async loadProgressState() {
    try {
      const result = await chrome.storage.local.get(['subscriptionProgressState', 'packageProgressState']);

      console.log('Popup loading progress state:', result);

      // Check subscription progress
      if (result.subscriptionProgressState) {
        const state = result.subscriptionProgressState;
        const fiveMinutes = 5 * 60 * 1000;
        const age = Date.now() - state.timestamp;

        console.log(`Popup subscription progress age: ${Math.round(age / 1000)} seconds, step: ${state.step}`);

        // Only restore if less than 5 minutes old and not complete
        if (age < fiveMinutes && state.step !== 'complete' && state.step !== 'error') {
          console.log('Popup restoring subscription progress:', state);
          this.elements.scanSubscriptionsBtn.disabled = true;
          this.elements.scanSubscriptionsBtn.textContent = 'Scanning...';
          this.showSubscriptionProgress();
          this.updateSubscriptionProgress(state);
        }
      }

      // Check package progress
      if (result.packageProgressState) {
        const state = result.packageProgressState;
        const fiveMinutes = 5 * 60 * 1000;
        const age = Date.now() - state.timestamp;

        console.log(`Popup package progress age: ${Math.round(age / 1000)} seconds, step: ${state.step}`);

        // Only restore if less than 5 minutes old and not complete
        if (age < fiveMinutes && state.step !== 'complete' && state.step !== 'error') {
          console.log('Popup restoring package progress:', state);
          this.elements.scanPackagesBtn.disabled = true;
          this.elements.scanPackagesBtn.textContent = 'Scanning...';
          this.showProgress();
          this.updateProgress(state);
        }
      }

      if (!result.subscriptionProgressState && !result.packageProgressState) {
        console.log('Popup no progress state found in storage');
      }
    } catch (error) {
      console.error('Popup failed to load progress state:', error);
    }
  }

  /**
   * Notify content scripts of scan state changes
   */
  async notifyContentScripts(type, data) {
    try {
      const tabs = await chrome.tabs.query({});
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type, data }).catch(() => {
          // Ignore errors if content script not available
        });
      });
    } catch (error) {
      // Ignore errors
    }
  }

  /**
   * Start polling for progress updates
   */
  startProgressPolling(scanType) {
    // Stop any existing polling first
    this.stopProgressPolling();

    this.progressPollingInterval = setInterval(async () => {
      try {
        const storageKey = scanType === 'subscription' ? 'currentSubscriptionProgress' : 'currentPackageProgress';
        const result = await chrome.storage.local.get(storageKey);

        if (result[storageKey]) {
          const progressData = result[storageKey];

          if (scanType === 'subscription') {
            this.updateSubscriptionProgress(progressData);
          } else {
            this.updateProgress(progressData);
          }

          // Stop polling if scan is complete or errored
          if (progressData.step === 'complete' || progressData.step === 'error') {
            this.stopProgressPolling();

            // Handle completion for subscription scans
            if (scanType === 'subscription') {
              setTimeout(() => {
                this.elements.scanSubscriptionsBtn.disabled = false;
                this.elements.scanSubscriptionsBtn.textContent = '🔍 Scan My Current Month Subscriptions';
                this.hideSubscriptionProgress();
                if (progressData.step === 'complete') {
                  this.loadSubscriptionsFromDB();
                }
              }, 2000);
            }
          }
        } else {
          // No progress data found, stop polling
          this.stopProgressPolling();
        }
      } catch (error) {
        console.error('Progress polling error:', error);
      }
    }, 1000); // Poll every second
  }

  /**
   * Stop progress polling
   */
  stopProgressPolling() {
    if (this.progressPollingInterval) {
      clearInterval(this.progressPollingInterval);
      this.progressPollingInterval = null;
    }
  }

  /**
   * Show scan optimization information
   */
  async showScanOptimizationInfo() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.GET_SCAN_HISTORY
      });

      if (response.success && response.scanHistory.length > 0) {
        const latestScan = response.scanHistory[0];
        const scanDate = new Date(latestScan.scanDate).toLocaleDateString();
        const emailsScanned = latestScan.emailsScanned;

        // Add a small info text below the scan button
        const infoElement = document.createElement('div');
        infoElement.className = 'scan-info';
        infoElement.innerHTML = `
          <small>💡 Last scan: ${scanDate} (${emailsScanned} emails checked)</small>
        `;

        const scanButton = this.elements.scanPackagesBtn;
        scanButton.parentNode.insertBefore(infoElement, scanButton.nextSibling);
      }
    } catch (error) {
      console.log('Could not load scan history info:', error);
      // Don't show error to user, this is just optimization info
    }
  }


}

// Initialize popup controller when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new PopupController();
});