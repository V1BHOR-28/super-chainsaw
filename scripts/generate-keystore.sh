#!/usr/bin/env bash
#
# generate-keystore.sh — Create a self-signed Android release keystore for ARIA.
#
# Usage:
#   npm run mobile:keystore
#
# Outputs 4 values that you must paste into GitHub repo → Settings → Secrets:
#   KEYSTORE_BASE64       (the keystore file, base64-encoded)
#   KEYSTORE_PASSWORD
#   KEY_ALIAS
#   KEY_PASSWORD
#
# All values are printed at the end. The keystore file itself (aria-release.jks)
# should NOT be committed — it's automatically gitignored.
#
# Cost: $0. keytool ships with the JDK — no signing authority needed for
# sideloaded APKs (only Play Store uploads require Google's app signing,
# which we are intentionally skipping to stay free).

set -euo pipefail

KEYSTORE_NAME="aria-release.jks"
KEY_ALIAS="aria"
KEYSTORE_PASSWORD="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20)"
KEY_PASSWORD="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20)"
DISTINGUISHED_NAME="CN=ARIA Mobile, OU=Mobile, O=V1BHOR-28, L=City, ST=State, C=IN"
VALIDITY_DAYS=36500  # 100 years — way beyond any project lifetime

# Remove any prior keystore so we don't accidentally re-use a stale one
if [[ -f "$KEYSTORE_NAME" ]]; then
  echo "⚠️  Found existing $KEYSTORE_NAME — backing up to $KEYSTORE_NAME.bak"
  mv "$KEYSTORE_NAME" "$KEYSTORE_NAME.bak"
fi

echo "🔐 Generating Android release keystore..."
echo "    File:        $KEYSTORE_NAME"
echo "    Alias:       $KEY_ALIAS"
echo "    Validity:    $VALIDITY_DAYS days"
echo ""

keytool -genkeypair \
  -keystore "$KEYSTORE_NAME" \
  -storetype JKS \
  -keyalg RSA \
  -keysize 2048 \
  -alias "$KEY_ALIAS" \
  -dname "$DISTINGUISHED_NAME" \
  -storepass "$KEYSTORE_PASSWORD" \
  -keypass "$KEY_PASSWORD" \
  -validity "$VALIDITY_DAYS"

echo ""
echo "✅ Keystore created: $KEYSTORE_NAME"
echo ""

# Base64-encode for GitHub secrets storage
KEYSTORE_BASE64="$(base64 -w 0 "$KEYSTORE_NAME")"

echo "──────────────────────────────────────────────────────────────────────"
echo "📋 Copy these values into GitHub → Settings → Secrets and variables → Actions"
echo "──────────────────────────────────────────────────────────────────────"
echo ""
echo "Name:            KEYSTORE_BASE64"
echo "Value:           <large block below>"
echo "$KEYSTORE_BASE64"
echo ""
echo "Name:            KEYSTORE_PASSWORD"
echo "Value:           $KEYSTORE_PASSWORD"
echo ""
echo "Name:            KEY_ALIAS"
echo "Value:           $KEY_ALIAS"
echo ""
echo "Name:            KEY_PASSWORD"
echo "Value:           $KEY_PASSWORD"
echo ""
echo "──────────────────────────────────────────────────────────────────────"
echo ""
echo "🛡️  Back up $KEYSTORE_NAME to a safe location (1Password, Bitwarden, USB drive)."
echo "    If you lose this file, you will NOT be able to release an update that"
echo "    installs on top of an existing ARIA install (signature mismatch)."
echo ""
echo "🚫 Do NOT commit $KEYSTORE_NAME — added to .gitignore already."
