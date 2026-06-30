#!/usr/bin/env python3
"""
Run this once to authorize YouTube Analytics API access.
Usage: python scripts/authorize_youtube.py /path/to/client_secrets.json

It will open your browser, ask you to log in with the Google account
that owns the YouTube channel, then print the credentials to add to
GitHub Secrets.
"""

import json
import sys
import webbrowser
import urllib.parse
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading

SCOPES = [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
]
REDIRECT_URI = "http://localhost:8080"

auth_code = None


class OAuthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        global auth_code
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if "code" in params:
            auth_code = params["code"][0]
            self.send_response(200)
            self.send_header("Content-type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h1>Done! You can close this tab and go back to the terminal.</h1>")
        else:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"<h1>Authorization failed. Check the terminal.</h1>")

    def log_message(self, format, *args):
        pass


def main():
    secrets_file = sys.argv[1] if len(sys.argv) > 1 else "client_secrets.json"
    try:
        with open(secrets_file) as f:
            secrets = json.load(f)
        creds = secrets.get("installed") or secrets.get("web")
        client_id     = creds["client_id"]
        client_secret = creds["client_secret"]
    except Exception as e:
        print(f"Could not read {secrets_file}: {e}")
        sys.exit(1)

    params = {
        "client_id":     client_id,
        "redirect_uri":  REDIRECT_URI,
        "response_type": "code",
        "scope":         " ".join(SCOPES),
        "access_type":   "offline",
        "prompt":        "consent",
    }
    auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)

    server = HTTPServer(("localhost", 8080), OAuthHandler)
    thread = threading.Thread(target=server.handle_request)
    thread.daemon = True
    thread.start()

    print("\nOpening your browser for Google authorization...")
    print("Make sure to log in with the Google account that owns the YouTube channel.")
    print("\nIf the browser does not open automatically, visit this URL manually:")
    print(f"\n  {auth_url}\n")
    webbrowser.open(auth_url)

    thread.join(timeout=120)

    if not auth_code:
        print("Timed out waiting for authorization. Please try again.")
        sys.exit(1)

    token_data = urllib.parse.urlencode({
        "code":          auth_code,
        "client_id":     client_id,
        "client_secret": client_secret,
        "redirect_uri":  REDIRECT_URI,
        "grant_type":    "authorization_code",
    }).encode()

    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=token_data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            tokens = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"Token exchange failed: {e.read().decode()}")
        sys.exit(1)

    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        print("No refresh token returned. Try running the script again.")
        sys.exit(1)

    print("\n" + "=" * 60)
    print("SUCCESS. Add these three secrets to GitHub:")
    print("=" * 60)
    print(f"\nSecret name:  YOUTUBE_CLIENT_ID")
    print(f"Secret value: {client_id}")
    print(f"\nSecret name:  YOUTUBE_CLIENT_SECRET")
    print(f"Secret value: {client_secret}")
    print(f"\nSecret name:  YOUTUBE_REFRESH_TOKEN")
    print(f"Secret value: {refresh_token}")
    print("\n" + "=" * 60)
    print("Once all three are added, the agent can pull YouTube Analytics automatically.\n")


if __name__ == "__main__":
    main()
