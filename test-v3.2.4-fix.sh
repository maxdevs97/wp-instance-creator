#!/bin/bash
# Test script for v3.2.4 password expiry fix

set -e

echo "=== WordPress Instance Creator v3.2.4 - Password Expiry Fix Test ==="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check deployment version
echo "1. Checking deployed version..."
HEALTH_RESPONSE=$(curl -s https://wp-instance-creator-7ztm4.ondigitalocean.app/api/health)
VERSION=$(echo $HEALTH_RESPONSE | python3 -c "import sys, json; print(json.load(sys.stdin).get('version', 'unknown'))" 2>/dev/null || echo "unknown")

if [ "$VERSION" = "3.2.4-password-expiry-fix" ]; then
  echo -e "   ${GREEN}✅ v3.2.4 deployed successfully${NC}"
else
  echo -e "   ${RED}❌ Wrong version: $VERSION${NC}"
  echo "   Expected: 3.2.4-password-expiry-fix"
  echo ""
  echo "   Wait for deployment to complete, then run this script again."
  exit 1
fi

echo ""
echo "2. Manual testing required:"
echo ""
echo -e "${YELLOW}Step A: Create test instance${NC}"
echo "   1. Visit: https://wp-instance-creator-7ztm4.ondigitalocean.app"
echo "   2. Enter subdomain: expiry-test-$(date +%s)"
echo "   3. Wait for completion (5-7 minutes)"
echo ""
echo -e "${YELLOW}Step B: Test SSH access${NC}"
echo "   After droplet is active, get the IP and test:"
echo "   $ ssh root@<DROPLET_IP> whoami"
echo "   Expected: 'root' (no password expired error)"
echo ""
echo -e "${YELLOW}Step C: Verify password expiry settings${NC}"
echo "   $ ssh root@<DROPLET_IP> 'chage -l root'"
echo "   Expected output:"
echo "     Password expires: never"
echo "     Maximum number of days between password change: 99999"
echo ""
echo -e "${YELLOW}Step D: Verify WordPress login${NC}"
echo "   1. Visit: https://expiry-test-<timestamp>.sherstaging.com/wp-admin"
echo "   2. Login with clients@sheragency.com and 1Password password"
echo "   Expected: Login succeeds without password reset"
echo ""
echo -e "${YELLOW}Step E: Cleanup${NC}"
echo "   $ doctl compute droplet delete <DROPLET_ID>"
echo ""
echo -e "${GREEN}✅ v3.2.4 is deployed. Complete manual tests above.${NC}"
echo ""
echo "=== If all tests pass, the password expiry issue is resolved ==="
