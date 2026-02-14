# Email Notification Setup

How to configure email notifications for the OPERA sync script.

---

## Overview

The sync script can send email notifications when:
- File processing fails (after multiple consecutive errors)
- Salesforce connection fails
- System recovers from errors

**Two methods supported:**
1. **Gmail API OAuth2** (recommended) — uses `googleapis` library, no app passwords needed
2. **Standard SMTP** — fallback if Gmail OAuth is not configured

---

## Method 1: Gmail API OAuth2 (Recommended)

### Step 1: Get Gmail OAuth Credentials

```bash
node get-gmail-oauth-token.js
```

Set `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` in your environment or edit the file directly. The script opens a browser for Google authorization and returns a refresh token.

### Step 2: Update .env

```bash
EMAIL_ENABLED=true

# Gmail OAuth2
SMTP_USER=your-email@gmail.com
GMAIL_CLIENT_ID=your-google-client-id
GMAIL_CLIENT_SECRET=your-google-client-secret
GMAIL_REFRESH_TOKEN=your-gmail-refresh-token

# Email Addresses
EMAIL_FROM=OPERA Sync <your-email@gmail.com>
EMAIL_TO=admin@yourcompany.com

# Notification Behavior
ERROR_THRESHOLD=3
ERROR_NOTIFICATION_THROTTLE=15
```

### Step 3: Test

```bash
npm run test:notifications
```

---

## Method 2: Standard SMTP (Fallback)

If `GMAIL_CLIENT_ID` is not set, the notifier falls back to standard SMTP.

```bash
EMAIL_ENABLED=true

# SMTP Configuration
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-app-password

EMAIL_FROM=OPERA Sync <your-email@gmail.com>
EMAIL_TO=admin@yourcompany.com
```

For Gmail SMTP, use an App Password (not your regular password):
1. Go to https://myaccount.google.com/apppasswords
2. Generate a password for "Mail"
3. Use that 16-character password as `SMTP_PASSWORD`

---

## Notification Behavior

**ERROR_THRESHOLD** (default: 3)
- Number of consecutive errors before sending a notification
- Set to 1 for immediate alerts

**ERROR_NOTIFICATION_THROTTLE** (default: 15 minutes)
- Minimum time between error notifications
- Prevents email spam during extended outages

---

## Alternative: Slack Notifications

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

Create a webhook at: https://api.slack.com/messaging/webhooks

You can enable both email and Slack simultaneously.

---

## Troubleshooting

**Gmail OAuth "invalid_grant"** — Refresh token may have expired. Re-run `node get-gmail-oauth-token.js`.

**SMTP "Invalid login"** — For Gmail, use an App Password. For Outlook, check that SMTP is enabled in account settings.

**Emails not received** — Check spam folder. Verify `EMAIL_TO` address. Check `logs/opera-sync.log` for send errors.

**Connection timeout** — Firewall may be blocking SMTP ports (587/465). Check with IT.
