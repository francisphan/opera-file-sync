# Email Notifications - Quick Reference

Get notified when something breaks!

---

## Quick Setup (Gmail Example)

### 1. Get Gmail App Password

1. Go to https://myaccount.google.com/apppasswords
2. Select "Mail" and "Windows Computer"
3. Click "Generate"
4. Copy the 16-character password

### 2. Add to .env

```bash
EMAIL_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=abcd efgh ijkl mnop
EMAIL_TO=admin@yourcompany.com
ERROR_THRESHOLD=3
ERROR_NOTIFICATION_THROTTLE=15
```

### 3. Test

```bash
npm run test:notifications
```

Check your email inbox for test message!

---

## When You'll Get Notified

### ⚠️ Error Notifications

**Triggers:**
- File processing fails
- Salesforce connection fails
- After **3 consecutive errors** (configurable)

**Throttling:**
- Maximum **1 email per 15 minutes** (configurable)
- Prevents spam during outages

**Email includes:**
- Filename that failed
- Error message
- Troubleshooting steps
- Timestamps

### ✅ Recovery Notifications

**Triggers:**
- System recovers after errors
- Files process successfully again

**Email includes:**
- Previous error count
- Files successfully processed
- Recovery confirmation

---

## Configuration Options

### Smart Throttling

```bash
# Alert after 3 consecutive errors
ERROR_THRESHOLD=3

# Maximum one email per 15 minutes
ERROR_NOTIFICATION_THROTTLE=15
```

**Example scenarios:**

**Immediate alerts (every error):**
```bash
ERROR_THRESHOLD=1
ERROR_NOTIFICATION_THROTTLE=0
```

**Balanced (recommended):**
```bash
ERROR_THRESHOLD=3
ERROR_NOTIFICATION_THROTTLE=15
```

**Only persistent issues:**
```bash
ERROR_THRESHOLD=5
ERROR_NOTIFICATION_THROTTLE=30
```

### Multiple Recipients

```bash
EMAIL_TO=admin@company.com,it@company.com,manager@company.com
```

---

## Other Email Providers

### Outlook / Office 365

```bash
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@outlook.com
SMTP_PASSWORD=your-password
```

### Yahoo

```bash
SMTP_HOST=smtp.mail.yahoo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@yahoo.com
SMTP_PASSWORD=your-app-password
```

Get Yahoo App Password: https://login.yahoo.com/account/security

### Custom SMTP

```bash
SMTP_HOST=mail.yourcompany.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=noreply@yourcompany.com
SMTP_PASSWORD=your-password
```

---

## Alternative: Slack Notifications

Prefer Slack over email? No problem!

### Setup

1. Create Slack webhook: https://api.slack.com/messaging/webhooks
2. Add to .env:

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

3. Test:

```bash
npm run test:notifications
```

**You can enable both email AND Slack!**

---

## Testing

### Test Notifications

```bash
# Test email and Slack configuration
npm run test:notifications
```

This sends test messages to verify everything works.

### Test with Real Error

```bash
# Create an invalid file to trigger error
echo "invalid data" > C:\OPERA\Exports\Reservations\test-error.csv

# Watch logs
tail -f logs/opera-sync.log

# After 3 errors, you'll get an email
```

---

## Troubleshooting

### "Invalid login" Error

**Gmail:**
- Use App Password, not regular password
- Enable 2-Step Verification first

**Outlook:**
- Check password is correct
- May need to enable SMTP in account settings

### Emails Not Received

**Check:**
1. Spam/Junk folder
2. EMAIL_TO address is correct
3. Logs: `logs/opera-sync.log`
4. Test with: `npm run test:notifications`

### Connection Timeout

**Causes:**
- Firewall blocking SMTP
- Wrong port number
- Network issues

**Try:**
- Different port (587, 465, or 25)
- Check with IT about firewall rules

### Still Having Issues?

See full guide: `EMAIL_SETUP.md`

---

## Example Email

**Subject:** 🚨 OPERA Sync Error - File Processing Failed

```
File: reservations_2024_02_03.csv
Error: Cannot connect to Salesforce
Time: 2024-02-03 14:30:00
Consecutive Errors: 3

Action Required:
- Check the logs at logs/opera-sync.log
- Review the failed file in the Failed directory
- Verify Salesforce credentials and connectivity
- Check OPERA export format
```

---

## FAQ

**Q: Will I get spammed?**
A: No! Throttling prevents spam. Default: 1 email per 15 minutes after 3 consecutive errors.

**Q: Can I disable notifications?**
A: Yes, set `EMAIL_ENABLED=false` in .env

**Q: Does this work in the standalone .exe?**
A: Yes! All notification features work in the compiled executable.

**Q: What if email fails?**
A: Errors are logged in `logs/opera-sync.log` and displayed in console regardless.

---

## Summary

**Minimum configuration:**
```bash
EMAIL_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-app-password
EMAIL_TO=admin@company.com
```

**Test:**
```bash
npm run test:notifications
```

**Done!** 🎉

You'll now get alerts when the sync script encounters issues.

For detailed setup instructions, see: `EMAIL_SETUP.md`
