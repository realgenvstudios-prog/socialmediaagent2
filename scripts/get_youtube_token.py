"""
One-time script: authorizes YouTube Analytics access and prints the refresh token.
Run once, save the refresh token as a GitHub secret, never run again.
"""

import json
import webbrowser
import urllib.parse
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# ── Find the client secret JSON ───────────────────────────────────────────────
search_dirs = [
    Path("."),
    Path.home() / "Desktop",
    Path.home() / "Downloads",
]
json_files = []
for d in search_dirs:
    json_files.extend(d.glob("client_secret_*.json"))

if not json_files:
    print("ERROR: No client_secret_*.json file found.")
    print("Move the downloaded JSON into the solvingthisagent 2 folder and try again.")
    exit(1)

creds_file = json_files[0]
print(f"Using credentials: {creds_file.name}")

with open(creds_file) as f:
    raw = json.load(f)

client_data  = raw.get("installed") or raw.get("web")
CLIENT_ID     = client_data["client_id"]
CLIENT_SECRET = client_data["client_secret"]

# ── OAuth config ──────────────────────────────────────────────────────────────
REDIRECT_URI = "http://localhost:8080"
SCOPES = [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
]

auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
    "client_id":     CLIENT_ID,
    "redirect_uri":  REDIRECT_URI,
    "response_type": "code",
    "scope":         " ".join(SCOPES),
    "access_type":   "offline",
    "prompt":        "consent",   # always re-prompt so refresh_token is returned
})

print("\nOpening browser for Google authorization...")
print("(If it doesn't open automatically, paste this URL into your browser)")
print(f"\n{auth_url}\n")
webbrowser.open(auth_url)

# ── Local server to capture the redirect ─────────────────────────────────────
auth_code = None

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        global auth_code
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if "code" in params:
            auth_code = params["code"][0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"""
                <html><body style="font-family:sans-serif;padding:40px">
                <h2 style="color:#16a34a">Authorization successful!</h2>
                <p>You can close this tab and return to the terminal.</p>
                </body></html>
            """)
        else:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"<h2>Error: no authorization code received</h2>")

    def log_message(self, *_):
        pass  # silence request logs

print("Waiting for you to approve access in the browser...")
HTTPServer(("localhost", 8080), Handler).handle_request()

if not auth_code:
    print("ERROR: Did not receive an authorization code. Try again.")
    exit(1)

# ── Exchange code for tokens ──────────────────────────────────────────────────
token_body = urllib.parse.urlencode({
    "code":          auth_code,
    "client_id":     CLIENT_ID,
    "client_secret": CLIENT_SECRET,
    "redirect_uri":  REDIRECT_URI,
    "grant_type":    "authorization_code",
}).encode()

req = urllib.request.Request(
    "https://oauth2.googleapis.com/token",
    data=token_body,
    method="POST",
    headers={"Content-Type": "application/x-www-form-urlencoded"},
)

with urllib.request.urlopen(req) as resp:
    tokens = json.loads(resp.read())

refresh_token = tokens.get("refresh_token")

print("\n" + "=" * 60)
if refresh_token:
    # Immediately test the refresh token before printing
    print("Testing token with Google...")
    test_body = urllib.parse.urlencode({
        "client_id":     CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "refresh_token": refresh_token,
        "grant_type":    "refresh_token",
    }).encode()
    test_req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=test_body,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(test_req) as tr:
            test_result = json.loads(tr.read())
        print("Token test: OK — access token obtained.")
    except Exception as e:
        print(f"Token test FAILED: {e}")
        print("The refresh token was generated but does not work.")
        print("This usually means the wrong Google account was used.")
        print("=" * 60)
        exit(1)

    print("\nSUCCESS — add these three secrets to GitHub + Vercel:\n")
    print(f"YOUTUBE_CLIENT_ID     = {CLIENT_ID}")
    print(f"YOUTUBE_CLIENT_SECRET = {CLIENT_SECRET}")
    print(f"YOUTUBE_REFRESH_TOKEN = {refresh_token}")
    print("\n" + "=" * 60)
    print("\nAlso add YOUTUBE_REFRESH_TOKEN to your .env file.")
else:
    print("ERROR: No refresh token returned.")
    print("This usually means you already authorized this app previously.")
    print("Fix: go to https://myaccount.google.com/permissions,")
    print("revoke 'adjiano', then run this script again.")
    print("=" * 60)
