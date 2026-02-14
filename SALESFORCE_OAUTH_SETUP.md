# Salesforce OAuth Setup

How to create a Connected App and obtain a refresh token for the OPERA sync integration.

---

## Step 1: Create Salesforce Connected App

1. Log in to Salesforce → **Setup** (gear icon)
2. Quick Find → **App Manager** → **New Connected App**
3. Configure:
   - **Connected App Name:** `OPERA File Sync`
   - **Contact Email:** Your email
   - **Enable OAuth Settings:** Checked
   - **Callback URL:** `http://localhost:3000/oauth/callback`
   - **Selected OAuth Scopes:**
     - `Access and manage your data (api)`
     - `Perform requests on your behalf at any time (refresh_token, offline_access)`
4. **Save** and wait 2-10 minutes for propagation
5. Note your **Consumer Key** (Client ID) and **Consumer Secret** (Client Secret)

---

## Step 2: Obtain Refresh Token

The project includes a helper script:

```bash
node get-refresh-token.js
```

Set `SF_CLIENT_ID` and `SF_CLIENT_SECRET` in your environment or edit the file directly before running. The script:

1. Starts a local server on port 3000
2. Opens your browser to Salesforce login
3. After you approve, displays the refresh token
4. Press Ctrl+C to stop

---

## Step 3: Add Credentials to .env

```bash
SF_INSTANCE_URL=https://your-instance.my.salesforce.com
SF_CLIENT_ID=3MVG9...
SF_CLIENT_SECRET=1234567890ABCDEF...
SF_REFRESH_TOKEN=5Aep861...
```

---

## Step 4: Test

```bash
npm run test
```

This connects to Salesforce and verifies API access.

---

## Refresh Token Expiration

Salesforce refresh tokens do not expire unless:
- User password changes
- Admin revokes the token
- Connected App is modified/deleted
- User is deactivated

If the token stops working, re-run `node get-refresh-token.js`.

---

## Sandbox vs Production

- **Production:** `https://login.salesforce.com`
- **Sandbox:** `https://test.salesforce.com`

The `get-refresh-token.js` script uses the production login URL by default. Edit the `INSTANCE_URL` variable in the script if using a sandbox.
