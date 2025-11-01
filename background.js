// Core Gmail Order Tracker - Essential Functions Only
import {
  GMAIL_API,
  CALENDAR_API,
  SEARCH_QUERIES,
  LLM_CONFIG,
  ERROR_MESSAGES,
  MESSAGE_TYPES,
  PACKAGE_CONFIG,
  PACKAGE_SCHEMA,
  SUBSCRIPTION_SCHEMA,
  SCAN_HISTORY_SCHEMA,
  SUBSCRIPTION_SCAN_HISTORY_SCHEMA,
  SUBSCRIPTION_CALENDAR_EVENTS_SCHEMA,
  SUBSCRIPTION_CONFIG
} from './constants.js';

// Service worker startup log
console.log('Package Tracker service worker starting...');

// Keep service worker alive
let keepAliveInterval;

function keepServiceWorkerAlive() {
  keepAliveInterval = setInterval(() => {
    console.log('Service worker keepalive ping');
  }, 20000); // Ping every 20 seconds
}

// Service worker event listeners
self.addEventListener('install', (event) => {
  console.log('Service worker installing...');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('Service worker activating...');
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      cleanupOnStartup()
    ])
  );

  // Start keepalive
  keepServiceWorkerAlive();
});

/**
 * Cleanup function to reset scanning states when extension is reloaded
 */
async function cleanupOnStartup() {
  try {
    console.log('Performing startup cleanup...');

    // Reset all scanning states
    const cleanState = {
      isScanning: false,
      progress: 0,
      message: '',
      step: '',
      startTime: null,
      options: null
    };

    // Reset both scanning states
    subscriptionScanningState = { ...cleanState };
    packageScanningState = { ...cleanState };

    // Clear stored scanning states
    await chrome.storage.local.remove(['subscriptionScanningState', 'packageScanningState']);

    // Destroy any existing LLM session
    try {
      if (typeof llmExtractor !== 'undefined' && llmExtractor) {
        await llmExtractor.destroySession();
        console.log('LLM session destroyed during cleanup');
      }
    } catch (error) {
      console.warn('Error destroying LLM session during cleanup:', error);
    }

    // Send cleanup message to all tabs to reset UI
    const tabs = await chrome.tabs.query({});
    const cleanupMessage = {
      type: MESSAGE_TYPES.CLEANUP_SCAN_STATES,
      data: {
        step: 'cleanup',
        progress: 0,
        message: 'Extension reloaded - resetting scan states',
        scanType: 'cleanup'
      }
    };

    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, cleanupMessage).catch(() => {
        // Ignore errors if content script not available
      });
    });

    // Also send to popup if open
    chrome.runtime.sendMessage(cleanupMessage).catch(() => {
      // Ignore errors if popup is closed
    });

    console.log('Startup cleanup completed');
  } catch (error) {
    console.error('Error during startup cleanup:', error);
  }
}

/**
 * Gmail API integration class for searching and fetching emails
 */
class GmailScanner {
  constructor() {
  }

  /**
   * Get OAuth token for Gmail API access
   */
  async getAuthToken() {
    return new Promise((resolve, reject) => {
      if (!chrome.identity) {
        reject(new Error(ERROR_MESSAGES.CHROME_IDENTITY_UNAVAILABLE));
        return;
      }

      chrome.identity.getAuthToken({ interactive: true }, (token) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!token) {
          reject(new Error(ERROR_MESSAGES.NO_AUTH_TOKEN));
        } else {
          resolve(token);
        }
      });
    });
  }

  /**
   * Function for scanning through all Gmails with pagination support
   */
  async searchEmails(options = {}) {
    const { newerThan = null, olderThan = null } = options;

    try {
      const token = await this.getAuthToken();
      let query = this.buildSearchQuery(newerThan, olderThan);

      let allEmailIds = [];
      let nextPageToken = null;
      const pageSize = GMAIL_API.MAX_RESULTS_PER_PAGE;

      do {
        let url = `${GMAIL_API.BASE_URL}/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${pageSize}`;

        if (nextPageToken) {
          url += `&pageToken=${nextPageToken}`;
        }

        const response = await this.makeGmailRequest(url, token);

        if (response.messages) {
          const emailIds = response.messages.map(msg => msg.id);
          allEmailIds.push(...emailIds);
        }

        nextPageToken = response.nextPageToken;

        // Add a small delay between requests to avoid rate limiting
        if (nextPageToken) {
          await new Promise(resolve => setTimeout(resolve, GMAIL_API.REQUEST_DELAY_MS));
        }

      } while (nextPageToken);

      return allEmailIds;
    } catch (error) {
      console.error('Gmail search error:', error);
      throw new Error(`${ERROR_MESSAGES.GMAIL_SEARCH_FAILED}: ${error.message}`);
    }
  }

  /**
   * Build Gmail search query with date filters
   */
  buildSearchQuery(newerThan, olderThan) {
    let query = "";

    if (newerThan) {
      const date = new Date(newerThan);
      const dateStr = date.toISOString().split('T')[0].replace(/-/g, '/');
      query += ` after:${dateStr}`;
    }

    if (olderThan) {
      const date = new Date(olderThan);
      const dateStr = date.toISOString().split('T')[0].replace(/-/g, '/');
      query += ` before:${dateStr}`;
    }

    query += ` ${SEARCH_QUERIES.SPAM_FILTER}`;
    return query;
  }

  /**
   * Function for reading the whole content of a gmail
   */
  async fetchEmail(emailId) {
    try {
      const token = await this.getAuthToken();
      let url = `${GMAIL_API.BASE_URL}/users/me/messages/${emailId}?format=full`;
      const response = await this.makeGmailRequest(url, token);
      return this.parseEmailResponse(response);
    } catch (error) {
      console.error(`Failed to fetch email ${emailId}:`, error);
      throw error;
    }
  }

  /**
   * Parse Gmail API email response
   */
  parseEmailResponse(response) {
    const email = {
      id: response.id,
      threadId: response.threadId,
      subject: '',
      from: '',
      date: '',
      body: '',
      snippet: response.snippet || ''
    };

    // Extract headers
    if (response.payload && response.payload.headers) {
      response.payload.headers.forEach(header => {
        switch (header.name.toLowerCase()) {
          case 'subject':
            email.subject = header.value;
            break;
          case 'from':
            email.from = header.value;
            break;
          case 'date':
            email.date = header.value;
            break;
        }
      });
    }

    // Extract body content
    email.body = this.extractEmailBody(response.payload);
    return email;
  }

  /**
   * Extract email body from payload
   */
  extractEmailBody(payload) {
    if (!payload) return '';

    let allContent = '';

    // Handle multipart messages
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
          const content = this.decodeEmailBody(part.body);
          if (content) {
            allContent += content + '\n\n';
          }
        } else if (part.parts) {
          const nestedContent = this.extractEmailBody(part);
          if (nestedContent) {
            allContent += nestedContent + '\n\n';
          }
        }
      }
    }

    // Handle single part messages
    if (payload.body && payload.body.data) {
      const content = this.decodeEmailBody(payload.body);
      if (content) {
        allContent += content;
      }
    }

    // Fallback to snippet if no content found
    if (!allContent && payload.snippet) {
      allContent = payload.snippet;
    }

    return allContent.trim();
  }

  /**
   * Decode base64url encoded email body
   */
  decodeEmailBody(body) {
    if (!body || !body.data) return '';

    try {
      const base64 = body.data.replace(/-/g, '+').replace(/_/g, '/');
      const padding = '='.repeat((4 - base64.length % 4) % 4);
      return atob(base64 + padding);
    } catch (error) {
      console.error('Failed to decode email body:', error);
      return '';
    }
  }

  /**
   * Make authenticated request to Gmail API
   */
  async makeGmailRequest(url, token) {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.error?.message || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    return response.json();
  }
}

/**
 * Google Calendar API integration class for creating events
 */
class CalendarManager {
  constructor() {
    this.calendarId = CALENDAR_API.DEFAULT_CALENDAR_ID;
  }

  /**
   * Get OAuth token for Calendar API access
   */
  async getAuthToken() {
    return new Promise((resolve, reject) => {
      if (!chrome.identity) {
        reject(new Error(ERROR_MESSAGES.CHROME_IDENTITY_UNAVAILABLE));
        return;
      }

      chrome.identity.getAuthToken({ interactive: true }, (token) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!token) {
          reject(new Error(ERROR_MESSAGES.NO_AUTH_TOKEN));
        } else {
          resolve(token);
        }
      });
    });
  }

  /**
   * Function for creating event in calendar
   */
  async createEvent(eventData) {
    try {
      const token = await this.getAuthToken();

      const event = {
        summary: eventData.title || 'Event',
        start: {
          date: eventData.date || new Date().toISOString().split('T')[0]
        },
        end: {
          date: eventData.date || new Date().toISOString().split('T')[0]
        },
        description: eventData.description || '',
        transparency: 'transparent'
      };

      const url = `${CALENDAR_API.BASE_URL}/calendars/${this.calendarId}/events`;

      const response = await this.makeCalendarRequest(url, token, {
        method: 'POST',
        body: JSON.stringify(event)
      });

      return response;
    } catch (error) {
      console.error('Failed to create calendar event:', error);
      throw new Error(`${ERROR_MESSAGES.CALENDAR_EVENT_FAILED}: ${error.message}`);
    }
  }

  /**
   * Make authenticated request to Calendar API
   */
  async makeCalendarRequest(url, token, options = {}) {
    const config = {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      ...options
    };

    const response = await fetch(url, config);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.error?.message || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    return response.json();
  }
}

/**
 * LLM Extraction service using LanguageModel API
 */
class LLMExtractor {
  constructor() {
    this.isInitialized = false;
    this.currentSession = null;
  }

