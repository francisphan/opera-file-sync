#!/usr/bin/env node

/**
 * Salesforce OAuth Refresh Token Generator
 *
 * This script helps you obtain a Salesforce refresh token for the OPERA file sync integration.
 *
 * Usage:
 *   1. Install dependencies: npm install jsforce express open
 *   2. Edit the configuration below with your Connected App credentials
 *   3. Run: node get-refresh-token.js
 *   4. Browser will open - log in to Salesforce and approve
 *   5. Copy the refresh token displayed
 *
 * No certificate generation required.
 */

const jsforce = require('jsforce');
const express = require('express');
const open = require('open');

// ============================================================================
// CONFIGURATION - Edit these values with your Connected App credentials
// ============================================================================

const CONFIG = {
  // Consumer Key from your Salesforce Connected App
  CLIENT_ID: 'YOUR_CONSUMER_KEY_HERE',

  // Consumer Secret from your Salesforce Connected App
  CLIENT_SECRET: 'YOUR_CONSUMER_SECRET_HERE',

  // Callback URL (must match Connected App configuration)
  REDIRECT_URI: 'http://localhost:3000/oauth/callback',

  // Login URL
  // Use 'https://login.salesforce.com' for production
  // Use 'https://test.salesforce.com' for sandbox
  INSTANCE_URL: 'https://login.salesforce.com',

  // Port for local callback server
  PORT: 3000
};

// ============================================================================
// Validation
// ============================================================================

if (CONFIG.CLIENT_ID === 'YOUR_CONSUMER_KEY_HERE' || !CONFIG.CLIENT_ID) {
  console.error('\n❌ ERROR: Please edit this file and set your CLIENT_ID\n');
  console.error('Steps:');
  console.error('1. Open this file in a text editor');
  console.error('2. Find the CONFIG section');
  console.error('3. Replace YOUR_CONSUMER_KEY_HERE with your actual Consumer Key');
  console.error('4. Replace YOUR_CONSUMER_SECRET_HERE with your actual Consumer Secret');
  console.error('5. Save and run again\n');
  console.error('See SALESFORCE_OAUTH_SETUP.md for detailed instructions.\n');
  process.exit(1);
}

if (CONFIG.CLIENT_SECRET === 'YOUR_CONSUMER_SECRET_HERE' || !CONFIG.CLIENT_SECRET) {
  console.error('\n❌ ERROR: Please edit this file and set your CLIENT_SECRET\n');
  console.error('See SALESFORCE_OAUTH_SETUP.md for detailed instructions.\n');
  process.exit(1);
}

// ============================================================================
// OAuth Flow
// ============================================================================

const app = express();

// OAuth2 configuration
const oauth2 = new jsforce.OAuth2({
  clientId: CONFIG.CLIENT_ID,
  clientSecret: CONFIG.CLIENT_SECRET,
  redirectUri: CONFIG.REDIRECT_URI,
  loginUrl: CONFIG.INSTANCE_URL
});

