# Email Notification Setup

This guide shows you how to configure email notifications for the OPERA sync script.

---

## Overview

The sync script can send you email notifications when:
- ⚠️ File processing fails (after multiple consecutive errors)
- ⚠️ Salesforce connection fails
- ✅ System recovers from errors
- 📊 Daily summary reports (optional)

**Features:**
- Smart throttling (won't spam you with every error)
- Configurable error threshold
- HTML formatted emails
- Support for all major email providers

---

## Quick Setup

### Step 1: Update .env File

Add these settings to your `.env` file:

```bash
# Enable email notifications
EMAIL_ENABLED=true

# SMTP Configuration (example: Gmail)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-app-password

# Email Addresses
EMAIL_FROM=OPERA Sync <your-email@gmail.com>
EMAIL_TO=admin@yourcompany.com

# Notification Behavior
ERROR_THRESHOLD=3
ERROR_NOTIFICATION_THROTTLE=15
```

### Step 2: Test Configuration

```bash
node test-notifications.js
```

This will:
- Verify SMTP settings
- Send a test email
- Confirm notifications are working

---

## Provider-Specific Configuration

### Gmail

**SMTP Settings:**
```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-app-password
```

**Important:** Use an App Password, not your regular password!

**Get App Password:**
1. Go to https://myaccount.google.com/security
2. Enable 2-Step Verification (if not already enabled)
3. Go to https://myaccount.google.com/apppasswords
4. Select "App: Mail" and "Device: Windows Computer"
5. Click "Generate"
6. Copy the 16-character password
7. Use this as `SMTP_PASSWORD`

**Alternative:** Enable "Less secure app access" (not recommended)
- https://myaccount.google.com/lesssecureapps
- Not available if 2FA is enabled

---

### Outlook / Office 365

**SMTP Settings:**
```bash
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@outlook.com
SMTP_PASSWORD=your-password
```

**Note:** Use your regular account password, or create an App Password if your organization requires it.

---

### Yahoo Mail

**SMTP Settings:**
```bash
SMTP_HOST=smtp.mail.yahoo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@yahoo.com
SMTP_PASSWORD=your-app-password
```

**Get App Password:**
1. Go to https://login.yahoo.com/account/security
2. Click "Generate app password"
3. Select "Other app"
4. Name it "OPERA Sync"
5. Click "Generate"
6. Use the generated password as `SMTP_PASSWORD`

---

### Custom SMTP Server

**For your own mail server:**
```bash
SMTP_HOST=mail.yourcompany.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=noreply@yourcompany.com
SMTP_PASSWORD=your-password

EMAIL_FROM=OPERA Sync <noreply@yourcompany.com>
```

**SSL/TLS Configuration:**
```bash
# For port 465 (SSL):
SMTP_PORT=465
SMTP_SECURE=true

# For port 587 (TLS/STARTTLS):
SMTP_PORT=587
SMTP_SECURE=false

# For port 25 (unencrypted - not recommended):
SMTP_PORT=25
SMTP_SECURE=false
```

---

## Configuration Options

### Email Addresses

**Single recipient:**
```bash
EMAIL_TO=admin@yourcompany.com
```

**Multiple recipients:**
```bash
EMAIL_TO=admin@yourcompany.com,it@yourcompany.com,manager@yourcompany.com
```

**Custom "From" name:**
```bash
EMAIL_FROM=OPERA Sync Bot <noreply@yourcompany.com>
```

### Notification Behavior

**ERROR_THRESHOLD** (default: 3)
- Number of consecutive errors before sending notification
- Prevents alerts for one-off issues
- Set to 1 for immediate alerts

```bash
ERROR_THRESHOLD=3  # Alert after 3 consecutive errors
```

**ERROR_NOTIFICATION_THROTTLE** (default: 15 minutes)
- Minimum time between error notifications
- Prevents email spam during extended outages
- Set to 0 for no throttling

```bash
ERROR_NOTIFICATION_THROTTLE=15  # Max one error email per 15 minutes
```

### Example Scenarios

**Aggressive monitoring (immediate alerts):**
```bash
ERROR_THRESHOLD=1
ERROR_NOTIFICATION_THROTTLE=0
```

**Balanced (recommended):**
```bash
ERROR_THRESHOLD=3
ERROR_NOTIFICATION_THROTTLE=15
```

**Relaxed (only persistent issues):**
```bash
ERROR_THRESHOLD=5
ERROR_NOTIFICATION_THROTTLE=30
```

---

## Email Content

### Error Notification

**Subject:** 🚨 OPERA Sync Error - File Processing Failed

**Includes:**
- Filename that failed
- Error message
- Number of consecutive errors
- Timestamp
- Troubleshooting suggestions

### Salesforce Connection Error

**Subject:** 🚨 OPERA Sync - Salesforce Connection Error

**Includes:**
- Error details
- Possible causes
- Action items

### Recovery Notification

**Subject:** ✅ OPERA Sync - Recovered

**Includes:**
- Previous error count
- Files successfully processed
- Recovery timestamp

---

## Testing

### Test Email Configuration

```bash
# Run test script
node test-notifications.js
```

**What it does:**
1. Verifies SMTP settings
2. Sends test email
3. Reports success/failure

### Trigger Test Error

```bash
# Temporarily lower threshold
ERROR_THRESHOLD=1

# Create an invalid file to trigger error
echo "invalid data" > C:\OPERA\Exports\Reservations\test-error.csv

# Check logs and email
```

---

## Troubleshooting

### "EAUTH: Invalid login"

**Cause:** Incorrect username/password or authentication method not allowed

**Solutions:**
1. **Gmail:** Use App Password instead of regular password
2. **Outlook:** Check password is correct
3. **Corporate:** Contact IT about SMTP access

### "ECONNECTION: Connection timeout"

**Cause:** Cannot reach SMTP server

**Solutions:**
1. Check firewall rules
2. Verify SMTP_HOST and SMTP_PORT
3. Try different port (587, 465, 25)
4. Check if SMTP is blocked by network policy

### "ENOTFOUND: getaddrinfo"

**Cause:** Cannot resolve SMTP server hostname

**Solutions:**
1. Check DNS settings
2. Verify SMTP_HOST spelling
3. Try IP address instead of hostname

### Emails Not Being Received

**Check:**
1. Spam folder
2. Email logs: `logs/opera-sync.log`
3. SMTP server limits (daily send limit)
4. EMAIL_TO address is correct

### "Self signed certificate"

**Cause:** Server uses self-signed SSL certificate

**Solution:** Add to .env:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0
```

**Warning:** Only use this for trusted internal servers!

---

## Alternative: Slack Notifications

If email setup is difficult, use Slack instead:

```bash
# Disable email
EMAIL_ENABLED=false

# Enable Slack
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

**Get Slack Webhook:**
1. Go to https://api.slack.com/messaging/webhooks
2. Click "Create your Slack app"
3. Choose "From scratch"
4. Name: "OPERA Sync"
5. Choose workspace
6. Click "Incoming Webhooks"
7. Activate webhooks
8. Click "Add New Webhook to Workspace"
9. Choose channel
10. Copy webhook URL

---

## Security Best Practices

### Protect Credentials

**File permissions:**
```bash
# Linux/macOS
chmod 600 .env

# Windows
icacls .env /inheritance:r /grant:r "%USERNAME%:F"
```

### Use App Passwords

Never use your main email password. Always create app-specific passwords:
- ✅ Limited permissions
- ✅ Can be revoked independently
- ✅ Doesn't expose main account

### Dedicated Email Account

Consider using a dedicated account:
```bash
SMTP_USER=opera-sync@yourcompany.com
```

Benefits:
- Easier to monitor
- Separate from personal email
- Clear audit trail

---

## Monitoring Email Deliverability

### Check Logs

```bash
# View recent email activity
type logs\opera-sync.log | findstr "Email"

# Linux/macOS
grep "Email" logs/opera-sync.log
```

### Test Regularly

```bash
# Monthly test
node test-notifications.js
```

### Monitor Bounce Rate

Check your email provider's bounce/delivery reports.

---

## FAQ

**Q: Will I get spammed with emails?**
A: No. Notifications are throttled and only sent after multiple consecutive errors.

**Q: Can I disable email for certain error types?**
A: Currently all errors use the same notification settings. Set `ERROR_THRESHOLD` higher to reduce notifications.

**Q: How do I send to multiple people?**
A: Use comma-separated email addresses in `EMAIL_TO`:
```bash
EMAIL_TO=admin@company.com,it@company.com
```

**Q: Can I use both email and Slack?**
A: Yes! Both can be enabled simultaneously. Set both `EMAIL_ENABLED=true` and `SLACK_WEBHOOK_URL`.

**Q: What if my SMTP requires authentication?**
A: Most do. Set `SMTP_USER` and `SMTP_PASSWORD`. If your SMTP doesn't require auth, you can omit these.

**Q: Does this work behind a corporate firewall?**
A: Maybe. Check with IT:
- Is outbound SMTP allowed?
- What ports are allowed (587, 465, 25)?
- Is a proxy required?

**Q: Can I customize email templates?**
A: Yes! Edit `src/notifier.js` and modify the email HTML/text in the notification methods.

---

## Summary

**Minimal setup:**
```bash
EMAIL_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-app-password
EMAIL_TO=admin@yourcompany.com
```

**Test:**
```bash
node test-notifications.js
```

**Done!** You'll now receive email alerts when issues occur.