  /**
   * Initialize the language model
   */
  async initialize() {
    if (this.isInitialized) return;

    try {
      // Check if LanguageModel API is available
      if (typeof LanguageModel === 'undefined' || !LanguageModel) {
        throw new Error('Chrome AI not available. Please enable "Prompt API for Gemini Nano" in chrome://flags and restart Chrome.');
      }

      const availability = await LanguageModel.availability();
      console.log('LanguageModel availability:', availability);

      if (availability === 'no') {
        throw new Error('Chrome AI not available on this device. Please enable "Prompt API for Gemini Nano" in chrome://flags and restart Chrome.');
      }

      if (availability === 'after-download') {
        throw new Error('Chrome AI model needs to be downloaded first. Please wait for the download to complete and try again.');
      }

      console.log('LLM Extractor initialized with LanguageModel API');
      this.isInitialized = true;
    } catch (error) {
      console.error('Failed to initialize LLM:', error);
      throw new Error(`LLM initialization failed: ${error.message}`);
    }
  }

  /**
   * Destroy existing session if it exists
   */
  async destroySession() {
    try {
      if (this.currentSession) {
        console.log('Destroying existing LLM session');
        await this.currentSession.destroy();
        this.currentSession = null;
      }
    } catch (error) {
      console.error('Failed to destroy LLM session:', error);
      // Continue anyway, just set to null
      this.currentSession = null;
    }
  }

  /**
   * Create or reuse LLM session
   */
  async getSession() {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      const availability = await LanguageModel.availability();
      if (availability !== 'available') {
        throw new Error(`Chrome AI not ready: ${availability}. Please ensure Chrome AI is properly enabled.`);
      }

      // Create new session if none exists
      if (!this.currentSession) {
        console.log('Creating new LLM session');

        // Add timeout to session creation
        const createPromise = LanguageModel.create({
          temperature: LLM_CONFIG.TEMPERATURE,
          topK: LLM_CONFIG.TOP_K,
          initialPrompts: [
            {
              role: 'system',
              content: LLM_CONFIG.SYSTEM_PROMPT
            }
          ]
        });

        this.currentSession = await createPromise;
      }

      return this.currentSession;
    } catch (error) {
      console.error('Failed to get LLM session:', error);
      throw error;
    }
  }

  /**
   * Function for calling the LLM given a prompt
   */
  async callLLM(prompt) {
    try {
      const session = await this.getSession();

      const result = await session.prompt(prompt);
      return result;
    } catch (error) {
      console.error('LLM call failed:', error);
      throw new Error(`${ERROR_MESSAGES.LLM_CALL_FAILED}: ${error.message}`);
    }
  }
}

/**
 * Package Database Manager using IndexedDB
 */
class PackageDatabase {
  constructor() {
    this.db = null;
  }

