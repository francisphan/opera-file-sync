# Salesforce OAuth Setup - Obtaining Refresh Token

This guide walks you through setting up OAuth authentication with Salesforce and obtaining a refresh token for the OPERA file sync integration.

---

## Overview

The file export approaches use **OAuth 2.0 Refresh Token Flow** to authenticate with Salesforce. This requires:
- A Salesforce Connected App
- Initial OAuth authorization (one-time)
- A refresh token that can be reused indefinitely

**No certificate generation required.**

---

## Prerequisites

- Salesforce account with API access
- Administrator or equivalent permissions to create Connected Apps
- Node.js installed (for token generation script)

---

## Step 1: Create Salesforce Connected App

### 1.1 Navigate to Setup

1. Log in to Salesforce
2. Click the **gear icon** (top right) → **Setup**
3. In Quick Find, search for **App Manager**
4. Click **New Connected App**

### 1.2 Configure Basic Information

- **Connected App Name:** `OPERA File Sync`
- **API Name:** `OPERA_File_Sync` (auto-generated)
- **Contact Email:** Your email address

### 1.3 Enable OAuth Settings

Check **Enable OAuth Settings**

**Callback URL:**
```
http://localhost:3000/oauth/callback
```

**Selected OAuth Scopes:**
- `Access and manage your data (api)`
- `Perform requests on your behalf at any time (refresh_token, offline_access)`
- `Access your basic information (id, profile, email, address, phone)`

### 1.4 Additional Settings

- **Require Secret for Web Server Flow:** Checked
- **Require Secret for Refresh Token Flow:** Checked (if available)
- **Enable Client Credentials Flow:** Unchecked (not needed)

### 1.5 Save

1. Click **Save**
2. Click **Continue**
3. Wait 2-10 minutes for the app to propagate

### 1.6 Note Your Credentials

After creation, you'll see:
- **Consumer Key** (this is your `clientId`)
- **Consumer Secret** (click to reveal - this is your `clientSecret`)

**Save these values securely.**

---

## Step 2: Obtain Refresh Token

You have three options to obtain the refresh token.

### Option A: Using Node.js Script (Recommended)

Create a one-time script to obtain the refresh token.

#### Create `get-refresh-token.js`

```javascript
const jsforce = require('jsforce');
const express = require('express');
const open = require('open');

// Configuration
const CLIENT_ID = 'YOUR_CONSUMER_KEY';
const CLIENT_SECRET = 'YOUR_CONSUMER_SECRET';
const REDIRECT_URI = 'http://localhost:3000/oauth/callback';
const INSTANCE_URL = 'https://login.salesforce.com'; // Use https://test.salesforce.com for sandbox

const app = express();

// OAuth2 configuration
const oauth2 = new jsforce.OAuth2({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  redirectUri: REDIRECT_URI,
  loginUrl: INSTANCE_URL
});

// Start server
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.send('Error: No authorization code received');
  }

  try {
    // Exchange authorization code for tokens
    const conn = new jsforce.Connection({ oauth2 });
    await conn.authorize(code);

    // Display tokens
    const result = `
      <h1>✓ Success! OAuth tokens obtained</h1>
      <h2>Salesforce Credentials</h2>
      <pre>
{
  "instanceUrl": "${conn.instanceUrl}",
  "clientId": "${CLIENT_ID}",
  "clientSecret": "${CLIENT_SECRET}",
  "refreshToken": "${conn.refreshToken}"
}
      </pre>
      <p><strong>Save these credentials securely!</strong></p>
      <p>For standalone script: Add to <code>.env</code> file</p>
      <p>For AWS: Add to AWS Secrets Manager</p>
      <p style="color: red;">You can close this window and stop the server (Ctrl+C)</p>
    `;

    res.send(result);

    console.log('\n=================================');
    console.log('✓ SUCCESS! Refresh token obtained');
    console.log('=================================\n');
    console.log('Instance URL:', conn.instanceUrl);
    console.log('Client ID:', CLIENT_ID);
    console.log('Client Secret:', CLIENT_SECRET);
    console.log('Refresh Token:', conn.refreshToken);
    console.log('\n=================================');
    console.log('Save these credentials securely!');
    console.log('=================================\n');

  } catch (err) {
    console.error('Error:', err);
    res.send(`<h1>Error</h1><pre>${err.message}</pre>`);
  }
});

// Start server and open browser
const PORT = 3000;
app.listen(PORT, async () => {
  const authUrl = oauth2.getAuthorizationUrl({ scope: 'api refresh_token offline_access' });
  console.log('Starting OAuth flow...');
  console.log(`Opening browser to: ${authUrl}`);
  console.log('\nIf browser does not open, manually visit:');
  console.log(authUrl);
  console.log('\n');

  // Open browser automatically
  await open(authUrl);
});
```

