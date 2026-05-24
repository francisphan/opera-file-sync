# Building the Standalone Executable

This guide shows how to create a portable Windows executable of the OPERA sync that you can copy to the OPERA server — no Node.js installation required there.

---

## Build

The single build command bundles `opera-db-sync.js` (the Oracle polling sync) into a standalone Windows executable using [@yao-pkg/pkg](https://github.com/yao-pkg/pkg).

```bash
cd /home/phancis/workspace/opera-file-sync
npm run build
```

This runs three steps (see `package.json`):

1. **prebuild** — `rm -rf node_modules && npm ci --omit=dev` (clean, production-only deps so the bundle stays lean)
2. **build** — `npx -y @yao-pkg/pkg opera-db-sync.js --targets node20-win-x64 --output dist/opera-sync-db.exe`
3. **postbuild** — `npm install` (restores dev dependencies for local work)

Result: `dist/opera-sync-db.exe` (~80 MB) — a self-contained executable that includes the Node.js runtime and all dependencies.

---

## Configuration File

The executable reads a `.env` file from its working directory. Create one on the server (see `.env.example` for the full list). At minimum:

```bash
# Salesforce OAuth
SF_INSTANCE_URL=https://your-instance.my.salesforce.com
SF_CLIENT_ID=3MVG9...
SF_CLIENT_SECRET=1234567890ABCDEF...
SF_REFRESH_TOKEN=5Aep861...
SF_OBJECT=TVRS_Guest__c
SF_EXTERNAL_ID_FIELD=Email__c

# OPERA Oracle Database
ORACLE_HOST=your-oracle-host
ORACLE_PORT=1521
ORACLE_SID=OPERA
ORACLE_USER=opera_user
ORACLE_PASSWORD=your_password

# Feature flags
SYNC_PHONE_FIELD=true
SYNC_LANGUAGE_FIELD=true

# Email/Slack notifications
EMAIL_ENABLED=true
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
SLACK_WEBHOOK_URL=...
```

---

## Deploying to the OPERA Server

### Step 1: Build locally

```bash
npm run build
```

### Step 2: Copy to the server

```powershell
# From your dev machine (network share):
copy dist\opera-sync-db.exe \\opera-server\c$\opera-sync\
```

Or copy `dist\opera-sync-db.exe` via RDP / SCP to the target directory (e.g. `D:\opera-sync\`).

### Step 3: Create the `.env` file on the server

```powershell
cd D:\opera-sync
notepad .env
# Paste configuration and save
```

### Step 4: Test run

```powershell
.\opera-sync-db.exe
# Watch the console, then check logs\opera-sync.log
```

Verify: Oracle connection established, the initial catch-up sync completes, and phone/language fields populate in Salesforce. To exercise the daily summary without waiting for the schedule, run `node tests/test-daily-summary.js` from a dev checkout.

### Step 5: Run as a Windows Service (recommended)

Use [NSSM](https://nssm.cc/) to run it as a background service that starts automatically:

```powershell
nssm install OPERASync D:\opera-sync\opera-sync-db.exe
nssm set OPERASync AppDirectory D:\opera-sync
nssm start OPERASync
```

---

## Updating the Application

1. Build the new version locally: `npm run build`
2. Stop the service: `nssm stop OPERASync` (or `net stop OPERASync`)
3. Replace the executable: `copy dist\opera-sync-db.exe \\opera-server\c$\opera-sync\`
4. Restart: `nssm start OPERASync`

---

## Troubleshooting Build Issues

**"Cannot find module"** — Run `npm install` to restore dependencies (the build's prebuild step strips dev deps; postbuild restores them).

**pkg / bundling errors** — The build pins `@yao-pkg/pkg` via `npx -y`. Some native modules (e.g. `googleapis`) don't bundle cleanly under pkg — this project deliberately uses raw HTTPS calls for Gmail and Sheets to avoid that. Keep new dependencies pkg-friendly.

**Executable won't run on the server** — Common causes: antivirus blocking the binary (whitelist it), a missing `.env` file, or insufficient permissions (run as administrator). Check `logs\opera-sync.log`.

---

## Security Considerations

The standalone executable contains only the Node.js runtime, this project's code, and its dependencies. It connects to Salesforce, the OPERA Oracle DB, Gmail, and Google Sheets — nothing else.

Protect the `.env` file, which holds all credentials:

```powershell
# Restrict to the current user (Windows)
icacls .env /inheritance:r /grant:r "%USERNAME%:F"
```