  /**
   * Initialize IndexedDB database
   */
  async initDB() {
    try {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(PACKAGE_CONFIG.DB_NAME, PACKAGE_CONFIG.DB_VERSION);

        request.onerror = () => {
          console.error('Database error:', request.error);
          reject(new Error(ERROR_MESSAGES.DB_INIT_FAILED));
        };

        request.onsuccess = () => {
          this.db = request.result;
          console.log('Package database initialized');
          resolve(this.db);
        };

        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          const oldVersion = event.oldVersion;
          const newVersion = event.newVersion;

          console.log(`Database upgrade from version ${oldVersion} to ${newVersion}`);

          // Create packages store if it doesn't exist
          if (!db.objectStoreNames.contains(PACKAGE_CONFIG.STORE_NAME)) {
            const store = db.createObjectStore(PACKAGE_CONFIG.STORE_NAME, {
              keyPath: PACKAGE_SCHEMA.ID
            });

            // Create indexes
            store.createIndex(PACKAGE_SCHEMA.USER_EMAIL, PACKAGE_SCHEMA.USER_EMAIL, { unique: false });
            store.createIndex(PACKAGE_SCHEMA.DELIVERY_TIME, PACKAGE_SCHEMA.DELIVERY_TIME, { unique: false });
            store.createIndex(PACKAGE_SCHEMA.EMAIL_ID, PACKAGE_SCHEMA.EMAIL_ID, { unique: false });
          }

          // Create subscriptions store if it doesn't exist
          if (!db.objectStoreNames.contains(PACKAGE_CONFIG.SUBSCRIPTION_STORE_NAME)) {
            const subscriptionStore = db.createObjectStore(PACKAGE_CONFIG.SUBSCRIPTION_STORE_NAME, {
              keyPath: SUBSCRIPTION_SCHEMA.ID
            });

            // Create indexes for subscriptions
            subscriptionStore.createIndex(SUBSCRIPTION_SCHEMA.USER_EMAIL, SUBSCRIPTION_SCHEMA.USER_EMAIL, { unique: false });
            subscriptionStore.createIndex(SUBSCRIPTION_SCHEMA.BILLING_DATE, SUBSCRIPTION_SCHEMA.BILLING_DATE, { unique: false });
            subscriptionStore.createIndex(SUBSCRIPTION_SCHEMA.EMAIL_ID, SUBSCRIPTION_SCHEMA.EMAIL_ID, { unique: false });
          }

          // Create scan history store if it doesn't exist
          if (!db.objectStoreNames.contains(PACKAGE_CONFIG.SCAN_HISTORY_STORE_NAME)) {
            const scanHistoryStore = db.createObjectStore(PACKAGE_CONFIG.SCAN_HISTORY_STORE_NAME, {
              keyPath: SCAN_HISTORY_SCHEMA.ID
            });

            // Create indexes for scan history
            scanHistoryStore.createIndex(SCAN_HISTORY_SCHEMA.SCAN_DATE, SCAN_HISTORY_SCHEMA.SCAN_DATE, { unique: false });
            scanHistoryStore.createIndex(SCAN_HISTORY_SCHEMA.EARLIEST_EMAIL_TIMESTAMP, SCAN_HISTORY_SCHEMA.EARLIEST_EMAIL_TIMESTAMP, { unique: false });
            scanHistoryStore.createIndex(SCAN_HISTORY_SCHEMA.LATEST_EMAIL_TIMESTAMP, SCAN_HISTORY_SCHEMA.LATEST_EMAIL_TIMESTAMP, { unique: false });
          }

          // Create subscription scan history store if it doesn't exist
          if (!db.objectStoreNames.contains(PACKAGE_CONFIG.SUBSCRIPTION_SCAN_HISTORY_STORE_NAME)) {
            const subscriptionScanHistoryStore = db.createObjectStore(PACKAGE_CONFIG.SUBSCRIPTION_SCAN_HISTORY_STORE_NAME, {
              keyPath: SUBSCRIPTION_SCAN_HISTORY_SCHEMA.ID
            });

            // Create indexes for subscription scan history
            subscriptionScanHistoryStore.createIndex(SUBSCRIPTION_SCAN_HISTORY_SCHEMA.SCAN_DATE, SUBSCRIPTION_SCAN_HISTORY_SCHEMA.SCAN_DATE, { unique: false });
            subscriptionScanHistoryStore.createIndex(SUBSCRIPTION_SCAN_HISTORY_SCHEMA.START_DATE, SUBSCRIPTION_SCAN_HISTORY_SCHEMA.START_DATE, { unique: false });
            subscriptionScanHistoryStore.createIndex(SUBSCRIPTION_SCAN_HISTORY_SCHEMA.END_DATE, SUBSCRIPTION_SCAN_HISTORY_SCHEMA.END_DATE, { unique: false });
          }

          // Create subscription calendar events store if it doesn't exist
          if (!db.objectStoreNames.contains(PACKAGE_CONFIG.SUBSCRIPTION_CALENDAR_EVENTS_STORE_NAME)) {
            const subscriptionCalendarEventsStore = db.createObjectStore(PACKAGE_CONFIG.SUBSCRIPTION_CALENDAR_EVENTS_STORE_NAME, {
              keyPath: SUBSCRIPTION_CALENDAR_EVENTS_SCHEMA.ID
            });

            // Create indexes for subscription calendar events
            subscriptionCalendarEventsStore.createIndex(SUBSCRIPTION_CALENDAR_EVENTS_SCHEMA.EMAIL_ID, SUBSCRIPTION_CALENDAR_EVENTS_SCHEMA.EMAIL_ID, { unique: false });
            subscriptionCalendarEventsStore.createIndex(SUBSCRIPTION_CALENDAR_EVENTS_SCHEMA.SUBSCRIPTION_NAME, SUBSCRIPTION_CALENDAR_EVENTS_SCHEMA.SUBSCRIPTION_NAME, { unique: false });
            subscriptionCalendarEventsStore.createIndex(SUBSCRIPTION_CALENDAR_EVENTS_SCHEMA.CREATED_DATE, SUBSCRIPTION_CALENDAR_EVENTS_SCHEMA.CREATED_DATE, { unique: false });
          }

          // Handle version upgrades
          if (oldVersion < 2) {
            console.log('Upgraded database schema to include email details fields');
          }
          if (oldVersion < 3) {
            console.log('Upgraded database schema to include scan history');
          }
          if (oldVersion < 4) {
            console.log('Upgraded database schema to include subscriptions');
          }
          if (oldVersion < 5) {
            console.log('Upgraded database schema to include subscription scan history and calendar events tracking');
          }
        };
      });
    } catch (error) {
      console.error('Failed to initialize database:', error);
      throw error;
    }
  }

  /**
   * Save package to database
   */
  async savePackageToDB(packageData) {
    try {
      if (!this.db) await this.initDB();

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([PACKAGE_CONFIG.STORE_NAME], 'readwrite');
        const store = transaction.objectStore(PACKAGE_CONFIG.STORE_NAME);

        const packageRecord = {
          [PACKAGE_SCHEMA.ID]: `${packageData.emailId}_${Date.now()}`,
          [PACKAGE_SCHEMA.USER_EMAIL]: packageData.userEmail,
          [PACKAGE_SCHEMA.SENDER]: packageData.sender,
          [PACKAGE_SCHEMA.DELIVERY_DATE]: packageData.deliveryDate,
          [PACKAGE_SCHEMA.DELIVERY_TIME]: packageData.deliveryTime,
          [PACKAGE_SCHEMA.EMAIL_ID]: packageData.emailId,
          [PACKAGE_SCHEMA.EMAIL_SUBJECT]: packageData.emailSubject || '',
          [PACKAGE_SCHEMA.EMAIL_FROM]: packageData.emailFrom || '',
          [PACKAGE_SCHEMA.EMAIL_SNIPPET]: packageData.emailSnippet || '',
          [PACKAGE_SCHEMA.PICKED_UP]: false,
          [PACKAGE_SCHEMA.CREATED_AT]: new Date().toISOString()
        };

        const request = store.add(packageRecord);

        request.onsuccess = () => {
          console.log('Package saved to database:', packageRecord.id);
          resolve(packageRecord);
        };

        request.onerror = () => {
          console.error('Failed to save package:', request.error);
          reject(new Error(ERROR_MESSAGES.PACKAGE_SAVE_FAILED));
        };
      });
    } catch (error) {
      console.error('Save package error:', error);
      throw error;
    }
  }

  /**
   * Get unpicked packages from database (excludes picked up packages)
   */
  async getUnpickedPackages() {
    try {
      if (!this.db) await this.initDB();

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([PACKAGE_CONFIG.STORE_NAME], 'readonly');
        const store = transaction.objectStore(PACKAGE_CONFIG.STORE_NAME);

        const request = store.getAll();

        request.onsuccess = () => {
          // Filter packages where pickedUp is false (exclude picked up packages)
          const unpickedPackages = request.result.filter(pkg =>
            pkg[PACKAGE_SCHEMA.PICKED_UP] === false
          );

          // Sort by delivery time (newest first)
          const packages = unpickedPackages.sort((a, b) =>
            new Date(b[PACKAGE_SCHEMA.DELIVERY_TIME]) - new Date(a[PACKAGE_SCHEMA.DELIVERY_TIME])
          );
          resolve(packages);
        };

        request.onerror = () => {
          console.error('Failed to fetch packages:', request.error);
          reject(new Error(ERROR_MESSAGES.PACKAGE_FETCH_FAILED));
        };
      });
    } catch (error) {
      console.error('Get packages error:', error);
      throw error;
    }
  }

  /**
   * Mark package as picked up
   */
  async markPackageAsPickedUp(packageId) {
    try {
      if (!this.db) await this.initDB();

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([PACKAGE_CONFIG.STORE_NAME], 'readwrite');
        const store = transaction.objectStore(PACKAGE_CONFIG.STORE_NAME);

        const getRequest = store.get(packageId);

        getRequest.onsuccess = () => {
          const packageRecord = getRequest.result;
          if (packageRecord) {
            packageRecord[PACKAGE_SCHEMA.PICKED_UP] = true;

            const updateRequest = store.put(packageRecord);
            updateRequest.onsuccess = () => {
              console.log('Package marked as picked up:', packageId);
              resolve(packageRecord);
            };
            updateRequest.onerror = () => reject(new Error('Failed to update package'));
          } else {
            reject(new Error('Package not found'));
          }
        };

        getRequest.onerror = () => {
          reject(new Error('Failed to find package'));
        };
      });
    } catch (error) {
      console.error('Mark pickup error:', error);
      throw error;
    }
  }

  /**
   * Get latest scan date from database
   */
  async getLatestScanDate() {
    try {
      if (!this.db) await this.initDB();

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([PACKAGE_CONFIG.STORE_NAME], 'readonly');
        const store = transaction.objectStore(PACKAGE_CONFIG.STORE_NAME);
        const index = store.index(PACKAGE_SCHEMA.DELIVERY_TIME);

        const request = index.openCursor(null, 'prev');

        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            resolve(cursor.value[PACKAGE_SCHEMA.DELIVERY_TIME]);
          } else {
            resolve(null);
          }
        };

        request.onerror = () => {
          console.error('Failed to get latest scan date:', request.error);
          resolve(null);
        };
      });
    } catch (error) {
      console.error('Get latest scan date error:', error);
      return null;
    }
  }

  /**
   * Get packages in date range to check what's already scanned
   */
  async getPackagesInDateRange(startDate, endDate) {
    try {
      if (!this.db) await this.initDB();

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([PACKAGE_CONFIG.STORE_NAME], 'readonly');
        const store = transaction.objectStore(PACKAGE_CONFIG.STORE_NAME);
        const index = store.index(PACKAGE_SCHEMA.DELIVERY_TIME);

        const startTime = new Date(startDate).getTime();
        const endTime = new Date(endDate).getTime();
        const packages = [];

        const request = index.openCursor();

        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            const packageTime = new Date(cursor.value[PACKAGE_SCHEMA.DELIVERY_TIME]).getTime();
            if (packageTime >= startTime && packageTime <= endTime) {
              packages.push(cursor.value);
            }
            cursor.continue();
          } else {
            resolve(packages);
          }
        };

        request.onerror = () => {
          console.error('Failed to get packages in date range:', request.error);
          resolve([]);
        };
      });
    } catch (error) {
      console.error('Get packages in date range error:', error);
      return [];
    }
  }

  /**
   * Check if email already exists in database
   */
  async emailExists(emailId) {
    try {
      if (!this.db) await this.initDB();

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([PACKAGE_CONFIG.STORE_NAME], 'readonly');
        const store = transaction.objectStore(PACKAGE_CONFIG.STORE_NAME);

        const request = store.getAll();

        request.onsuccess = () => {
          const packages = request.result;
          const exists = packages.some(pkg => pkg[PACKAGE_SCHEMA.EMAIL_ID] === emailId);
          resolve(exists);
        };

        request.onerror = () => {
          console.error('Failed to check if email exists:', request.error);
          resolve(false);
        };
      });
    } catch (error) {
      console.error('Check email exists error:', error);
      return false;
    }
  }

  /**
   * Save scan history to database
   */
  async saveScanHistory(scanData) {
    try {
      if (!this.db) await this.initDB();

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([PACKAGE_CONFIG.SCAN_HISTORY_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(PACKAGE_CONFIG.SCAN_HISTORY_STORE_NAME);

        const scanRecord = {
          [SCAN_HISTORY_SCHEMA.ID]: `scan_${Date.now()}`,
          [SCAN_HISTORY_SCHEMA.SCAN_DATE]: new Date().toISOString(),
          [SCAN_HISTORY_SCHEMA.EMAILS_SCANNED]: scanData.emailsScanned,
          [SCAN_HISTORY_SCHEMA.EARLIEST_EMAIL_TIMESTAMP]: scanData.earliestEmailTimestamp,
          [SCAN_HISTORY_SCHEMA.LATEST_EMAIL_TIMESTAMP]: scanData.latestEmailTimestamp,
          [SCAN_HISTORY_SCHEMA.START_DATE_REQUESTED]: scanData.startDateRequested,
          [SCAN_HISTORY_SCHEMA.END_DATE_REQUESTED]: scanData.endDateRequested,
          [SCAN_HISTORY_SCHEMA.PACKAGES_FOUND]: scanData.packagesFound
        };

        const request = store.add(scanRecord);

        request.onsuccess = () => {
          console.log('Scan history saved:', scanRecord.id);
          resolve(scanRecord);
        };

        request.onerror = () => {
          console.error('Failed to save scan history:', request.error);
          reject(new Error('Failed to save scan history'));
        };
      });
    } catch (error) {
      console.error('Save scan history error:', error);
      throw error;
    }
  }

  /**
   * Get scan history to check for overlapping scans
   */
  async getScanHistory() {
    try {
      if (!this.db) await this.initDB();

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([PACKAGE_CONFIG.SCAN_HISTORY_STORE_NAME], 'readonly');
        const store = transaction.objectStore(PACKAGE_CONFIG.SCAN_HISTORY_STORE_NAME);

        const request = store.getAll();

        request.onsuccess = () => {
          const scanHistory = request.result.sort((a, b) =>
            new Date(b[SCAN_HISTORY_SCHEMA.SCAN_DATE]) - new Date(a[SCAN_HISTORY_SCHEMA.SCAN_DATE])
          );
          resolve(scanHistory);
        };

        request.onerror = () => {
          console.error('Failed to get scan history:', request.error);
          resolve([]);
        };
      });
    } catch (error) {
      console.error('Get scan history error:', error);
      return [];
    }
  }

  /**
   * Check if a date range has already been scanned
   */
  async getOptimizedScanRanges(startDate, endDate) {
    try {
      const scanHistory = await this.getScanHistory();
      const requestedStart = new Date(startDate).getTime();
      const requestedEnd = new Date(endDate).getTime();

      // Find overlapping scans using the REQUESTED date ranges, not email timestamps
      const overlappingScans = scanHistory.filter(scan => {
        const scanStart = new Date(scan[SCAN_HISTORY_SCHEMA.START_DATE_REQUESTED]).getTime();
        const scanEnd = new Date(scan[SCAN_HISTORY_SCHEMA.END_DATE_REQUESTED]).getTime();

        // Check if there's any overlap between requested ranges
        return !(scanEnd < requestedStart || scanStart > requestedEnd);
      });

      if (overlappingScans.length === 0) {
        // No overlaps, scan the entire range
        return [{ startDate, endDate, reason: 'No previous scans found' }];
      }

      // Calculate gaps that need to be scanned
      const rangesToScan = [];
      let currentStart = requestedStart;

      // Sort overlapping scans by requested start date
      overlappingScans.sort((a, b) =>
        new Date(a[SCAN_HISTORY_SCHEMA.START_DATE_REQUESTED]).getTime() -
        new Date(b[SCAN_HISTORY_SCHEMA.START_DATE_REQUESTED]).getTime()
      );

      for (const scan of overlappingScans) {
        const scanStart = new Date(scan[SCAN_HISTORY_SCHEMA.START_DATE_REQUESTED]).getTime();
        const scanEnd = new Date(scan[SCAN_HISTORY_SCHEMA.END_DATE_REQUESTED]).getTime();

        // If there's a gap before this scan, add it to ranges to scan
        if (currentStart < scanStart) {
          rangesToScan.push({
            startDate: new Date(currentStart).toISOString().split('T')[0],
            endDate: new Date(scanStart - 1).toISOString().split('T')[0],
            reason: 'Gap before scanned range'
          });
        }

        // Move current start to after this scan
        currentStart = Math.max(currentStart, scanEnd + 1);
      }

      // If there's a gap after the last scan, add it
      if (currentStart <= requestedEnd) {
        rangesToScan.push({
          startDate: new Date(currentStart).toISOString().split('T')[0],
          endDate: endDate,
          reason: 'Gap after scanned range'
        });
      }

      return rangesToScan.length > 0 ? rangesToScan : [{
        startDate: null,
        endDate: null,
        reason: 'Range already fully scanned'
      }];

    } catch (error) {
      console.error('Get optimized scan ranges error:', error);
      // Fallback to scanning the entire range
      return [{ startDate, endDate, reason: 'Error checking scan history, scanning full range' }];
    }
  }

  /**
   * Save subscription to database
   */
  async saveSubscriptionToDB(subscriptionData) {
    try {
      if (!this.db) await this.initDB();

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([PACKAGE_CONFIG.SUBSCRIPTION_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(PACKAGE_CONFIG.SUBSCRIPTION_STORE_NAME);

        const subscriptionRecord = {
          [SUBSCRIPTION_SCHEMA.ID]: `${subscriptionData.emailId}_${Date.now()}`,
          [SUBSCRIPTION_SCHEMA.USER_EMAIL]: subscriptionData.userEmail,
          [SUBSCRIPTION_SCHEMA.SUBSCRIPTION_NAME]: subscriptionData.subscriptionName,
          [SUBSCRIPTION_SCHEMA.AMOUNT]: subscriptionData.amount,
          [SUBSCRIPTION_SCHEMA.BILLING_DATE]: subscriptionData.billingDate,
          [SUBSCRIPTION_SCHEMA.REMINDER_DATE]: subscriptionData.reminderDate,
          [SUBSCRIPTION_SCHEMA.EMAIL_ID]: subscriptionData.emailId,
          [SUBSCRIPTION_SCHEMA.EMAIL_SUBJECT]: subscriptionData.emailSubject || '',
          [SUBSCRIPTION_SCHEMA.EMAIL_FROM]: subscriptionData.emailFrom || '',
          [SUBSCRIPTION_SCHEMA.CREATED_AT]: new Date().toISOString()
        };

        const request = store.add(subscriptionRecord);

        request.onsuccess = () => {
          console.log('Subscription saved to database:', subscriptionRecord.id);
          resolve(subscriptionRecord);
        };

        request.onerror = () => {
          console.error('Failed to save subscription:', request.error);
          reject(new Error('Failed to save subscription'));
        };
      });
    } catch (error) {
      console.error('Save subscription error:', error);
      throw error;
    }
  }

  /**
   * Get all subscriptions from database
   */
  async getSubscriptions() {
    try {
      if (!this.db) await this.initDB();

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([PACKAGE_CONFIG.SUBSCRIPTION_STORE_NAME], 'readonly');
        const store = transaction.objectStore(PACKAGE_CONFIG.SUBSCRIPTION_STORE_NAME);

        const request = store.getAll();

        request.onsuccess = () => {
          // Sort by billing date (newest first)
          const subscriptions = request.result.sort((a, b) =>
            new Date(b[SUBSCRIPTION_SCHEMA.BILLING_DATE]) - new Date(a[SUBSCRIPTION_SCHEMA.BILLING_DATE])
          );
          resolve(subscriptions);
        };

        request.onerror = () => {
          console.error('Failed to fetch subscriptions:', request.error);
          reject(new Error('Failed to fetch subscriptions'));
        };
      });
    } catch (error) {
      console.error('Get subscriptions error:', error);
      throw error;
    }
  }

  /**
   * Save subscription scan history
   */
  async saveSubscriptionScanHistory(scanData) {
    try {
      if (!this.db) await this.initDB();

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([PACKAGE_CONFIG.SUBSCRIPTION_SCAN_HISTORY_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(PACKAGE_CONFIG.SUBSCRIPTION_SCAN_HISTORY_STORE_NAME);

        const scanRecord = {
          [SUBSCRIPTION_SCAN_HISTORY_SCHEMA.ID]: `sub_scan_${Date.now()}`,
          [SUBSCRIPTION_SCAN_HISTORY_SCHEMA.SCAN_DATE]: new Date().toISOString(),
          [SUBSCRIPTION_SCAN_HISTORY_SCHEMA.START_DATE]: scanData.startDate,
          [SUBSCRIPTION_SCAN_HISTORY_SCHEMA.END_DATE]: scanData.endDate,
          [SUBSCRIPTION_SCAN_HISTORY_SCHEMA.EMAILS_SCANNED]: scanData.emailsScanned,
          [SUBSCRIPTION_SCAN_HISTORY_SCHEMA.SUBSCRIPTIONS_FOUND]: scanData.subscriptionsFound,
          [SUBSCRIPTION_SCAN_HISTORY_SCHEMA.CALENDAR_EVENTS_CREATED]: scanData.calendarEventsCreated
        };

        const request = store.add(scanRecord);

        request.onsuccess = () => {
          console.log('Subscription scan history saved:', scanRecord.id);
          resolve(scanRecord);
        };

        request.onerror = () => {
          console.error('Failed to save subscription scan history:', request.error);
          reject(new Error('Failed to save subscription scan history'));
        };
      });
    } catch (error) {
      console.error('Save subscription scan history error:', error);
      throw error;
    }
  }

  /**
   * Get latest subscription scan date
   */
  async getLatestSubscriptionScanDate() {
    try {
      if (!this.db) await this.initDB();

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([PACKAGE_CONFIG.SUBSCRIPTION_SCAN_HISTORY_STORE_NAME], 'readonly');
        const store = transaction.objectStore(PACKAGE_CONFIG.SUBSCRIPTION_SCAN_HISTORY_STORE_NAME);
        const index = store.index(SUBSCRIPTION_SCAN_HISTORY_SCHEMA.SCAN_DATE);

        const request = index.openCursor(null, 'prev');

        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            resolve(cursor.value[SUBSCRIPTION_SCAN_HISTORY_SCHEMA.END_DATE]);
          } else {
            resolve(null);
          }
        };

        request.onerror = () => {
          console.error('Failed to get latest subscription scan date:', request.error);
          resolve(null);
        };
      });
    } catch (error) {
      console.error('Get latest subscription scan date error:', error);
      return null;
    }
  }

  /**
   * Check if calendar event already exists for email
   */
  async calendarEventExists(emailId) {
    try {
      if (!this.db) await this.initDB();

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([PACKAGE_CONFIG.SUBSCRIPTION_CALENDAR_EVENTS_STORE_NAME], 'readonly');
        const store = transaction.objectStore(PACKAGE_CONFIG.SUBSCRIPTION_CALENDAR_EVENTS_STORE_NAME);
        const index = store.index(SUBSCRIPTION_CALENDAR_EVENTS_SCHEMA.EMAIL_ID);

        const request = index.get(emailId);

        request.onsuccess = () => {
          resolve(!!request.result);
        };

        request.onerror = () => {
          console.error('Failed to check calendar event exists:', request.error);
          resolve(false);
        };
      });
    } catch (error) {
      console.error('Check calendar event exists error:', error);
      return false;
    }
  }

  /**
   * Save calendar event record
   */
  async saveCalendarEventRecord(eventData) {
    try {
      if (!this.db) await this.initDB();

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([PACKAGE_CONFIG.SUBSCRIPTION_CALENDAR_EVENTS_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(PACKAGE_CONFIG.SUBSCRIPTION_CALENDAR_EVENTS_STORE_NAME);

        const eventRecord = {
          [SUBSCRIPTION_CALENDAR_EVENTS_SCHEMA.ID]: `cal_event_${Date.now()}`,
          [SUBSCRIPTION_CALENDAR_EVENTS_SCHEMA.EMAIL_ID]: eventData.emailId,
          [SUBSCRIPTION_CALENDAR_EVENTS_SCHEMA.SUBSCRIPTION_NAME]: eventData.subscriptionName,
          [SUBSCRIPTION_CALENDAR_EVENTS_SCHEMA.CALENDAR_EVENT_ID]: eventData.calendarEventId,
          [SUBSCRIPTION_CALENDAR_EVENTS_SCHEMA.CREATED_DATE]: new Date().toISOString(),
          [SUBSCRIPTION_CALENDAR_EVENTS_SCHEMA.EMAIL_SUBJECT]: eventData.emailSubject,
          [SUBSCRIPTION_CALENDAR_EVENTS_SCHEMA.EMAIL_FROM]: eventData.emailFrom
        };

        const request = store.add(eventRecord);

        request.onsuccess = () => {
          console.log('Calendar event record saved:', eventRecord.id);
          resolve(eventRecord);
        };

        request.onerror = () => {
          console.error('Failed to save calendar event record:', request.error);
          reject(new Error('Failed to save calendar event record'));
        };
      });
    } catch (error) {
      console.error('Save calendar event record error:', error);
      throw error;
    }
  }

}