// OAuth callback handler
app.get('/oauth/callback', async (req, res) => {
  const { code, error, error_description } = req.query;

  // Handle OAuth errors
  if (error) {
    console.error('\n❌ OAuth Error:', error);
    console.error('Description:', error_description);
    res.send(`
      <h1>❌ OAuth Error</h1>
      <p><strong>Error:</strong> ${error}</p>
      <p><strong>Description:</strong> ${error_description}</p>
      <p>Check the console for details.</p>
      <p>Press Ctrl+C to stop the server.</p>
    `);
    return;
  }

  if (!code) {
    console.error('\n❌ No authorization code received');
    res.send(`
      <h1>❌ Error</h1>
      <p>No authorization code received from Salesforce.</p>
      <p>Please try again.</p>
      <p>Press Ctrl+C to stop the server.</p>
    `);
    return;
  }

  try {
    console.log('\n⏳ Exchanging authorization code for tokens...');

    // Exchange authorization code for tokens
    const conn = new jsforce.Connection({ oauth2 });
    await conn.authorize(code);

    // Get user info
    const identity = await conn.identity();

    console.log('\n' + '='.repeat(70));
    console.log('✅ SUCCESS! OAuth tokens obtained');
    console.log('='.repeat(70));
    console.log('\nSalesforce User Information:');
    console.log('  Username:', identity.username);
    console.log('  User ID:', identity.user_id);
    console.log('  Organization ID:', identity.organization_id);
    console.log('\nOAuth Credentials:');
    console.log('  Instance URL:', conn.instanceUrl);
    console.log('  Client ID:', CONFIG.CLIENT_ID);
    console.log('  Client Secret:', CONFIG.CLIENT_SECRET.substring(0, 10) + '...');
    console.log('  Refresh Token:', conn.refreshToken);
    console.log('\n' + '='.repeat(70));
    console.log('📋 Copy the credentials above and save them securely!');
    console.log('='.repeat(70));
    console.log('\nNext steps:');
    console.log('  • For standalone script: Add to .env file');
    console.log('  • For AWS Lambda: Add to AWS Secrets Manager');
    console.log('\nPress Ctrl+C to stop the server.\n');

    // Display success page with credentials
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>OAuth Success</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            max-width: 900px;
            margin: 50px auto;
            padding: 20px;
            background: #f5f5f5;
          }
          .container {
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          }
          h1 { color: #28a745; margin-top: 0; }
          h2 { color: #333; border-bottom: 2px solid #28a745; padding-bottom: 10px; }
          pre {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 5px;
            overflow-x: auto;
            border-left: 4px solid #28a745;
          }
          .warning {
            background: #fff3cd;
            border: 1px solid #ffc107;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
          }
          .success {
            background: #d4edda;
            border: 1px solid #28a745;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
          }
          .info { color: #666; font-size: 14px; }
          table { width: 100%; border-collapse: collapse; margin: 20px 0; }
          td { padding: 8px; border-bottom: 1px solid #ddd; }
          td:first-child { font-weight: bold; width: 200px; color: #555; }
          .copy-btn {
            background: #007bff;
            color: white;
            border: none;
            padding: 8px 15px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            margin-top: 10px;
          }
          .copy-btn:hover { background: #0056b3; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>✅ Success! OAuth Tokens Obtained</h1>

          <div class="success">
            <strong>Authentication successful!</strong> You can now use these credentials to sync OPERA data to Salesforce.
          </div>

          <h2>Salesforce User Information</h2>
          <table>
            <tr><td>Username:</td><td>${identity.username}</td></tr>
            <tr><td>User ID:</td><td>${identity.user_id}</td></tr>
            <tr><td>Organization ID:</td><td>${identity.organization_id}</td></tr>
          </table>

          <h2>OAuth Credentials</h2>
          <pre id="credentials">{
  "instanceUrl": "${conn.instanceUrl}",
  "clientId": "${CONFIG.CLIENT_ID}",
  "clientSecret": "${CONFIG.CLIENT_SECRET}",
  "refreshToken": "${conn.refreshToken}"
}</pre>
          <button class="copy-btn" onclick="copyCredentials()">📋 Copy to Clipboard</button>

          <h2>Next Steps</h2>

          <h3>For Standalone Script (Option 3):</h3>
          <p>Create a <code>.env</code> file in your project directory:</p>
          <pre id="envFile">SF_INSTANCE_URL=${conn.instanceUrl}
SF_CLIENT_ID=${CONFIG.CLIENT_ID}
SF_CLIENT_SECRET=${CONFIG.CLIENT_SECRET}
SF_REFRESH_TOKEN=${conn.refreshToken}</pre>
          <button class="copy-btn" onclick="copyEnv()">📋 Copy .env Format</button>

          <h3>For AWS Lambda (Option 4):</h3>
          <p>Store in AWS Secrets Manager:</p>
          <pre id="awsCmd">aws secretsmanager create-secret \\
  --name opera-sync/salesforce \\
  --secret-string '${JSON.stringify({
    instanceUrl: conn.instanceUrl,
    clientId: CONFIG.CLIENT_ID,
    clientSecret: CONFIG.CLIENT_SECRET,
    refreshToken: conn.refreshToken
  })}'</pre>
          <button class="copy-btn" onclick="copyAws()">📋 Copy AWS Command</button>

          <div class="warning">
            <strong>⚠️ Security Reminder:</strong>
            <ul style="margin: 10px 0;">
              <li>Save these credentials securely</li>
              <li>Never commit .env files to git</li>
              <li>Use AWS Secrets Manager for production</li>
              <li>Restrict file permissions: <code>chmod 600 .env</code></li>
            </ul>
          </div>

          <p class="info">
            You can now close this window and stop the server (Ctrl+C in the terminal).
          </p>
        </div>

        <script>
          function copyCredentials() {
            const text = document.getElementById('credentials').textContent;
            navigator.clipboard.writeText(text);
            alert('Credentials copied to clipboard!');
          }
          function copyEnv() {
            const text = document.getElementById('envFile').textContent;
            navigator.clipboard.writeText(text);
            alert('.env format copied to clipboard!');
          }
          function copyAws() {
            const text = document.getElementById('awsCmd').textContent;
            navigator.clipboard.writeText(text);
            alert('AWS command copied to clipboard!');
          }
        </script>
      </body>
      </html>
    `);

  } catch (err) {
    console.error('\n❌ Error exchanging authorization code:', err.message);
    console.error('Full error:', err);

    res.send(`
      <h1>❌ Error</h1>
      <h2>Failed to exchange authorization code for tokens</h2>
      <pre>${err.message}</pre>
      <h3>Common causes:</h3>
      <ul>
        <li>Client ID or Client Secret is incorrect</li>
        <li>Connected App not fully propagated (wait 10 minutes after creation)</li>
        <li>Callback URL mismatch</li>
        <li>Authorization code already used (try again)</li>
      </ul>
      <p>Check the console for detailed error information.</p>
      <p>Press Ctrl+C to stop the server and try again.</p>
    `);
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send(`
    <h1>Salesforce OAuth Server Running</h1>
    <p>Waiting for OAuth callback...</p>
    <p>If you haven't been redirected to Salesforce, check the console for the authorization URL.</p>
  `);
});

// Start server and initiate OAuth flow
const server = app.listen(CONFIG.PORT, async () => {
  console.log('\n' + '='.repeat(70));
  console.log('Salesforce OAuth Refresh Token Generator');
  console.log('='.repeat(70));
  console.log('\nConfiguration:');
  console.log('  Client ID:', CONFIG.CLIENT_ID);
  console.log('  Client Secret:', CONFIG.CLIENT_SECRET.substring(0, 10) + '...');
  console.log('  Instance URL:', CONFIG.INSTANCE_URL);
  console.log('  Redirect URI:', CONFIG.REDIRECT_URI);
  console.log('  Local Port:', CONFIG.PORT);
  console.log('\n' + '='.repeat(70));
  console.log('Starting OAuth flow...');
  console.log('='.repeat(70));

  // Generate authorization URL
  const authUrl = oauth2.getAuthorizationUrl({
    scope: 'api refresh_token offline_access'
  });

  console.log('\n📱 Opening browser to Salesforce login...\n');
  console.log('Authorization URL:');
  console.log(authUrl);
  console.log('\nIf browser does not open automatically, copy the URL above and paste it in your browser.\n');
  console.log('After logging in and approving:');
  console.log('  1. You\'ll be redirected to localhost');
  console.log('  2. Credentials will be displayed');
  console.log('  3. Copy and save them securely');
  console.log('  4. Press Ctrl+C to stop the server\n');

  try {
    // Try to open browser automatically
    await open(authUrl);
    console.log('✅ Browser opened successfully\n');
  } catch (err) {
    console.log('⚠️  Could not open browser automatically');
    console.log('Please manually copy the authorization URL above and paste it in your browser.\n');
  }
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down server...');
  server.close(() => {
    console.log('Server stopped.');
    process.exit(0);
  });
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('\n❌ Uncaught Exception:', err.message);
  console.error('\nFull error:', err);
  console.error('\nPlease check your configuration and try again.');
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('\n❌ Unhandled Rejection:', err.message);
  console.error('\nFull error:', err);
  console.error('\nPlease check your configuration and try again.');
  process.exit(1);
});
