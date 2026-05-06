// PrismClaw — Google Calendar Sync Service
// Fixes: Uses Edge browser, handles OAuth 403, graceful fallback
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');

const CREDENTIALS_PATH = path.join(__dirname, '..', '..', 'credentials.json');
const TOKEN_PATH = path.join(__dirname, '..', '..', 'token.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

/**
 * Authenticate with Google Calendar using OAuth2.
 * Loads saved token or opens browser for consent.
 */
async function authenticateCalendar() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error('credentials.json not found. Download from Google Cloud Console.');
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const { client_id, client_secret } = credentials.installed || credentials.web;

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3377');

  // Try loading saved token
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    oAuth2Client.setCredentials(token);

    // Refresh if expired
    if (token.expiry_date && token.expiry_date < Date.now()) {
      try {
        const { credentials: refreshed } = await oAuth2Client.refreshAccessToken();
        oAuth2Client.setCredentials(refreshed);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(refreshed, null, 2));
        console.log('✓ Calendar token refreshed');
      } catch (err) {
        console.warn('Token refresh failed, re-authenticating...', err.message);
        fs.unlinkSync(TOKEN_PATH);
        return await getNewToken(oAuth2Client);
      }
    }
    return oAuth2Client;
  }

  return await getNewToken(oAuth2Client);
}

/**
 * Opens browser (prefers Edge on Linux) for OAuth consent.
 * 
 * FIX FOR 403 "access_denied":
 * Go to https://console.cloud.google.com/apis/credentials/consent
 * → Under "Test users", click "Add Users"
 * → Add your Google email address
 * → Save. Then retry.
 */
function getNewToken(oAuth2Client) {
  return new Promise((resolve, reject) => {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
    });

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔐 Google Calendar Authorization Required');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    console.log('If you get a 403 "access_denied" error:');
    console.log('1. Go to: https://console.cloud.google.com/apis/credentials/consent');
    console.log('2. Click "Test users" → "Add Users"');
    console.log('3. Add YOUR Google email address');
    console.log('4. Save, then retry this flow');
    console.log('');
    console.log('Opening browser...');
    console.log(authUrl);
    console.log('');

    // Detect best browser based on platform
    const { execSync, exec } = require('child_process');
    const envBrowser = process.env.OAUTH_BROWSER;

    let browserCmd;
    if (process.platform === 'win32') {
      // Windows: use 'start' to open in default browser
      browserCmd = 'start ""';
    } else if (envBrowser && envBrowser !== 'xdg-open') {
      browserCmd = envBrowser;
    } else {
      // Linux/macOS: Try to find Microsoft Edge, then fallback
      const whichCmd = process.platform === 'darwin' ? 'which' : 'which';
      try {
        execSync(`${whichCmd} microsoft-edge-stable 2>/dev/null`);
        browserCmd = 'microsoft-edge-stable';
      } catch {
        try {
          execSync(`${whichCmd} microsoft-edge 2>/dev/null`);
          browserCmd = 'microsoft-edge';
        } catch {
          try {
            execSync(`${whichCmd} microsoft-edge-dev 2>/dev/null`);
            browserCmd = 'microsoft-edge-dev';
          } catch {
            // Fallback to system default
            browserCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
          }
        }
      }
    }

    console.log(`Using browser: ${browserCmd}`);
    exec(`${browserCmd} "${authUrl}"`);

    // Start temporary local server to catch the redirect
    const server = http.createServer(async (req, res) => {
      try {
        const query = url.parse(req.url, true).query;

        if (query.error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<html><body style="background:#0a0a14;color:#f87171;font-family:Inter,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;gap:16px">
            <h1>❌ Authorization Failed</h1>
            <p>Error: ${query.error}</p>
            <p style="color:#94a3b8">If "access_denied": Go to Google Cloud Console → OAuth consent screen → Test users → Add your email</p>
          </body></html>`);
          server.close();
          reject(new Error(`OAuth error: ${query.error}. Add your email as a test user in Google Cloud Console.`));
          return;
        }

        if (query.code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<html><body style="background:#0a0a14;color:#4ade80;font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
            <h1>✓ PrismClaw authenticated! You can close this tab.</h1>
          </body></html>`);

          const { tokens } = await oAuth2Client.getToken(query.code);
          oAuth2Client.setCredentials(tokens);
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
          console.log('✓ Calendar authenticated and token saved');

          server.close();
          resolve(oAuth2Client);
        }
      } catch (err) {
        res.writeHead(500);
        res.end('Authentication failed.');
        server.close();
        reject(err);
      }
    });

    server.listen(3377, () => {
      console.log('Waiting for OAuth callback on http://localhost:3377 ...');
    });

    // Timeout after 30 seconds (keep it snappy)
    setTimeout(() => {
      server.close();
      reject(new Error('Calendar OAuth timeout. Add your email as test user in Google Cloud Console, then restart.'));
    }, 30000);
  });
}

/**
 * Fetch upcoming calendar events.
 */
async function fetchUpcomingEvents(auth, maxResults = 15) {
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: new Date().toISOString(),
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
  });
  return res.data.items || [];
}

/**
 * Inject a new event into Google Calendar.
 * Used for marking extracted dates/deadlines from meetings.
 */
async function injectCalendarEvent(auth, { summary, description, date, endDate }) {
  const calendar = google.calendar({ version: 'v3', auth });

  const startDate = new Date(date);
  const end = endDate ? new Date(endDate) : new Date(startDate.getTime() + 60 * 60 * 1000);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const event = {
    summary: `📌 ${summary}`,
    description: description || 'Auto-extracted by PrismClaw',
    start: { dateTime: startDate.toISOString(), timeZone: tz },
    end: { dateTime: end.toISOString(), timeZone: tz },
    colorId: '6', // Tangerine — stands out as AI-extracted
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 30 },
        { method: 'popup', minutes: 10 },
      ],
    },
  };

  const res = await calendar.events.insert({ calendarId: 'primary', requestBody: event });
  console.log(`✓ Calendar event: ${summary} → ${res.data.htmlLink}`);
  return res.data;
}

/**
 * Get events for a specific date range (for pre-meeting prep).
 */
async function getEventsInRange(auth, startDate, endDate) {
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: new Date(startDate).toISOString(),
    timeMax: new Date(endDate).toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });
  return res.data.items || [];
}

module.exports = { authenticateCalendar, fetchUpcomingEvents, injectCalendarEvent, getEventsInRange };