/**
 * Subscription Tracker - Main orchestrator for subscription tracking
 */
class SubscriptionTracker {
  constructor(gmailScanner, llmExtractor, calendarManager, packageDB) {
    this.gmailScanner = gmailScanner;
    this.llmExtractor = llmExtractor;
    this.calendarManager = calendarManager;
    this.packageDB = packageDB;
  }

  /**
   * Scan current month subscription emails and create calendar reminders
   */
  async scanCurrentMonthSubscriptions(progressCallback = null) {
    try {
      // Get the last scan date to optimize scanning
      const lastScanDate = await this.packageDB.getLatestSubscriptionScanDate();
      
      let startDate, endDate;
      if (lastScanDate) {
        // Scan from last scan date to now
        startDate = lastScanDate;
        endDate = new Date().toISOString().split('T')[0];
        console.log(`Incremental scan from ${startDate} to ${endDate}`);
      } else {
        // First time scan - scan current month
        const now = new Date();
        startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
        console.log(`Initial scan from ${startDate} to ${endDate}`);
      }

      // Define keywords for filtering
      const subscriptionSpecificKeywords = ['subscription', 'renewal', 'monthly subscription', 'annual subscription'];

      if (progressCallback) progressCallback({ step: 'subscription_scan', progress: 10, message: 'Searching for subscription emails...' });

      // Search for subscription-related emails
      const emailIds = await this.searchSubscriptionEmails({ startDate, endDate });

      if (emailIds.length === 0) {
        if (progressCallback) progressCallback({ step: 'complete', progress: 100, message: 'No subscription emails found' });
        return [];
      }

      if (progressCallback) progressCallback({ step: 'subscription_scan', progress: 30, message: `Processing ${emailIds.length} subscription emails...` });

      const subscriptions = [];
      const totalEmails = emailIds.length;
      let processedEmails = 0;
      let analyzedEmails = 0;

      for (let i = 0; i < emailIds.length; i++) {
        const emailId = emailIds[i];
        processedEmails++;
        const emailProgress = 30 + (processedEmails / totalEmails) * 50;

        try {
          if (progressCallback) {
            progressCallback({
              step: 'subscription_scan',
              progress: Math.round(emailProgress),
              message: `Processing email ${processedEmails}/${totalEmails}...`
            });
          }

          // Fetch email content
          const email = await this.gmailScanner.fetchEmail(emailId);

          // Pre-filter: Check if this email is likely subscription-related before sending to LLM
          if (!this.isLikelySubscriptionEmail(email, subscriptionSpecificKeywords)) {
            console.log(`Filtered out email: "${email.subject}" - not subscription-related`);
            continue; // Skip this email
          }

          analyzedEmails++;
          if (progressCallback) {
            progressCallback({
              step: 'subscription_scan',
              progress: Math.round(emailProgress),
              message: `Analyzing subscription email ${analyzedEmails} (${processedEmails}/${totalEmails} processed)`
            });
          }

          // Extract subscription information using LLM
          const subscriptionInfo = await this.extractSubscriptionInfo(email.body || email.snippet || '', email.from, email.subject, email.date);

          if (subscriptionInfo.isSubscriptionEmail) {
            const billingDate = new Date(subscriptionInfo.billingDate);
            const reminderDate = new Date(billingDate);
            reminderDate.setMonth(reminderDate.getMonth() + 1);

            const subscriptionData = {
              userEmail: await this.getCurrentUserEmail(),
              subscriptionName: subscriptionInfo.subscriptionName,
              amount: subscriptionInfo.amount,
              billingDate: subscriptionInfo.billingDate,
              reminderDate: reminderDate.toISOString().split('T')[0],
              emailId: emailId,
              emailSubject: email.subject,
              emailFrom: email.from
            };

            // Save to database
            const savedSubscription = await this.packageDB.saveSubscriptionToDB(subscriptionData);

            subscriptions.push({
              ...subscriptionInfo,
              emailId: emailId,
              emailDate: email.date,
              emailSubject: email.subject,
              emailFrom: email.from
            });
          }

        } catch (emailError) {
          console.error(`Failed to process email ${emailId}:`, emailError);
        }
      }

      if (progressCallback) progressCallback({ step: 'subscription_scan', progress: 80, message: `Creating calendar events for ${subscriptions.length} subscriptions...` });

      // Create calendar events for subscriptions (check for duplicates)
      const createdEvents = [];
      for (let i = 0; i < subscriptions.length; i++) {
        const subscription = subscriptions[i];
        try {
          // Check if calendar event already exists for this email
          const eventExists = await this.packageDB.calendarEventExists(subscription.emailId);
          if (eventExists) {
            console.log(`Calendar event already exists for email ${subscription.emailId}, skipping`);
            continue;
          }

          const event = await this.createSubscriptionReminderEvent(subscription);
          
          // Save calendar event record to prevent duplicates
          await this.packageDB.saveCalendarEventRecord({
            emailId: subscription.emailId,
            subscriptionName: subscription.subscriptionName,
            calendarEventId: event.id,
            emailSubject: subscription.emailSubject,
            emailFrom: subscription.emailFrom
          });
          
          createdEvents.push(event);
        } catch (eventError) {
          console.error(`Failed to create calendar event for subscription:`, eventError);
        }
      }

      if (progressCallback) {
        progressCallback({
          step: 'complete',
          progress: 100,
          message: `Created ${createdEvents.length} subscription reminders`
        });
      }

      // Save subscription scan history
      try {
        await this.packageDB.saveSubscriptionScanHistory({
          startDate: startDate,
          endDate: endDate,
          emailsScanned: emailIds.length,
          subscriptionsFound: subscriptions.length,
          calendarEventsCreated: createdEvents.length
        });
      } catch (historyError) {
        console.error('Failed to save subscription scan history:', historyError);
      }

      // Don't clear progress here - let the progress callback handle it

      return createdEvents;

    } catch (error) {
      console.error('Scan subscriptions error:', error);
      if (progressCallback) {
        progressCallback({
          step: 'error',
          progress: 0,
          message: `Error: ${error.message}`
        });
      }
      throw error;
    }
  }

