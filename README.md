# Gmail Tracker

A Chrome extension that scans your Gmail to track package deliveries and manage subscriptions.

## What It Does

📦 **Package Tracking** - Find delivery emails and track which packages you've picked up  
💳 **Subscription Management** - Detect billing emails and create calendar reminders  
🤖 **AI-Powered** - Uses Chrome's built-in AI to identify relevant emails  
🔄 **Real-time Sync** - Progress bars sync instantly between popup and widget

## Quick Start

1. Download and load the extension in Chrome (`chrome://extensions/` → Developer mode → Load unpacked)
2. Click the 📦 icon in your toolbar
3. Grant Gmail permissions when prompted
4. Start scanning!

## How to Use

**Extension Popup** (click 📦 icon):
- **Packages**: Select date range → Click "Scan for Package Deliveries"
- **Subscriptions**: Click "Scan My Current Month Subscriptions"

**Floating Widget** (bottom-right corner of any page):
- **Left-click**: Open full widget
- **Right-click**: Quick scan menu

## What It Finds

**📦 Packages**: Delivery confirmations from any carrier (Amazon, FedEx, UPS, etc.)  
**💳 Subscriptions**: Billing emails from services (Netflix, Spotify, Adobe, etc.)  

**Smart Features**:
- AI filters out promotional emails and false positives
- Creates calendar reminders for subscription renewals
- Tracks pickup status for packages
- Syncs progress between popup and widget instantly

## Privacy & Technical

**🔒 Privacy**: All data stays on your device. No external servers.  
**🛡️ Security**: Uses Google OAuth for secure Gmail access.  
**💾 Storage**: Local IndexedDB database.  
**🤖 AI**: Chrome's built-in LanguageModel API (requires Chrome 127+).

## Troubleshooting

**No results found**: Check spam folder, try different date ranges  
**AI not working**: Requires Chrome 127+ with AI features enabled  
**Auth issues**: Make sure you're signed into Gmail  
**Extension issues**: Refresh in `chrome://extensions/`

## Requirements

- Chrome 127+ (for AI features)
- Active Gmail account
- Calendar permissions (optional, for subscription reminders)

---

**Made with ❤️ for better email management**