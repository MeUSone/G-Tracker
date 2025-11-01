// Gmail Order Tracker - Constants

/**
 * Gmail API Configuration
 */
export const GMAIL_API = {
    BASE_URL: 'https://gmail.googleapis.com/gmail/v1',
    MAX_RESULTS_PER_PAGE: 500,
    REQUEST_DELAY_MS: 100
};

/**
 * Calendar API Configuration
 */
export const CALENDAR_API = {
    BASE_URL: 'https://www.googleapis.com/calendar/v3',
    DEFAULT_CALENDAR_ID: 'primary'
};

/**
 * Search Query Templates
 */
export const SEARCH_QUERIES = {
    SPAM_FILTER: '-is:spam -in:trash'
};

/**
 * LLM Configuration
 */
export const LLM_CONFIG = {
    TEMPERATURE: 0,
    TOP_K: 3,
    SYSTEM_PROMPT: 'You are a helpful AI assistant. Provide clear and accurate responses.'
};

/**
 * UI Configuration
 */
export const UI_CONFIG = {
    MAX_DISPLAY_EMAILS: 10,
    RESULT_AREA_CLASSES: {
        VISIBLE: 'visible',
        LOADING: 'loading',
        ERROR: 'error'
    }
};

/**
 * Message Types for Chrome Extension Communication
 */
export const MESSAGE_TYPES = {
    SEARCH_EMAILS: 'SEARCH_EMAILS',
    FETCH_EMAIL: 'FETCH_EMAIL',
    CREATE_CALENDAR_EVENT: 'CREATE_CALENDAR_EVENT',
    CALL_LLM: 'CALL_LLM',
    // Package tracking messages
    SEARCH_PACKAGE_EMAILS: 'SEARCH_PACKAGE_EMAILS',
    PROCESS_PACKAGE_EMAILS: 'PROCESS_PACKAGE_EMAILS',
    GET_UNPICKED_PACKAGES: 'GET_UNPICKED_PACKAGES',
    MARK_PACKAGE_PICKED_UP: 'MARK_PACKAGE_PICKED_UP',
    EXTRACT_DELIVERY_INFO: 'EXTRACT_DELIVERY_INFO',
    PROGRESS_UPDATE: 'PROGRESS_UPDATE',
    DESTROY_LLM_SESSION: 'DESTROY_LLM_SESSION',
    GET_PACKAGES_IN_DATE_RANGE: 'GET_PACKAGES_IN_DATE_RANGE',
    CHECK_EMAIL_EXISTS: 'CHECK_EMAIL_EXISTS',
    // Scan history messages
    GET_SCAN_HISTORY: 'GET_SCAN_HISTORY',
    SAVE_SCAN_HISTORY: 'SAVE_SCAN_HISTORY',
    // Scanning state management
    GET_SCANNING_STATE: 'GET_SCANNING_STATE',
    SCANNING_STATE_CHANGED: 'SCANNING_STATE_CHANGED',
    // Subscription tracking messages
    SCAN_SUBSCRIPTION_EMAILS: 'SCAN_SUBSCRIPTION_EMAILS',
    GET_SUBSCRIPTIONS: 'GET_SUBSCRIPTIONS',
    // Cleanup messages
    CLEANUP_SCAN_STATES: 'CLEANUP_SCAN_STATES'
};

/**
 * Package Delivery Tracking Configuration
 */
export const PACKAGE_CONFIG = {
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
    ],
    DB_NAME: 'PackageTracker',
    DB_VERSION: 5,
    STORE_NAME: 'packages',
    SUBSCRIPTION_STORE_NAME: 'subscriptions',
    SCAN_HISTORY_STORE_NAME: 'scan_history',
    SUBSCRIPTION_SCAN_HISTORY_STORE_NAME: 'subscription_scan_history',
    SUBSCRIPTION_CALENDAR_EVENTS_STORE_NAME: 'subscription_calendar_events'
};

/**
 * Subscription Tracking Configuration
 */