  /**
   * Pre-filter to check if email is likely subscription-related
   * Only uses subscription-specific keywords and subject filtering
   */
  isLikelySubscriptionEmail(email, subscriptionKeywords) {
    const subject = (email.subject || '').toLowerCase();
    const fullContent = (email.snippet || '').toLowerCase();

    // Check if subject contains subscription or plan
    const hasSubscriptionSubject = subject.includes('subscription') || subject.includes('plan');

    // Check if content contains subscription-specific keywords
    const hasSubscriptionContent = subscriptionKeywords.some(keyword =>
      fullContent.includes(keyword.toLowerCase())
    );

    // Allow if: subscription content OR subscription/plan in subject
    return hasSubscriptionContent || hasSubscriptionSubject;
  }

  /**
   * Search for subscription-related emails
   */
  async searchSubscriptionEmails(options = {}) {
    try {
      const { startDate, endDate } = options;
      const keywords = SUBSCRIPTION_CONFIG.DEFAULT_SEARCH_KEYWORDS;

      console.log('Searching subscription emails from', startDate, 'to', endDate);

      // Build more restrictive search query for subscription emails
      const subscriptionSpecificKeywords = ['subscription', 'renewal', 'monthly subscription', 'annual subscription'];

      const searchOptions = {
        newerThan: startDate,
        olderThan: endDate
      };

      // Override the buildSearchQuery to be more restrictive
      const originalBuildQuery = this.gmailScanner.buildSearchQuery;
      this.gmailScanner.buildSearchQuery = (newerThan, olderThan) => {
        // Build the query components - only use subscription keywords and subject filter in Gmail search
        const subjectQuery = 'subject:(subscription OR plan or membership or renewal)';
        const subscriptionContentQuery = subscriptionSpecificKeywords.map(keyword => `"${keyword}"`).join(' OR ');

        // Use subscription-specific content OR subscription/plan in subject (payment filtering will be done on snippets later)
        let query = `((${subscriptionContentQuery}) OR ${subjectQuery})`;

        if (newerThan) {
          const date = new Date(newerThan);
          const dateStr = date.toISOString().split('T')[0].replace(/-/g, '/');
          query += ` after:${dateStr}`;
        }

        if (olderThan) {
          const date = new Date(olderThan);
          const dateStr = date.toISOString().split('T')[0].replace(/-/g, '/');
          query += ` before:${dateStr}`;
        }

        query += ` ${SEARCH_QUERIES.SPAM_FILTER}`;
        console.log('Subscription search query:', query);
        return query;
      };

      const emailIds = await this.gmailScanner.searchEmails(searchOptions);

      // Restore original method
      this.gmailScanner.buildSearchQuery = originalBuildQuery;

      console.log(`Found ${emailIds.length} potential subscription emails`);
      return emailIds;
    } catch (error) {
      console.error('Search subscription emails error:', error);
      throw error;
    }
  }