#### Run the Script

```bash
# Install dependencies
npm install jsforce express open

# Edit the script with your CLIENT_ID and CLIENT_SECRET
nano get-refresh-token.js

# Run the script
node get-refresh-token.js
```

#### What Happens

1. Browser opens to Salesforce login
2. Log in with your Salesforce credentials
3. Approve the OAuth authorization
4. Browser redirects to `http://localhost:3000/oauth/callback`
5. Script displays your refresh token
6. Copy the credentials and save securely
7. Press Ctrl+C to stop the server

---

### Option B: Using cURL (Manual)

#### Step 1: Get Authorization Code

Open this URL in your browser (replace `YOUR_CLIENT_ID`):

```
https://login.salesforce.com/services/oauth2/authorize?response_type=code&client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost:3000/oauth/callback&scope=api%20refresh_token%20offline_access
```

For sandbox, use `https://test.salesforce.com` instead.

After logging in and approving, you'll be redirected to:
```
http://localhost:3000/oauth/callback?code=AUTHORIZATION_CODE
```

Copy the `AUTHORIZATION_CODE` from the URL.

#### Step 2: Exchange Code for Refresh Token

```bash
curl -X POST https://login.salesforce.com/services/oauth2/token \
  -d "grant_type=authorization_code" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "redirect_uri=http://localhost:3000/oauth/callback" \
  -d "code=AUTHORIZATION_CODE"
```

Response:
```json
{
  "access_token": "00D...",
  "refresh_token": "5Aep...",
  "instance_url": "https://your-instance.salesforce.com",
  "id": "https://login.salesforce.com/id/...",
  "token_type": "Bearer",
  "issued_at": "1234567890"
}
```

Save the `refresh_token` value.

---

### Option C: Using Postman

1. **Create new request** in Postman
2. **Authorization tab:**
   - Type: `OAuth 2.0`
   - Add auth data to: `Request Headers`
3. **Configure New Token:**
   - Token Name: `Salesforce Token`
   - Grant Type: `Authorization Code`
   - Callback URL: `http://localhost:3000/oauth/callback`
   - Auth URL: `https://login.salesforce.com/services/oauth2/authorize`
   - Access Token URL: `https://login.salesforce.com/services/oauth2/token`
   - Client ID: `YOUR_CONSUMER_KEY`
   - Client Secret: `YOUR_CONSUMER_SECRET`
   - Scope: `api refresh_token offline_access`
   - State: (leave empty)
   - Client Authentication: `Send as Basic Auth header`
4. Click **Get New Access Token**
5. Log in to Salesforce and approve
6. Postman will display the tokens
7. Copy the `refresh_token` value

---

## Step 3: Store Credentials Securely

### For Standalone Script (Option 3)

Create `.env` file in your project directory:

```bash
# Salesforce OAuth Credentials
SF_INSTANCE_URL=https://your-instance.salesforce.com
SF_CLIENT_ID=3MVG9...
SF_CLIENT_SECRET=1234567890ABCDEF...
SF_REFRESH_TOKEN=5Aep861...
```

**Security:**
```bash
chmod 600 .env  # Restrict file permissions
echo ".env" >> .gitignore  # Never commit to git
```

### For AWS Lambda (Option 4)

Store in AWS Secrets Manager:

```bash
aws secretsmanager create-secret \
  --name opera-sync/salesforce \
  --description "Salesforce OAuth credentials for OPERA sync" \
  --secret-string '{
    "instanceUrl": "https://your-instance.salesforce.com",
    "clientId": "3MVG9...",
    "clientSecret": "1234567890ABCDEF...",
    "refreshToken": "5Aep861..."
  }'
```

Verify:
```bash
aws secretsmanager get-secret-value --secret-id opera-sync/salesforce
```

---

## Step 4: Test the Connection

### Test Script

Create `test-salesforce-connection.js`:

```javascript
const jsforce = require('jsforce');
require('dotenv').config();

async function testConnection() {
  const conn = new jsforce.Connection({
    oauth2: {
      clientId: process.env.SF_CLIENT_ID,
      clientSecret: process.env.SF_CLIENT_SECRET,
      redirectUri: 'http://localhost:3000/oauth/callback'
    },
    instanceUrl: process.env.SF_INSTANCE_URL,
    refreshToken: process.env.SF_REFRESH_TOKEN
  });

  try {
    // Test connection by querying user info
    const identity = await conn.identity();
    console.log('✓ Connection successful!');
    console.log('User ID:', identity.user_id);
    console.log('Username:', identity.username);
    console.log('Organization ID:', identity.organization_id);

    // Test API access
    const accounts = await conn.query('SELECT Id, Name FROM Account LIMIT 5');
    console.log(`✓ API access confirmed - found ${accounts.totalSize} accounts`);

    return true;
  } catch (err) {
    console.error('✗ Connection failed:', err.message);
    return false;
  }
}

testConnection();
```

