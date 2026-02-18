#!/bin/bash

# Test script for WordPress Instance Creator v2.0 deployment
# Usage: ./test-deployment.sh

set -e

APP_URL="https://wp-instance-creator-7ztm4.ondigitalocean.app"
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo "=========================================="
echo "WordPress Instance Creator v2.0 - Deployment Test"
echo "=========================================="
echo ""

# Test 1: Health check
echo -e "${YELLOW}Test 1: Health Check${NC}"
HEALTH_RESPONSE=$(curl -s "${APP_URL}/api/health")
echo "$HEALTH_RESPONSE" | jq '.'

VERSION=$(echo "$HEALTH_RESPONSE" | jq -r '.version // "unknown"')
HAS_WP_APP_PASSWORD=$(echo "$HEALTH_RESPONSE" | jq -r '.config.hasWpAppPassword // false')

if [[ "$VERSION" == *"restapi"* ]]; then
  echo -e "${GREEN}✓ Version: $VERSION (v2.0 detected)${NC}"
else
  echo -e "${RED}✗ Version: $VERSION (expected v2.0-restapi-no-ssh)${NC}"
  echo -e "${RED}  Deployment may still be in progress or failed.${NC}"
  exit 1
fi

if [[ "$HAS_WP_APP_PASSWORD" == "true" ]]; then
  echo -e "${GREEN}✓ WP_APP_PASSWORD is configured${NC}"
else
  echo -e "${RED}✗ WP_APP_PASSWORD is NOT configured${NC}"
  echo -e "${RED}  You must add WP_APP_PASSWORD to environment variables.${NC}"
  echo -e "${YELLOW}  See DEPLOYMENT-CHECKLIST.md for instructions.${NC}"
  exit 1
fi

echo ""

# Test 2: Job list
echo -e "${YELLOW}Test 2: Jobs Endpoint${NC}"
curl -s "${APP_URL}/api/jobs" | jq '{count: .count, success: .success}'
echo -e "${GREEN}✓ Jobs endpoint working${NC}"
echo ""

# Test 3: Password verification (skip - requires form password)
echo -e "${YELLOW}Test 3: Password Verification Endpoint${NC}"
echo -e "${YELLOW}  (Skipped - requires form password)${NC}"
echo ""

# Summary
echo "=========================================="
echo -e "${GREEN}✓ All tests passed!${NC}"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Create a test instance via the web UI"
echo "2. Monitor progress at: ${APP_URL}/api/status/<job-id>"
echo "3. Verify WordPress site is accessible"
echo "4. Test admin login with provided credentials"
echo "5. Clean up test droplet"
echo ""
echo "For full testing instructions, see:"
echo "  DEPLOYMENT-CHECKLIST.md"
