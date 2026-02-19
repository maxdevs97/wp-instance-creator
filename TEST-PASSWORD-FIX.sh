#!/bin/bash
# Quick test script to verify password preservation fix

echo "=== WordPress Instance Creator - Password Fix Test ==="
echo ""

# Check current deployment version
echo "1. Checking deployed version..."
HEALTH_RESPONSE=$(curl -s https://wp-instance-creator-7ztm4.ondigitalocean.app/api/health)
VERSION=$(echo $HEALTH_RESPONSE | python3 -c "import sys, json; print(json.load(sys.stdin).get('version', 'unknown'))")
echo "   Current version: $VERSION"

if [[ "$VERSION" == "3.2.3-password-preservation-fix" ]]; then
  echo "   ✅ Fix deployed successfully!"
else
  echo "   ⚠️  Waiting for deployment... (check again in 2 minutes)"
  echo "   Expected: 3.2.3-password-preservation-fix"
  echo "   Got: $VERSION"
  exit 1
fi

echo ""
echo "2. Next steps to verify fix:"
echo ""
echo "   a) Get template password hash:"
echo "      ssh root@<template-ip>"
echo "      mysql -u root -e \"SELECT user_pass FROM wordpress.wp_users WHERE user_login='clients@sheragency.com';\""
echo ""
echo "   b) Create test instance:"
echo "      Visit: https://wp-instance-creator-7ztm4.ondigitalocean.app"
echo "      Subdomain: passwordtest3"
echo "      Wait 5-7 minutes for completion"
echo ""
echo "   c) Verify password hash matches:"
echo "      ssh root@<new-instance-ip>"
echo "      mysql -u root -e \"SELECT user_pass FROM wordpress.wp_users WHERE user_login='clients@sheragency.com';\""
echo "      Compare hashes - they should be IDENTICAL"
echo ""
echo "   d) Test login:"
echo "      Visit: https://passwordtest3.sherstaging.com/wp-admin"
echo "      Login: clients@sheragency.com"
echo "      Password: (from 1Password)"
echo "      Should succeed without password reset"
echo ""
echo "✅ Fix has been deployed. Run manual verification above."
