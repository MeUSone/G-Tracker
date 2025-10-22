# Gmail Package Delivery Tracker

A Chrome extension that automatically scans your Gmail for package delivery notifications and helps you track which packages you've picked up.

## Features

- **Automatic Gmail Scanning**: Searches your Gmail for delivery confirmation emails
- **Smart Package Detection**: Uses AI to identify delivery notifications from various carriers
- **Package Management**: Track which packages you've picked up
- **Floating Widget**: Access package tracker from any website
- **Date Range Filtering**: Scan specific time periods for deliveries
- **Scan Optimization**: Avoids re-scanning previously processed emails

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the extension folder
5. The extension icon (📦) will appear in your browser toolbar

## Setup

### Required Permissions

The extension requires the following permissions:
- **Gmail Access**: To read your emails and search for delivery notifications
- **Google Calendar**: To create pickup reminders (optional)
- **Storage**: To save package data locally
- **Active Tab**: To inject the floating widget

### OAuth Configuration

The extension uses Google OAuth for secure access to your Gmail. The OAuth client is pre-configured, but you may need to:

1. Click the extension icon to open the popup
2. Grant permissions when prompted
3. Allow access to Gmail and Calendar APIs

## How to Use

### Method 1: Extension Popup

1. Click the package tracker icon (📦) in your browser toolbar
2. Select the date range you want to scan
3. Click "🔍 Scan for Package Deliveries"
4. View found packages and mark them as picked up

### Method 2: Floating Widget

1. Look for the floating package icon (📦) in the bottom-right corner of any webpage
2. Click it to open the package tracker widget
3. Use the same scanning and management features as the popup

## Features Explained

### Package Detection

The extension searches for emails containing delivery-related keywords:
- "delivered"
- "shipment delivered" 
- "delivery confirmation"
- "package has arrived"
- "delivered to"

### AI-Powered Analysis

Uses Chrome's built-in AI (LanguageModel API) to:
- Determine if an email is actually a delivery notification
- Extract delivery dates and sender information
- Filter out false positives

### Smart Scanning

- **Scan History**: Remembers what date ranges have been scanned
- **Optimization**: Only scans new or missed date ranges
- **Duplicate Prevention**: Won't process the same email twice

### Package Management

- **Delivery Tracking**: Shows when packages were delivered
- **Pickup Status**: Mark packages as picked up to remove from active list
- **Email Links**: Quick access to original delivery emails
- **Monthly Grouping**: Organizes packages by delivery month

## Technical Details

### Architecture

- **Background Service Worker**: Handles Gmail API calls and data processing
- **Content Script**: Provides floating widget on all websites
- **Popup Interface**: Main extension interface
- **IndexedDB Storage**: Local package database

### APIs Used

- **Gmail API**: For searching and reading emails
- **Google Calendar API**: For creating pickup reminders
- **Chrome LanguageModel API**: For AI-powered email analysis
- **Chrome Identity API**: For OAuth authentication

### Data Storage

All package data is stored locally in your browser using IndexedDB:
- Package delivery information
- Scan history for optimization
- Pickup status tracking

## Privacy & Security

- **Local Storage**: All data stays on your device
- **OAuth Security**: Uses Google's secure authentication
- **No External Servers**: No data sent to third-party servers
- **Minimal Permissions**: Only requests necessary Gmail access

## Troubleshooting

### Common Issues

**"No auth token received"**
- Make sure you're signed into Gmail
- Try refreshing the page and clicking the extension again
- Check that popup blockers aren't interfering

**"LanguageModel API not available"**
- Ensure you're using Chrome 127+ with AI features enabled
- Check Chrome flags: `chrome://flags/#optimization-guide-on-device-model`

**No packages found**
- Try expanding the date range
- Check that delivery emails aren't in spam/trash
- Verify the emails contain delivery confirmation keywords

**Extension not loading**
- Refresh the extension in `chrome://extensions/`
- Check the console for error messages
- Ensure all files are present in the extension folder

### Debug Mode

To see detailed logs:
1. Right-click the extension icon → "Inspect popup"
2. Open the Console tab to view debug information
3. Check for any error messages or API failures

## Development

### File Structure

```
├── manifest.json          # Extension configuration
├── background.js          # Service worker with core logic
├── content.js            # Content script for floating widget
├── popup.html            # Extension popup interface
├── popup.js              # Popup functionality
├── constants.js          # Configuration constants
├── icon.png              # Extension icon
└── README.md             # This file
```

### Key Components

- **GmailScanner**: Handles Gmail API integration
- **LLMExtractor**: AI-powered email analysis
- **PackageDatabase**: IndexedDB storage management
- **PackageTracker**: Main orchestration logic

### Building

No build process required - this is a vanilla JavaScript extension.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly with various email types
5. Submit a pull request

## License

This project is open source. See the license file for details.

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Look for similar issues in the repository
3. Create a new issue with detailed information about your problem

---

**Note**: This extension requires Chrome 127+ for AI features and active Gmail account for email access.