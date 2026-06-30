#!/usr/bin/env python3
"""
Run this once to authorize Facebook/Instagram Analytics API access.
Usage: python scripts/authorize_meta.py

It will open your browser, ask you to log in with the Facebook account
connected to Afropolitan, then print the credentials to add to GitHub Secrets.
"""

import json
import sys
import webbrowser
import urllib.parse
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading

APP_ID     = "989618280576647"
APP_SECRET = "d61465fb4653e6502b5f3b848fab3d0d"
REDIRECT_URI = "http://localhost:8081"

PERMISSIONS = [
    "instagram_business_basic",
    "instagram_business_manage_insights",
    "pages_show_list",
    "pages_read_engagement",
    "business_management",
]

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
            self.wfile.write(b"<h1>Done! Go back to the terminal.</h1>")
        else:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"<h1>Authorization failed. Check the terminal.</h1>")

    def log_message(self, format, *args):
        pass


def get(url):
    with urllib.request.urlopen(url) as r:
        return json.loads(r.read())


def main():
    # Step 1 — open browser for authorization
    auth_url = (
        f"https://www.facebook.com/v19.0/dialog/oauth"
        f"?client_id={APP_ID}"
        f"&redirect_uri={urllib.parse.quote(REDIRECT_URI)}"
        f"&scope={','.join(PERMISSIONS)}"
        f"&response_type=code"
    )

    server = HTTPServer(("localhost", 8081), OAuthHandler)
    thread = threading.Thread(target=server.handle_request)
    thread.daemon = True
    thread.start()

    print("\nOpening browser — log in with the Facebook account connected to Afropolitan...")
    print("If browser doesn't open, visit:\n")
    print(f"  {auth_url}\n")
    webbrowser.open(auth_url)
    thread.join(timeout=120)

    if not auth_code:
        print("Timed out. Please try again.")
        sys.exit(1)

    # Step 2 — exchange code for short-lived token
    token_url = (
        f"https://graph.facebook.com/v19.0/oauth/access_token"
        f"?client_id={APP_ID}"
        f"&client_secret={APP_SECRET}"
        f"&redirect_uri={urllib.parse.quote(REDIRECT_URI)}"
        f"&code={auth_code}"
    )
    short_token = get(token_url)["access_token"]
    print("  Short-lived token obtained.")

    # Step 3 — exchange for long-lived token (60 days)
    long_url = (
        f"https://graph.facebook.com/v19.0/oauth/access_token"
        f"?grant_type=fb_exchange_token"
        f"&client_id={APP_ID}"
        f"&client_secret={APP_SECRET}"
        f"&fb_exchange_token={short_token}"
    )
    long_token = get(long_url)["access_token"]
    print("  Long-lived token obtained.")

    # Step 4 — get Page Access Token (never expires)
    pages_url = f"https://graph.facebook.com/v19.0/me/accounts?access_token={long_token}"
    pages = get(pages_url).get("data", [])

    if not pages:
        print("\nNo Facebook Pages found on this account.")
        print("Make sure the Facebook account owns a Page connected to Afropolitan Instagram.")
        sys.exit(1)

    print(f"\n  Found {len(pages)} Facebook Page(s):")
    for i, p in enumerate(pages):
        print(f"  {i+1}. {p['name']} (ID: {p['id']})")

    page = pages[0] if len(pages) == 1 else None
    if not page:
        choice = input("\nWhich page is Afropolitan? Enter number: ")
        page = pages[int(choice) - 1]

    page_id    = page["id"]
    page_token = page["access_token"]
    page_name  = page["name"]
    print(f"\n  Using page: {page_name} (ID: {page_id})")

    # Step 5 — get Instagram Business Account ID
    ig_url = (
        f"https://graph.facebook.com/v19.0/{page_id}"
        f"?fields=instagram_business_account"
        f"&access_token={page_token}"
    )
    ig_data = get(ig_url)
    ig_id = (ig_data.get("instagram_business_account") or {}).get("id", "")

    if ig_id:
        print(f"  Instagram Business Account ID: {ig_id}")
    else:
        print("  Warning: No Instagram Business Account linked to this page.")
        print("  Make sure the Instagram Creator/Business account is connected to the Facebook Page.")

    print("\n" + "=" * 60)
    print("SUCCESS. Add these secrets to GitHub:")
    print("=" * 60)
    print(f"\nSecret name:  META_APP_ID")
    print(f"Secret value: {APP_ID}")
    print(f"\nSecret name:  META_APP_SECRET")
    print(f"Secret value: {APP_SECRET}")
    print(f"\nSecret name:  META_PAGE_ACCESS_TOKEN")
    print(f"Secret value: {page_token}")
    print(f"\nSecret name:  META_PAGE_ID")
    print(f"Secret value: {page_id}")
    if ig_id:
        print(f"\nSecret name:  META_IG_ACCOUNT_ID")
        print(f"Secret value: {ig_id}")
    print("\n" + "=" * 60)
    print("Page tokens never expire so you only need to do this once.\n")


if __name__ == "__main__":
    main()
