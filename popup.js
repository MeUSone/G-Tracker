// Gmail Package Tracker Popup
import { MESSAGE_TYPES, UI_CONFIG, PACKAGE_CONFIG } from './constants.js';

class PopupController {
  constructor() {
    this.elements = {
      resultArea: document.getElementById('resultArea'),
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
    // Package tracking handlers
    this.elements.scanPackagesBtn.addEventListener('click', () => this.handleScanPackages());

    // Initialize date inputs with defaults
    this.elements.startDate.value = PACKAGE_CONFIG.DEFAULT_START_DATE;
    this.elements.endDate.value = PACKAGE_CONFIG.DEFAULT_END_DATE;

    // Listen for progress updates
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === MESSAGE_TYPES.PROGRESS_UPDATE) {
        this.updateProgress(message.data);
        
        // If scanning is complete, reset UI
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

      if (message.type === 'SCANNING_STATE_CHANGED') {
        const { isScanning, progress, message: statusMessage, step } = message.data;
        this.applyScanningState(isScanning, progress, statusMessage, step);
        
        if (!isScanning) {
          if (step === 'complete') {
            this.loadUnpickedPackages();
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
    
    // Show scan optimization info
    this.showScanOptimizationInfo();
  }

  showResult(text) {
    this.elements.resultArea.textContent = text;
    this.elements.resultArea.classList.add(UI_CONFIG.RESULT_AREA_CLASSES.VISIBLE);
  }

  /**
   * Handle scan packages button click
   */
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

      const startDate = this.elements.startDate.value;
      const endDate = this.elements.endDate.value;

      if (!startDate || !endDate) {
        this.showResult('Please select both start and end dates');
        return;
      }

      // Disable button and show progress
      this.elements.scanPackagesBtn.disabled = true;
      this.elements.scanPackagesBtn.textContent = 'Scanning...';
      this.showProgress();

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

      if (response.success) {
        this.displayPackages(response.packages);
      } else {
        console.error('Failed to load packages:', response.error);
      }
    } catch (error) {
      console.error('Load packages error:', error);
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

  /**
   * Apply scanning state to UI
   */
  applyScanningState(isScanning, progress = 0, message = '', step = '', options = null) {
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
    } else {
      this.elements.scanPackagesBtn.disabled = false;
      this.elements.scanPackagesBtn.textContent = '🔍 Scan for Package Deliveries';
      this.hideProgress();
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