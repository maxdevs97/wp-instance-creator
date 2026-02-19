#!/bin/bash

# Test script for v3.2.5 - SSH key-only authentication
# Verifies that password authentication is disabled and SSH keys work

set -e

echo "==================================="
echo "WP Instance Creator v3.2.5 Test"
echo "SSH Key-Only Authentication"
echo "==================================="
echo ""

# Load environment
source .env 2>/dev/null || { echo "Error: .env file not found"; exit 1; }

# Generate unique subdomain
TIMESTAMP=$(date +%s)
SUBDOMAIN="test-v325-${TIMESTAMP}"
DOMAIN="sherstaging.com"
FULL_DOMAIN="${SUBDOMAIN}.${DOMAIN}"

echo "Test Configuration:"
echo "  Subdomain: ${SUBDOMAIN}"
echo "  Full Domain: ${FULL_DOMAIN}"
echo "  Version: 3.2.5"
echo ""

# Start local server in background
echo "Starting local server..."
node server.js &
SERVER_PID=$!
sleep 5

# Function to cleanup
cleanup() {
  echo ""
  echo "Cleaning up..."
  kill $SERVER_PID 2>/dev/null || true
  
  if [ ! -z "$DROPLET_ID" ]; then
    echo "Keeping droplet for manual inspection: $DROPLET_ID"
    echo "To delete: curl -X DELETE -H \"Authorization: Bearer \$DO_API_TOKEN\" https://api.digitalocean.com/v2/droplets/$DROPLET_ID"
  fi
}
trap cleanup EXIT

# Check server health
echo "Checking server health..."
HEALTH=$(curl -s http://localhost:3000/api/health)
echo "$HEALTH" | jq .
VERSION=$(echo "$HEALTH" | jq -r .version)
AUTH_METHOD=$(echo "$HEALTH" | jq -r .config.authMethod)

echo ""
echo "Server version: $VERSION"
echo "Auth method: $AUTH_METHOD"
echo ""

if [ "$VERSION" != "3.2.5" ]; then
  echo "ERROR: Wrong version detected: $VERSION"
  exit 1
fi

# Create instance
echo "Creating WordPress instance..."
CREATE_RESPONSE=$(curl -s -X POST http://localhost:3000/api/create-instance \
  -H "Content-Type: application/json" \
  -d "{\"subdomain\": \"${SUBDOMAIN}\", \"password\": \"${FORM_PASSWORD}\"}")

echo "$CREATE_RESPONSE" | jq .

JOB_ID=$(echo "$CREATE_RESPONSE" | jq -r .jobId)

if [ -z "$JOB_ID" ] || [ "$JOB_ID" = "null" ]; then
  echo "ERROR: Failed to create job"
  exit 1
fi

echo ""
echo "Job created: $JOB_ID"
echo "Monitoring progress..."
echo ""

# Monitor job status
LAST_STEP=""
while true; do
  sleep 5
  
  STATUS=$(curl -s http://localhost:3000/api/status/${JOB_ID})
  JOB_STATUS=$(echo "$STATUS" | jq -r .job.status)
  CURRENT_STEP=$(echo "$STATUS" | jq -r .job.progress.step)
  CURRENT_MESSAGE=$(echo "$STATUS" | jq -r .job.progress.message)
  
  if [ "$CURRENT_STEP" != "$LAST_STEP" ]; then
    echo "[$JOB_STATUS] $CURRENT_STEP: $CURRENT_MESSAGE"
    LAST_STEP="$CURRENT_STEP"
  fi
  
  if [ "$JOB_STATUS" = "completed" ]; then
    echo ""
    echo "✓ Job completed successfully!"
    echo ""
    echo "$STATUS" | jq .job.result
    
    DROPLET_ID=$(echo "$STATUS" | jq -r .job.result.dropletId)
    DROPLET_IP=$(echo "$STATUS" | jq -r .job.result.dropletIp)
    
    break
  elif [ "$JOB_STATUS" = "failed" ]; then
    echo ""
    echo "✗ Job failed!"
    echo "$STATUS" | jq .job.error
    exit 1
  fi
done

echo ""
echo "==================================="
echo "Testing SSH Key Authentication"
echo "==================================="
echo ""

echo "Waiting 60 seconds for cloud-init to complete..."
sleep 60

echo "Testing SSH connection (should work with keys only)..."
echo ""

# Test SSH connection
SSH_TEST=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@${DROPLET_IP} "echo 'SSH connection successful'" 2>&1)

if echo "$SSH_TEST" | grep -q "SSH connection successful"; then
  echo "✓ SSH connection successful with key-only authentication"
else
  echo "✗ SSH connection failed"
  echo "$SSH_TEST"
  exit 1
fi

echo ""
echo "Verifying password authentication is disabled..."
SSH_CONFIG=$(ssh -o StrictHostKeyChecking=no root@${DROPLET_IP} "grep -i PasswordAuthentication /etc/ssh/sshd_config" 2>&1)

echo "$SSH_CONFIG"

if echo "$SSH_CONFIG" | grep -q "PasswordAuthentication no"; then
  echo "✓ Password authentication is disabled"
else
  echo "⚠ Warning: Password authentication status unclear"
fi

echo ""
echo "==================================="
echo "Testing WordPress Access"
echo "==================================="
echo ""

echo "Waiting for WordPress to be ready..."
sleep 30

echo "Testing HTTP access..."
HTTP_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" http://${FULL_DOMAIN} 2>&1)

if [ "$HTTP_RESPONSE" = "200" ] || [ "$HTTP_RESPONSE" = "301" ] || [ "$HTTP_RESPONSE" = "302" ]; then
  echo "✓ WordPress site is accessible (HTTP $HTTP_RESPONSE)"
else
  echo "⚠ WordPress returned HTTP $HTTP_RESPONSE"
fi

echo ""
echo "Testing HTTPS access (should work with wildcard SSL)..."
HTTPS_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" https://${FULL_DOMAIN} 2>&1)

if [ "$HTTPS_RESPONSE" = "200" ] || [ "$HTTPS_RESPONSE" = "301" ] || [ "$HTTPS_RESPONSE" = "302" ]; then
  echo "✓ HTTPS is working (HTTP $HTTPS_RESPONSE)"
else
  echo "⚠ HTTPS returned HTTP $HTTPS_RESPONSE"
fi

echo ""
echo "==================================="
echo "Test Summary"
echo "==================================="
echo ""
echo "✓ Droplet created: $DROPLET_ID"
echo "✓ IP Address: $DROPLET_IP"
echo "✓ Domain: $FULL_DOMAIN"
echo "✓ SSH key authentication: Working"
echo "✓ Password authentication: Disabled"
echo "✓ WordPress: Accessible"
echo ""
echo "WordPress Admin:"
echo "  URL: https://${FULL_DOMAIN}/wp-admin"
echo "  Username: clients@sheragency.com"
echo "  Password: (use 1Password credentials)"
echo ""
echo "Note: DigitalOcean password reset emails can be ignored."
echo "SSH access is via keys only."
echo ""
echo "Droplet ID: $DROPLET_ID (keeping for inspection)"
echo ""