  /**
   * Extract subscription information from email content using LLM
   */
  async extractSubscriptionInfo(emailContent, emailFrom, emailSubject, emailDate = null) {
    try {
      const prompt = `Analyze the following email and determine if it is a subscription billing/payment notification email.

Email from: ${emailFrom}
Email subject: ${emailSubject}
Email content:
${emailContent}

Return ONLY a valid JSON object with the following structure:
{
  "isSubscriptionEmail": boolean,
  "subscriptionName": "service name (e.g., 'Netflix', 'Spotify', 'Adobe') or null if not a subscription email",
  "amount": "payment amount with currency (e.g., '$9.99', '€12.50') or null if not found",
  "billingDate": "YYYY-MM-DD format of when this payment was processed, or null if not found"
}

Rules:
- Set isSubscriptionEmail to true ONLY if the email is clearly about an ACTUAL subscription payment, billing, or renewal that has already been charged
- Set isSubscriptionEmail to false for ALL of the following:
  * Advertisement emails (e.g., "Get 3 months free", "Redeem your trial", "Special offer")
  * Trial offers or promotional emails
  * Emails about starting new subscriptions or trials
  * Emails that mention "free", "trial", "offer", "redeem", "discount", "promo"
  * Emails that are trying to sell or promote services
- If isSubscriptionEmail is false, set all other fields to null
- For subscriptionName, extract the service/company name (e.g., "Netflix" from "Netflix.com" or "Your Netflix subscription")
- For amount, include currency symbol and amount (e.g., "$9.99", "€12.50")
- For billingDate, use YYYY-MM-DD format based on the payment/billing date mentioned in the email
- Do not include any explanatory text, markdown formatting, or code blocks
- Return only the raw JSON object`;
      console.log("Email subject:", emailSubject);
      console.log("Email conetent:", emailContent)
      const response = await this.llmExtractor.callLLM(prompt);

      const cleanedResponse = response
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '')
        .replace(/^\s*[\r\n]+/gm, '')
        .trim();

      const subscriptionInfo = JSON.parse(cleanedResponse);
      console.log("Subscription info extracted:", JSON.stringify(subscriptionInfo));

      return {
        isSubscriptionEmail: subscriptionInfo.isSubscriptionEmail,
        subscriptionName: subscriptionInfo.subscriptionName,
        amount: subscriptionInfo.amount,
        billingDate: subscriptionInfo.billingDate || (emailDate ? new Date(emailDate).toISOString().split('T')[0] : null),
        emailSubject: emailSubject
      };
    } catch (error) {
      console.error('Extract subscription info error:', error);
      throw error;
    }
  }

  /**
   * Get current user's email address
   */
  async getCurrentUserEmail() {
    try {
      const token = await this.gmailScanner.getAuthToken();
      const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const profile = await response.json();
        return profile.emailAddress || 'unknown@gmail.com';
      }
      return 'unknown@gmail.com';
    } catch (error) {
      console.error('Failed to get user email:', error);
      return 'unknown@gmail.com';
    }
  }

  /**
   * Create calendar event for subscription reminder (1 month from billing date)
   */
  async createSubscriptionReminderEvent(subscription) {
    try {
      const billingDate = new Date(subscription.billingDate);

      // Create reminder for 1 month after the billing date
      const reminderDate = new Date(billingDate);
      reminderDate.setMonth(reminderDate.getMonth() + 1);

      const reminderDateStr = reminderDate.toISOString().split('T')[0];

      const eventTitle = `${subscription.subscriptionName} Subscription Renewal`;
      const gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${subscription.emailId}`;
      const eventDescription = `Subscription renewal reminder for ${subscription.subscriptionName}
Amount: ${subscription.amount || 'N/A'}
Last billing: ${subscription.billingDate}
Original email: ${subscription.emailSubject}
View original email: ${gmailUrl}`;

      const eventData = {
        title: eventTitle,
        date: reminderDateStr,
        description: eventDescription
      };

      const event = await this.calendarManager.createEvent(eventData);
      console.log(`Created calendar event for ${subscription.subscriptionName} on ${reminderDateStr}`);

      const result = {
        id: event.id,
        subscriptionName: subscription.subscriptionName,
        amount: subscription.amount,
        reminderDate: reminderDateStr,
        calendarEventId: event.id
      };
      
      console.log('Returning subscription event:', result);
      return result;
    } catch (error) {
      console.error('Create subscription reminder event error:', error);
      throw error;
    }
  }
}

/**
 * Package Tracker - Main orchestrator for package delivery tracking
 */
class PackageTracker {
  constructor(gmailScanner, llmExtractor, packageDB) {
    this.gmailScanner = gmailScanner;
    this.llmExtractor = llmExtractor;
    this.packageDB = packageDB;
  }

  /**
   * Search for package delivery emails with configurable keywords
   */
  async searchPackageEmails(options = {}) {
    try {
      const {
        startDate = PACKAGE_CONFIG.DEFAULT_START_DATE,
        endDate = PACKAGE_CONFIG.DEFAULT_END_DATE,
        keywords = PACKAGE_CONFIG.DEFAULT_SEARCH_KEYWORDS
      } = options;

      console.log('Searching package emails from', startDate, 'to', endDate);

      // Build search query with package keywords
      const keywordQuery = keywords.map(keyword => `"${keyword}"`).join(' OR ');
      const searchOptions = {
        newerThan: startDate,
        olderThan: endDate
      };

      // Override the buildSearchQuery to include package keywords
      const originalBuildQuery = this.gmailScanner.buildSearchQuery;
      this.gmailScanner.buildSearchQuery = (newerThan, olderThan) => {
        let query = `(${keywordQuery})`;

        if (newerThan) {
          const date = new Date(newerThan);
          const dateStr = date.toISOString().split('T')[0].replace(/-/g, '/');
          query += ` after:${dateStr}`;
        }

        if (olderThan) {
          const date = new Date(olderThan);
          const dateStr = date.toISOString().split('T')[0].replace(/-/g, '/');
          query += ` before:${dateStr}`;
        }

        query += ` ${SEARCH_QUERIES.SPAM_FILTER}`;
        return query;
      };

      const emailIds = await this.gmailScanner.searchEmails(searchOptions);

      // Restore original method
      this.gmailScanner.buildSearchQuery = originalBuildQuery;

      console.log(`Found ${emailIds.length} potential package emails`);
      return emailIds;
    } catch (error) {
      console.error('Search package emails error:', error);
      throw error;
    }
  }



  /**
   * Extract delivery information from email content using LLM
   */
  async extractDeliveryInfo(emailContent, emailFrom, emailSubject, emailDate = null) {
    try {
      const prompt = `Analyze the following email and determine if it is a package/delivery notification email.

First, check if this email is related to package delivery.

Email from: ${emailFrom}
Email subject: ${emailSubject}
Email content:
${emailContent}

Return ONLY a valid JSON object with the following structure:
{
  "isDeliveryEmail": boolean,
  "deliveryDate": "YYYY-MM-DD or null if not found or not a delivery email",
  "sender": "company/service name (e.g., 'amazon', 'fedex', 'ups') or null if not a delivery email"
}
Rules:
- Set isDeliveryEmail to true only if the email is clearly about the package is delivered
- If isDeliveryEmail is false, set deliveryDate and sender to null
- For sender, extract the company name from the email domain or content (e.g., "amazon" from "amazon.com" or "Amazon", "fedex" from "FedEx")
- For deliveryDate, use YYYY-MM-DD format
- Do not include any explanatory text, markdown formatting, or code blocks
- Return only the raw JSON object`;

      const response = await this.llmExtractor.callLLM(prompt);

      const cleanedResponse = response.replace(/```json\n?/g, "").replace(/```\n?/g, "");

      const deliveryInfo = JSON.parse(cleanedResponse);
      console.log("Here is the email subject: " + emailSubject);
      console.log("Here is the deliveryInfo: " + JSON.stringify(deliveryInfo));

      // If deliveryDate is null and we have an email date, use the email sent date
      let finalDeliveryDate = deliveryInfo.deliveryDate;
      if (!finalDeliveryDate && emailDate) {
        const emailSentDate = new Date(emailDate);
        finalDeliveryDate = emailSentDate.toISOString().split('T')[0]; // Format as YYYY-MM-DD
        console.log(`Using email sent date as delivery date: ${finalDeliveryDate}`);
      }

      return {
        isDeliveryEmail: deliveryInfo.isDeliveryEmail,
        deliveryDate: finalDeliveryDate || null,
        sender: deliveryInfo.sender || this.extractSenderFromEmail(emailFrom)
      };
    } catch (error) {
      console.error('Extract delivery info error:', error);
      throw error;
    }
  }

  /**
   * Extract sender from email address
   */
  extractSenderFromEmail(emailFrom) {
    try {
      const emailMatch = emailFrom.match(/<(.+?)>/) || emailFrom.match(/(\S+@\S+)/);
      if (emailMatch) {
        const email = emailMatch[1] || emailMatch[0];
        const domain = email.split('@')[1];
        if (domain) {
          return domain.split('.')[0].toLowerCase();
        }
      }
      return 'unknown';
    } catch (error) {
      console.error('Extract sender error:', error);
      return 'unknown';
    }
  }

  /**
   * Get current user's email address
   */
  async getCurrentUserEmail() {
    try {
      const token = await this.gmailScanner.getAuthToken();
      const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const profile = await response.json();
        return profile.emailAddress || 'unknown@gmail.com';
      }
      return 'unknown@gmail.com';
    } catch (error) {
      console.error('Failed to get user email:', error);
      return 'unknown@gmail.com';
    }
  }

  /**
   * Process package emails - main orchestrator function with smart scanning and scan history optimization
   */
  async processPackageEmails(options = {}, progressCallback = null) {
    try {
      const startTime = Date.now();
      const { startDate, endDate } = options;

      // Step 1: Check scan history for optimization
      if (progressCallback) progressCallback({ step: 'optimizing', progress: 5, message: 'Checking scan history for optimization...' });

      const optimizedRanges = await this.packageDB.getOptimizedScanRanges(startDate, endDate);

      if (optimizedRanges.length === 1 && optimizedRanges[0].startDate === null) {
        if (progressCallback) progressCallback({
          step: 'complete',
          progress: 100,
          message: 'Date range already fully scanned. No new emails to process.'
        });
        return [];
      }

      console.log(`Optimized scan ranges:`, optimizedRanges);

      let allProcessedPackages = [];
      let totalEmailsScanned = 0;
      let earliestEmailTimestamp = null;
      let latestEmailTimestamp = null;

      // Step 2: Process each optimized range
      for (let rangeIndex = 0; rangeIndex < optimizedRanges.length; rangeIndex++) {
        const range = optimizedRanges[rangeIndex];
        const baseProgress = (rangeIndex / optimizedRanges.length) * 85; // Reserve 15% for final steps

        if (progressCallback) progressCallback({
          step: 'scanning',
          progress: Math.round(baseProgress + 5),
          message: `Scanning emails from ${range.startDate} to ${range.endDate}`
        });

        // Search for package emails in this range
        const rangeOptions = { ...options, startDate: range.startDate, endDate: range.endDate };
        const allEmailIds = await this.searchPackageEmails(rangeOptions);
        totalEmailsScanned += allEmailIds.length;

        if (allEmailIds.length === 0) {
          console.log(`No emails found in range ${range.startDate} to ${range.endDate}`);
          if (progressCallback) progressCallback({
            step: 'scanning',
            progress: Math.round(baseProgress + 80),
            message: `No emails found`
          });
          continue;
        }

        // Filter out emails that are already processed
        if (progressCallback) progressCallback({
          step: 'filtering',
          progress: Math.round(baseProgress + 10),
          message: `Filtering ${allEmailIds.length} emails...`
        });

        const newEmailIds = [];
        for (const emailId of allEmailIds) {
          const exists = await this.packageDB.emailExists(emailId);
          if (!exists) {
            newEmailIds.push(emailId);
          }
        }

        console.log(`Range ${rangeIndex + 1}: Total emails found: ${allEmailIds.length}, New emails to process: ${newEmailIds.length}`);

        if (newEmailIds.length === 0) {
          if (progressCallback) progressCallback({
            step: 'filtering',
            progress: Math.round(baseProgress + 80),
            message: `All emails already processed`
          });
          continue;
        }

        const processedPackages = [];
        const totalEmails = newEmailIds.length;

        // Process emails in this range
        for (let i = 0; i < newEmailIds.length; i++) {
          const emailId = newEmailIds[i];
          const emailProgress = baseProgress + 15 + ((i + 1) / totalEmails) * 65; // 65% for processing emails

          try {
            if (progressCallback) {
              progressCallback({
                step: 'processing',
                progress: Math.round(emailProgress),
                message: `Processing email ${i + 1}/${totalEmails}`
              });
            }

            // Fetch email content
            const email = await this.gmailScanner.fetchEmail(emailId);
            const emailTimestamp = new Date(email.date).toISOString();

            // Track earliest and latest email timestamps
            if (!earliestEmailTimestamp || emailTimestamp < earliestEmailTimestamp) {
              earliestEmailTimestamp = emailTimestamp;
            }
            if (!latestEmailTimestamp || emailTimestamp > latestEmailTimestamp) {
              latestEmailTimestamp = emailTimestamp;
            }

            // Use email snippet directly instead of cleaning full body
            const emailContent = email.snippet || email.body || '';

            // Extract delivery information
            const deliveryInfo = await this.extractDeliveryInfo(emailContent, email.from, email.subject, email.date);
            console.log(deliveryInfo.isDeliveryEmail);

            if (deliveryInfo.isDeliveryEmail) {
              // Save to database with email details
              const packageData = {
                userEmail: await this.getCurrentUserEmail(),
                sender: deliveryInfo.sender,
                deliveryDate: deliveryInfo.deliveryDate,
                deliveryTime: emailTimestamp,
                emailId: emailId,
                emailSubject: email.subject,
                emailFrom: email.from,
                emailSnippet: email.snippet
              };

              const savedPackage = await this.packageDB.savePackageToDB(packageData);
              processedPackages.push(savedPackage);
            }

          } catch (emailError) {
            console.error(`Failed to process email ${emailId}:`, emailError);
            // Continue processing other emails
          }
        }

        allProcessedPackages.push(...processedPackages);
      }

      // Step 3: Save scan history
      if (progressCallback) progressCallback({ step: 'saving', progress: 90, message: 'Saving scan history...' });

      if (totalEmailsScanned > 0) {
        const scanHistoryData = {
          emailsScanned: totalEmailsScanned,
          earliestEmailTimestamp: earliestEmailTimestamp || new Date(startDate).toISOString(),
          latestEmailTimestamp: latestEmailTimestamp || new Date(endDate).toISOString(),
          startDateRequested: startDate,
          endDateRequested: endDate,
          packagesFound: allProcessedPackages.length
        };

        try {
          await this.packageDB.saveScanHistory(scanHistoryData);
          console.log('Scan history saved successfully');
          if (progressCallback) progressCallback({ step: 'saving', progress: 95, message: 'Scan history saved successfully' });
        } catch (historyError) {
          console.error('Failed to save scan history:', historyError);
          if (progressCallback) progressCallback({ step: 'saving', progress: 95, message: 'Warning: Failed to save scan history' });
          // Don't fail the entire operation if history save fails
        }
      } else {
        if (progressCallback) progressCallback({ step: 'saving', progress: 95, message: 'No scan history to save' });
      }

      if (progressCallback) {
        progressCallback({
          step: 'complete',
          progress: 100,
          message: `Scan complete! Found ${allProcessedPackages.length} new packages from ${totalEmailsScanned} emails scanned`
        });
      }

      console.log(`Processed ${allProcessedPackages.length} new packages from ${totalEmailsScanned} emails in ${Date.now() - startTime}ms`);
      return allProcessedPackages;

    } catch (error) {
      console.error('Process package emails error:', error);
      if (progressCallback) {
        progressCallback({
          step: 'error',
          progress: 0,
          message: `Error: ${error.message}`
        });
      }
      throw error;
    }
  }
}

// Separate scanning state management for subscription and package scans
let subscriptionScanningState = {
  isScanning: false,
  progress: 0,
  message: '',
  step: '',
  startTime: null,
  options: null
};

let packageScanningState = {
  isScanning: false,
  progress: 0,
  message: '',
  step: '',
  startTime: null,
  options: null
};

// Load scanning states from storage on startup
async function loadScanningStates() {
  try {
    const result = await chrome.storage.local.get(['subscriptionScanningState', 'packageScanningState']);

    // Load subscription scanning state
    if (result.subscriptionScanningState) {
      const storedState = result.subscriptionScanningState;
      const tenMinutes = 10 * 60 * 1000;
      if (Date.now() - storedState.timestamp < tenMinutes && storedState.isScanning) {
        subscriptionScanningState = { ...storedState };
        console.log('Restored subscription scanning state from storage:', subscriptionScanningState);
      } else {
        console.log('Subscription scanning state expired or not active, starting fresh');
      }
    }

    // Load package scanning state
    if (result.packageScanningState) {
      const storedState = result.packageScanningState;
      const tenMinutes = 10 * 60 * 1000;
      if (Date.now() - storedState.timestamp < tenMinutes && storedState.isScanning) {
        packageScanningState = { ...storedState };
        console.log('Restored package scanning state from storage:', packageScanningState);
      } else {
        console.log('Package scanning state expired or not active, starting fresh');
      }
    }
  } catch (error) {
    console.error('Failed to load scanning states:', error);
  }
}

// Save scanning states to storage
async function saveScanningStates() {
  try {
    await chrome.storage.local.set({
      subscriptionScanningState: {
        ...subscriptionScanningState,
        timestamp: Date.now()
      },
      packageScanningState: {
        ...packageScanningState,
        timestamp: Date.now()
      }
    });
  } catch (error) {
    console.error('Failed to save scanning states:', error);
  }
}

/**
 * Unified progress update function that syncs all components
 */
async function updateProgressState(scanType, progressData) {
  try {
    const isSubscription = scanType === 'subscription';
    const state = isSubscription ? subscriptionScanningState : packageScanningState;
    
    // Update internal state
    Object.assign(state, progressData);
    
    // Save scanning states
    await saveScanningStates();
    
    // Store current progress for polling
    const currentProgressKey = isSubscription ? 'currentSubscriptionProgress' : 'currentPackageProgress';
    const enhancedProgressData = {
      ...progressData,
      scanType: scanType,
      timestamp: Date.now()
    };
    
    if (progressData.step !== 'complete' && progressData.step !== 'error') {
      await chrome.storage.local.set({ [currentProgressKey]: enhancedProgressData });
    } else {
      // For completion/error states, store briefly then clear
      await chrome.storage.local.set({ [currentProgressKey]: enhancedProgressData });
      setTimeout(() => {
        chrome.storage.local.remove(currentProgressKey).catch(() => {});
      }, 2000);
    }
    
    // Broadcast progress update
    const progressMessage = {
      type: MESSAGE_TYPES.PROGRESS_UPDATE,
      data: enhancedProgressData
    };
    
    // Broadcast scanning state change
    const stateMessage = {
      type: 'SCANNING_STATE_CHANGED',
      data: {
        isScanning: state.isScanning,
        progress: state.progress,
        message: state.message,
        step: state.step,
        scanType: scanType
      }
    };
    
    // Send to popup
    chrome.runtime.sendMessage(progressMessage).catch(() => {});
    chrome.runtime.sendMessage(stateMessage).catch(() => {});
    
    // Send to all content scripts
    const tabs = await chrome.tabs.query({});
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, progressMessage).catch(() => {});
      chrome.tabs.sendMessage(tab.id, stateMessage).catch(() => {});
    });
    
    console.log(`Progress updated for ${scanType}:`, progressData);
  } catch (error) {
    console.error('Failed to update progress state:', error);
  }
}

// Initialize scanning states on startup
loadScanningStates();

// Create global instances
const gmailScanner = new GmailScanner();
const calendarManager = new CalendarManager();
const llmExtractor = new LLMExtractor();
const packageDB = new PackageDatabase();
const packageTracker = new PackageTracker(gmailScanner, llmExtractor, packageDB);
const subscriptionTracker = new SubscriptionTracker(gmailScanner, llmExtractor, calendarManager, packageDB);

// Message handling for all functions including package tracking
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background: Received message:', message.type);

  // Always return true to indicate we will send a response asynchronously
  handleMessage(message, sender, sendResponse);
  return true;
});

async function handleMessage(message, sender, sendResponse) {
  try {
    switch (message.type) {
      case MESSAGE_TYPES.SEARCH_EMAILS:
        gmailScanner.searchEmails(message.options)
          .then(emailIds => sendResponse({ success: true, emailIds }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;

      case MESSAGE_TYPES.FETCH_EMAIL:
        gmailScanner.fetchEmail(message.emailId)
          .then(email => sendResponse({ success: true, email }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;

      case MESSAGE_TYPES.CREATE_CALENDAR_EVENT:
        calendarManager.createEvent(message.eventData)
          .then(event => sendResponse({ success: true, event }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;

      case MESSAGE_TYPES.CALL_LLM:
        llmExtractor.callLLM(message.prompt)
          .then(result => sendResponse({ success: true, result }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;

      // Package tracking message handlers
      case MESSAGE_TYPES.SEARCH_PACKAGE_EMAILS:
        packageTracker.searchPackageEmails(message.options)
          .then(emailIds => sendResponse({ success: true, emailIds }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;

      case MESSAGE_TYPES.PROCESS_PACKAGE_EMAILS:
        // Check if already scanning packages
        if (packageScanningState.isScanning) {
          sendResponse({ success: false, error: 'Package scan already in progress' });
          return true;
        }

        // Initialize package scanning state
        packageScanningState = {
          isScanning: true,
          progress: 0,
          message: 'Initializing...',
          step: 'initializing',
          startTime: Date.now(),
          options: message.options
        };

        // Save scanning states
        await saveScanningStates();

        // Immediately broadcast that scanning has started
        const initialStateMessage = {
          type: 'SCANNING_STATE_CHANGED',
          data: {
            isScanning: true,
            progress: 0,
            message: 'Initializing...',
            step: 'initializing',
            scanType: 'package'
          }
        };

        chrome.runtime.sendMessage(initialStateMessage).catch(() => { });
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, initialStateMessage).catch(() => { });
          });
        });

        // Handle progress updates using unified function
        const progressCallback = (progressData) => {
          updateProgressState('package', progressData);
        };

        // Ensure database is initialized before starting package scan
        packageDB.initDB()
          .then(() => {
            console.log('Database initialized for package scan');
            return packageTracker.processPackageEmails(message.options, progressCallback);
          })
          .then(packages => {
            // Reset package scanning state
            packageScanningState.isScanning = false;
            saveScanningStates();

            // Don't clear progress here - let the progress callback handle it with proper timing

            // Broadcast final state change
            const finalStateMessage = {
              type: 'SCANNING_STATE_CHANGED',
              data: {
                isScanning: false,
                progress: 100,
                message: 'Scan complete',
                step: 'complete',
                scanType: 'package'
              }
            };

            chrome.runtime.sendMessage(finalStateMessage).catch(() => { });
            chrome.tabs.query({}, (tabs) => {
              tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, finalStateMessage).catch(() => { });
              });
            });

            sendResponse({ success: true, packages });
          })
          .catch(error => {
            // Reset package scanning state on error
            packageScanningState.isScanning = false;
            saveScanningStates();

            // Don't clear progress here - let the progress callback handle it

            // Broadcast error state change
            const errorStateMessage = {
              type: 'SCANNING_STATE_CHANGED',
              data: {
                isScanning: false,
                progress: 0,
                message: `Error: ${error.message}`,
                step: 'error',
                scanType: 'package'
              }
            };

            chrome.runtime.sendMessage(errorStateMessage).catch(() => { });
            chrome.tabs.query({}, (tabs) => {
              tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, errorStateMessage).catch(() => { });
              });
            });

            sendResponse({ success: false, error: error.message });
          });
        return true;

      case MESSAGE_TYPES.GET_UNPICKED_PACKAGES:
        packageDB.initDB()
          .then(() => packageDB.getUnpickedPackages())
          .then(packages => sendResponse({ success: true, packages }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;

      case MESSAGE_TYPES.MARK_PACKAGE_PICKED_UP:
        packageDB.initDB()
          .then(() => packageDB.markPackageAsPickedUp(message.packageId))
          .then(packageRecord => sendResponse({ success: true, package: packageRecord }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;

      case MESSAGE_TYPES.GET_PACKAGES_IN_DATE_RANGE:
        packageDB.initDB()
          .then(() => packageDB.getPackagesInDateRange(message.startDate, message.endDate))
          .then(packages => sendResponse({ success: true, packages }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;

      case MESSAGE_TYPES.CHECK_EMAIL_EXISTS:
        packageDB.initDB()
          .then(() => packageDB.emailExists(message.emailId))
          .then(exists => sendResponse({ success: true, exists }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;

      case MESSAGE_TYPES.GET_SCAN_HISTORY:
        packageDB.initDB()
          .then(() => packageDB.getScanHistory())
          .then(scanHistory => sendResponse({ success: true, scanHistory }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;

      case MESSAGE_TYPES.SAVE_SCAN_HISTORY:
        packageDB.initDB()
          .then(() => packageDB.saveScanHistory(message.scanData))
          .then(scanRecord => sendResponse({ success: true, scanRecord }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;

      case MESSAGE_TYPES.EXTRACT_DELIVERY_INFO:
        packageTracker.extractDeliveryInfo(message.emailContent, message.emailFrom, message.emailSubject, message.emailDate)
          .then(deliveryInfo => sendResponse({ success: true, deliveryInfo }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;

      case MESSAGE_TYPES.DESTROY_LLM_SESSION:
        // Make session destruction non-blocking with timeout
        Promise.race([
          llmExtractor.destroySession(),
          new Promise(resolve => setTimeout(() => resolve(), 5000)) // 5 second timeout
        ])
          .then(() => sendResponse({ success: true, message: 'Session destroyed' }))
          .catch(error => {
            console.warn('Session destruction failed, continuing anyway:', error);
            sendResponse({ success: true, message: 'Session destruction attempted' });
          });
        return true;

      case MESSAGE_TYPES.GET_SCANNING_STATE:
        const stateResponse = {
          success: true,
          subscriptionScanningState: subscriptionScanningState,
          packageScanningState: packageScanningState,
          // For backward compatibility, return the active scanning state
          scanningState: subscriptionScanningState.isScanning ? subscriptionScanningState : packageScanningState
        };
        sendResponse(stateResponse);

        // IMMEDIATELY broadcast current states and progress to ensure synchronization
        // This ensures that when popup/widget opens, it gets the latest state right away
        
        if (subscriptionScanningState.isScanning) {
          console.log('Background: Broadcasting current subscription state to new component');
          
          // Send both state change and progress update messages
          const syncStateMessage = {
            type: 'SCANNING_STATE_CHANGED',
            data: {
              isScanning: subscriptionScanningState.isScanning,
              progress: subscriptionScanningState.progress,
              message: subscriptionScanningState.message,
              step: subscriptionScanningState.step,
              scanType: 'subscription'
            }
          };

          const syncProgressMessage = {
            type: MESSAGE_TYPES.PROGRESS_UPDATE,
            data: {
              progress: subscriptionScanningState.progress,
              message: subscriptionScanningState.message,
              step: subscriptionScanningState.step,
              scanType: 'subscription'
            }
          };

          // Send to popup and all content scripts
          chrome.runtime.sendMessage(syncStateMessage).catch(() => { });
          chrome.runtime.sendMessage(syncProgressMessage).catch(() => { });
          
          chrome.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
              chrome.tabs.sendMessage(tab.id, syncStateMessage).catch(() => { });
              chrome.tabs.sendMessage(tab.id, syncProgressMessage).catch(() => { });
            });
          });
        }

        if (packageScanningState.isScanning) {
          console.log('Background: Broadcasting current package state to new component');
          
          // Send both state change and progress update messages
          const syncStateMessage = {
            type: 'SCANNING_STATE_CHANGED',
            data: {
              isScanning: packageScanningState.isScanning,
              progress: packageScanningState.progress,
              message: packageScanningState.message,
              step: packageScanningState.step,
              scanType: 'package'
            }
          };

          const syncProgressMessage = {
            type: MESSAGE_TYPES.PROGRESS_UPDATE,
            data: {
              progress: packageScanningState.progress,
              message: packageScanningState.message,
              step: packageScanningState.step,
              scanType: 'package'
            }
          };

          // Send to popup and all content scripts
          chrome.runtime.sendMessage(syncStateMessage).catch(() => { });
          chrome.runtime.sendMessage(syncProgressMessage).catch(() => { });
          
          chrome.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
              chrome.tabs.sendMessage(tab.id, syncStateMessage).catch(() => { });
              chrome.tabs.sendMessage(tab.id, syncProgressMessage).catch(() => { });
            });
          });
        }
        return true;

      case MESSAGE_TYPES.SCAN_SUBSCRIPTION_EMAILS:
        console.log('Background: Received SCAN_SUBSCRIPTION_EMAILS message');
        // Check if already scanning subscriptions
        if (subscriptionScanningState.isScanning) {
          console.log('Background: Subscription scan already in progress');
          sendResponse({ success: false, error: 'Subscription scan already in progress' });
          return true;
        }

        // Initialize subscription scanning state
        subscriptionScanningState = {
          isScanning: true,
          progress: 0,
          message: 'Initializing subscription scan...',
          step: 'subscription_scan',
          startTime: Date.now(),
          options: { type: 'subscription' }
        };

        // Save scanning states
        await saveScanningStates();

        // Send immediate progress update to show the progress bar
        const initialProgressData = {
          progress: 0,
          message: 'Initializing subscription scan...',
          step: 'subscription_scan',
          scanType: 'subscription'
        };

        const initialUpdateMessage = {
          type: MESSAGE_TYPES.PROGRESS_UPDATE,
          data: initialProgressData
        };

        // Send to popup
        chrome.runtime.sendMessage(initialUpdateMessage).catch(() => {
          // Ignore errors if popup is closed
        });

        // Send to all content scripts
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, initialUpdateMessage).catch(() => {
              // Ignore errors if content script not available
            });
          });
        });

        // Handle progress updates using unified function
        const subscriptionProgressCallback = (progressData) => {
          // Ensure the progress data has the correct step for subscription scans
          const enhancedProgressData = {
            ...progressData,
            step: progressData.step === 'complete' || progressData.step === 'error' ? progressData.step : 'subscription_scan'
          };
          updateProgressState('subscription', enhancedProgressData);
        };

        // Ensure database is initialized before starting subscription scan
        packageDB.initDB()
          .then(() => {
            console.log('Database initialized for subscription scan');
            return subscriptionTracker.scanCurrentMonthSubscriptions(subscriptionProgressCallback);
          })
          .then(events => {
            // Reset subscription scanning state
            subscriptionScanningState.isScanning = false;
            saveScanningStates();
            
            // Don't clear progress here - let the progress callback handle it with proper timing
            
            console.log('Background: Subscription scan completed successfully, events:', events.length);
            sendResponse({ success: true, events });
          })
          .catch(error => {
            // Reset subscription scanning state on error
            subscriptionScanningState.isScanning = false;
            saveScanningStates();
            
            // Don't clear progress here - let the progress callback handle it
            
            console.error('Background: Subscription scan failed:', error);
            sendResponse({ success: false, error: error.message || 'Subscription scan failed' });
          });
        return true;

      case MESSAGE_TYPES.GET_SUBSCRIPTIONS:
        packageDB.initDB()
          .then(() => packageDB.getSubscriptions())
          .then(subscriptions => sendResponse({ success: true, subscriptions }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;

      default:
        sendResponse({ success: false, error: 'Unknown message type' });
    }
  } catch (error) {
    console.error('Background: Error handling message:', error);
    sendResponse({ success: false, error: error.message || 'Background script error' });
  }
}