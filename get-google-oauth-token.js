#!/usr/bin/env node

/**
 * Google OAuth Token Generator
 * Generates OAuth tokens for Gmail send + Google Sheets read/write
 */

require('dotenv').config();
const { google } = require('googleapis');
const express = require('express');
const open = require('open');

// ============================================================================
// CONFIGURATION - Edit these with your OAuth credentials from Google Cloud
// ============================================================================

const CONFIG = {
  CLIENT_ID: process.env.GMAIL_CLIENT_ID || 'YOUR_GMAIL_CLIENT_ID_HERE',
  CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET || 'YOUR_GMAIL_CLIENT_SECRET_HERE',
  REDIRECT_URI: 'http://localhost:3000/oauth/callback',
  PORT: 3000
};

// ============================================================================
// Validation
// ============================================================================

if (CONFIG.CLIENT_ID.includes('YOUR_CLIENT_ID')) {
  console.error('\n❌ ERROR: Please edit this file and set your CLIENT_ID and CLIENT_SECRET\n');
  console.error('Get these from: https://console.cloud.google.com/apis/credentials\n');
  process.exit(1);
}

// ============================================================================
// OAuth Flow
// ============================================================================

const app = express();

// OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  CONFIG.CLIENT_ID,
  CONFIG.CLIENT_SECRET,
  CONFIG.REDIRECT_URI
);

// Scopes for Gmail send + Google Sheets read/write
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/spreadsheets',
];

app.get('/oauth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    console.error('\n❌ OAuth Error:', error);
    res.send(`<h1>❌ Error: ${error}</h1>`);
    return;
  }

  if (!code) {
    console.error('\n❌ No authorization code received');
    res.send('<h1>❌ No authorization code received</h1>');
    return;
  }

  try {
    console.log('\n⏳ Exchanging authorization code for tokens...');

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    console.log('\n' + '='.repeat(70));
    console.log('✅ SUCCESS! Gmail OAuth tokens obtained');
    console.log('='.repeat(70));
    console.log('\nOAuth Tokens:');
    console.log('  Access Token:', tokens.access_token?.substring(0, 20) + '...');
    console.log('  Refresh Token:', tokens.refresh_token);
    console.log('  Expiry Date:', new Date(tokens.expiry_date || 0).toISOString());
    console.log('\n' + '='.repeat(70));
    console.log('📋 Copy the credentials below to your .env file');
    console.log('='.repeat(70));
    console.log('\nAdd these to your .env:');
    console.log(`GMAIL_CLIENT_ID=${CONFIG.CLIENT_ID}`);
    console.log(`GMAIL_CLIENT_SECRET=${CONFIG.CLIENT_SECRET}`);
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\nPress Ctrl+C to stop the server.\n');

    // Display success page
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Gmail OAuth Success</title>
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
          h1 { color: #28a745; }
          pre {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 5px;
            overflow-x: auto;
            border-left: 4px solid #28a745;
          }
          .success {
            background: #d4edda;
            border: 1px solid #28a745;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
          }
          .copy-btn {
            background: #007bff;
            color: white;
            border: none;
            padding: 8px 15px;
            border-radius: 4px;
            cursor: pointer;
            margin-top: 10px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>✅ Gmail OAuth Success!</h1>

          <div class="success">
            <strong>Authentication successful!</strong> You can now send emails via Gmail API.
          </div>

          <h2>Add to .env file:</h2>
          <pre id="envVars">GMAIL_CLIENT_ID=${CONFIG.CLIENT_ID}
GMAIL_CLIENT_SECRET=${CONFIG.CLIENT_SECRET}
GMAIL_REFRESH_TOKEN=${tokens.refresh_token}</pre>
          <button class="copy-btn" onclick="copyToClipboard()">📋 Copy to Clipboard</button>

          <h2>Next Steps:</h2>
          <ol>
            <li>Copy the environment variables above</li>
            <li>Add them to your <code>.env</code> file</li>
            <li>Remove or comment out the old SMTP_PASSWORD line</li>
            <li>Run <code>node test-notifications.js</code> to test</li>
          </ol>

          <p style="color: #666;">You can close this window and stop the server (Ctrl+C)</p>
        </div>

        <script>
          function copyToClipboard() {
            const text = document.getElementById('envVars').textContent;
            navigator.clipboard.writeText(text);
            alert('Copied to clipboard!');
          }
        </script>
      </body>
      </html>
    `);

  } catch (err) {
    console.error('\n❌ Error:', err.message);
    res.send(`<h1>❌ Error</h1><pre>${err.message}</pre>`);
  }
});

// Start server
const server = app.listen(CONFIG.PORT, async () => {
  console.log('\n' + '='.repeat(70));
  console.log('Gmail OAuth Token Generator');
  console.log('='.repeat(70));
  console.log('\n📱 Opening browser for Gmail authorization...\n');

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });

  console.log('Authorization URL:');
  console.log(authUrl);
  console.log('\nIf browser does not open, copy the URL above.\n');

  try {
    await open(authUrl);
    console.log('✅ Browser opened\n');
  } catch (err) {
    console.log('⚠️  Could not open browser automatically\n');
  }
});

process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down...');
  server.close(() => {
    console.log('Server stopped.');
    process.exit(0);
  });
});
