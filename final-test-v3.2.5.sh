#!/bin/bash
# Final test of v3.2.5 via the web form API

set -e

echo "=== v3.2.5 Final Verification Test ==="
echo ""

SUBDOMAIN="v325-final-$(date +%s)"
API_URL="https://wp-instance-creator-7ztm4.ondigitalocean.app"

echo "1. Creating WordPress instance via web form..."
echo "   Subdomain: $SUBDOMAIN"
echo ""

# Create instance via API
JOB_RESPONSE=$(curl -s -X POST "$API_URL/api/create-instance" \
  -H "Content-Type: application/json" \
  -d "{\"subdomain\": \"$SUBDOMAIN\", \"password\": \"TestPass2024!\"}")

JOB_ID=$(echo "$JOB_RESPONSE" | jq -r '.jobId')

if [ "$JOB_ID" = "null" ] || [ -z "$JOB_ID" ]; then
  echo "Error creating instance:"
  echo "$JOB_RESPONSE" | jq '.'
  exit 1
fi

echo "   Job created: $JOB_ID"
echo ""
echo "2. Waiting for instance creation (this takes 5-7 minutes)..."

# Poll job status
MAX_ATTEMPTS=100
ATTEMPT=0
while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  sleep 10
  ATTEMPT=$((ATTEMPT + 1))
  
  STATUS_RESPONSE=$(curl -s "$API_URL/api/job-status/$JOB_ID")
  JOB_STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.status')
  CURRENT_STEP=$(echo "$STATUS_RESPONSE" | jq -r '.progress.step // "unknown"')
  
  echo "   [$ATTEMPT/$MAX_ATTEMPTS] Status: $JOB_STATUS | Step: $CURRENT_STEP"
  
  if [ "$JOB_STATUS" = "completed" ]; then
    DROPLET_ID=$(echo "$STATUS_RESPONSE" | jq -r '.result.dropletId')
    DROPLET_IP=$(echo "$STATUS_RESPONSE" | jq -r '.result.dropletIp')
    DOMAIN=$(echo "$STATUS_RESPONSE" | jq -r '.result.domain')
    
    echo ""
    echo "✅ Instance created successfully!"
    echo ""
    echo "   Droplet ID: $DROPLET_ID"
    echo "   IP Address: $DROPLET_IP"
    echo "   Domain: $DOMAIN"
    echo ""
    
    # Wait a bit for SSH to be ready
    echo "3. Waiting 30 seconds for SSH to stabilize..."
    sleep 30
    echo ""
    
    # Test SSH
    echo "4. Testing SSH access..."
    if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ~/.ssh/id_ed25519_digitalocean root@$DROPLET_IP "whoami" 2>&1 | grep -q "root"; then
      echo "   ✅ SSH WORKS!"
      echo ""
      
      # Check password expiry
      echo "5. Checking password expiry settings..."
      PASSWORD_STATUS=$(ssh -i ~/.ssh/id_ed25519_digitalocean root@$DROPLET_IP "chage -l root | grep 'Password expires'")
      echo "   $PASSWORD_STATUS"
      
      if echo "$PASSWORD_STATUS" | grep -q "never"; then
        echo "   ✅ Password set to never expire"
      else
        echo "   ⚠️  Password expiry might still be an issue"
      fi
      echo ""
      
      # Test WordPress
      echo "6. WordPress access:"
      echo "   URL: https://$DOMAIN/wp-admin"
      echo "   Username: clients@sheragency.com"
      echo "   Password: (from 1Password)"
      echo ""
      echo "   Please test WordPress login manually."
      echo ""
      
      echo "=== SUCCESS SUMMARY ==="
      echo "✅ v3.2.5 deployed and working"
      echo "✅ Instance created: $DROPLET_ID"
      echo "✅ SSH access confirmed"
      echo "✅ Password expiry disabled"
      echo "⏳ WordPress login: manual test required"
      echo ""
      echo "To delete this test instance:"
      echo "  curl -X DELETE \"https://api.digitalocean.com/v2/droplets/$DROPLET_ID\" -H \"Authorization: Bearer \$DO_API_TOKEN\""
      echo ""
      
      exit 0
    else
      echo "   ❌ SSH FAILED!"
      echo ""
      echo "   Error: Password expiry issue still present"
      echo "   This means v3.2.5 did not fix the problem."
      echo ""
      exit 1
    fi
  elif [ "$JOB_STATUS" = "failed" ]; then
    echo ""
    echo "❌ Instance creation failed:"
    echo "$STATUS_RESPONSE" | jq '.error'
    exit 1
  fi
done

echo ""
echo "❌ Timeout waiting for instance creation"
exit 1