export const SUBSCRIPTION_CONFIG = {
    DEFAULT_SEARCH_KEYWORDS: [
        'subscription',
        'billing',
        'payment',
        'invoice',
        'receipt',
        'charged',
        'renewal',
        'monthly subscription',
        'annual subscription'
    ]
};

/**
 * Subscription Database Schema
 */
export const SUBSCRIPTION_SCHEMA = {
    ID: 'id',
    USER_EMAIL: 'userEmail',
    SUBSCRIPTION_NAME: 'subscriptionName',
    AMOUNT: 'amount',
    BILLING_DATE: 'billingDate',
    REMINDER_DATE: 'reminderDate',
    EMAIL_ID: 'emailId',
    EMAIL_SUBJECT: 'emailSubject',
    EMAIL_FROM: 'emailFrom',
    CREATED_AT: 'createdAt'
};

/**
 * Package Database Schema
 */
export const PACKAGE_SCHEMA = {
    ID: 'id',
    USER_EMAIL: 'userEmail',
    SENDER: 'sender',
    DELIVERY_DATE: 'deliveryDate',
    DELIVERY_TIME: 'deliveryTime',
    EMAIL_ID: 'emailId',
    EMAIL_SUBJECT: 'emailSubject',
    EMAIL_FROM: 'emailFrom',
    EMAIL_SNIPPET: 'emailSnippet',
    PICKED_UP: 'pickedUp',
    CREATED_AT: 'createdAt'
};

/**
 * Scan History Database Schema
 */
export const SCAN_HISTORY_SCHEMA = {
    ID: 'id',
    SCAN_DATE: 'scanDate',
    EMAILS_SCANNED: 'emailsScanned',
    EARLIEST_EMAIL_TIMESTAMP: 'earliestEmailTimestamp',
    LATEST_EMAIL_TIMESTAMP: 'latestEmailTimestamp',
    START_DATE_REQUESTED: 'startDateRequested',
    END_DATE_REQUESTED: 'endDateRequested',
    PACKAGES_FOUND: 'packagesFound'
};

/**
 * Subscription Scan History Database Schema
 */
export const SUBSCRIPTION_SCAN_HISTORY_SCHEMA = {
    ID: 'id',
    SCAN_DATE: 'scanDate',
    START_DATE: 'startDate',
    END_DATE: 'endDate',
    EMAILS_SCANNED: 'emailsScanned',
    SUBSCRIPTIONS_FOUND: 'subscriptionsFound',
    CALENDAR_EVENTS_CREATED: 'calendarEventsCreated'
};

/**
 * Subscription Calendar Events Database Schema
 */
export const SUBSCRIPTION_CALENDAR_EVENTS_SCHEMA = {
    ID: 'id',
    EMAIL_ID: 'emailId',
    SUBSCRIPTION_NAME: 'subscriptionName',
    CALENDAR_EVENT_ID: 'calendarEventId',
    CREATED_DATE: 'createdDate',
    EMAIL_SUBJECT: 'emailSubject',
    EMAIL_FROM: 'emailFrom'
};

/**
 * Error Messages
 */
export const ERROR_MESSAGES = {
    NO_AUTH_TOKEN: 'No auth token received. Check OAuth configuration.',
    CHROME_IDENTITY_UNAVAILABLE: 'Chrome identity API not available. Check manifest permissions.',
    LLM_NOT_AVAILABLE: 'LanguageModel API is not available on this device',
    GMAIL_SEARCH_FAILED: 'Failed to search Gmail',
    EMAIL_FETCH_FAILED: 'Failed to fetch email',
    CALENDAR_EVENT_FAILED: 'Failed to create calendar event',
    LLM_CALL_FAILED: 'LLM call failed',
    DB_INIT_FAILED: 'Failed to initialize package database',
    PACKAGE_SAVE_FAILED: 'Failed to save package to database',
    PACKAGE_FETCH_FAILED: 'Failed to fetch packages from database'
};