Run:
```bash
npm install jsforce dotenv
node test-salesforce-connection.js
```

---

## Troubleshooting

### Error: "invalid_grant: authentication failure"

**Causes:**
- Refresh token has expired or been revoked
- Client ID/Secret mismatch
- Connected App not fully propagated (wait 10 minutes)

**Solutions:**
1. Verify Client ID and Secret are correct
2. Re-generate refresh token
3. Check Connected App is active

### Error: "redirect_uri_mismatch"

**Cause:** Redirect URI in OAuth request doesn't match Connected App configuration

**Solution:** Ensure callback URL exactly matches:
```
http://localhost:3000/oauth/callback
```

### Error: "invalid_client_id"

**Cause:** Consumer Key (Client ID) is incorrect

**Solution:** Double-check the Consumer Key from Connected App

### Token Works Initially, Then Fails

**Cause:** Refresh token may have been revoked

**Reasons tokens get revoked:**
- User password changed
- Admin revoked access
- Connected App modified
- Security policy changes

**Solution:** Re-generate refresh token using the OAuth flow

### Sandbox vs Production

**Production:**
```
https://login.salesforce.com
```

**Sandbox:**
```
https://test.salesforce.com
```

Make sure you're using the correct login URL for your environment.

---

## Security Best Practices

### 1. Protect Your Credentials

- ✅ Never commit `.env` files to git
- ✅ Use AWS Secrets Manager for production
- ✅ Rotate refresh tokens periodically
- ✅ Restrict file permissions (`chmod 600`)

### 2. Limit OAuth Scopes

Only request the scopes you need:
- `api` - Required for API access
- `refresh_token, offline_access` - Required for refresh tokens

Avoid unnecessary scopes like `full` or `web`.

### 3. Monitor Access

In Salesforce Setup:
- **Identity → OAuth and OpenID Connect Settings**
- Review active sessions
- Revoke unused tokens

### 4. Use IP Restrictions (Optional)

In Connected App settings:
- **IP Relaxation:** Relax IP restrictions or Enforce IP restrictions
- Configure trusted IP ranges

---

## Refresh Token Expiration

Salesforce refresh tokens **do not expire** unless:
- User password changes
- Admin revokes the token
- Connected App is modified/deleted
- User is deactivated
- Organization security policies change

**Best practice:** Implement token refresh logic in your application to handle expiration gracefully.

---

## Example Configuration Files

### .env (Standalone Script)

```bash
# Salesforce OAuth
SF_INSTANCE_URL=https://your-instance.salesforce.com
SF_CLIENT_ID=3MVG9A2kN3Bn17huW...
SF_CLIENT_SECRET=1234567890ABCDEF1234567890ABCDEF...
SF_REFRESH_TOKEN=5Aep861TSESvWeug_xvFHRBTTbf...

# OPERA Exports
EXPORT_DIR=C:\OPERA\Exports\Reservations
PROCESSED_DIR=C:\OPERA\Exports\Processed
```

### AWS Secrets Manager (Lambda)

```json
{
  "instanceUrl": "https://your-instance.salesforce.com",
  "clientId": "3MVG9A2kN3Bn17huW...",
  "clientSecret": "1234567890ABCDEF1234567890ABCDEF...",
  "refreshToken": "5Aep861TSESvWeug_xvFHRBTTbf..."
}
```

---

## Next Steps

After obtaining your refresh token:

1. **For Standalone Script:**
   - Add credentials to `.env` file
   - Run `test-salesforce-connection.js` to verify
   - Deploy the file sync script

2. **For AWS Lambda:**
   - Store credentials in Secrets Manager
   - Update SAM template with secret name
   - Deploy with `sam deploy`

3. **Configure OPERA Exports:**
   - See `INTEGRATION_OPTIONS.md` for OPERA configuration
   - Set up scheduled exports
   - Test end-to-end sync

---

## Additional Resources

- [Salesforce OAuth 2.0 Documentation](https://help.salesforce.com/s/articleView?id=sf.remoteaccess_authenticate.htm)
- [jsforce Documentation](https://jsforce.github.io/)
- [Connected App Setup Guide](https://help.salesforce.com/s/articleView?id=sf.connected_app_create.htm)

---

## Summary

1. ✅ Create Salesforce Connected App (no certificate needed)
2. ✅ Run OAuth flow to obtain refresh token (one-time)
3. ✅ Store credentials securely (.env or AWS Secrets Manager)
4. ✅ Test connection with test script
5. ✅ Deploy OPERA file sync integration

**No certificate generation required for this approach.**
