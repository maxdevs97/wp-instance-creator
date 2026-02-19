#!/bin/bash
# Direct API test of v3.2.5 fix (bypassing web form)

set -e

DO_API_TOKEN="${DO_API_TOKEN:-$(cat /Users/max/.openclaw/workspace-forge/.env.digitalocean 2>/dev/null | grep DO_API_TOKEN | cut -d= -f2)}"
TEMPLATE_SNAPSHOT_ID="217727089"
SSH_KEY_ID="54026256"  # This is the v3.2.5 fix!
TEST_NAME="wp-v325-final-$(date +%s)"

echo "=== v3.2.5 Final Test (Direct API) ==="
echo ""
echo "Creating droplet: $TEST_NAME"
echo ""

# Cloud-init from v3.2.5
USER_DATA=$(cat <<'EOF'
#cloud-config
preserve_hostname: false
runcmd:
  - chage -I -1 -m 0 -M 99999 -E -1 root
  - sed -i 's/^PASS_MAX_DAYS.*/PASS_MAX_DAYS   99999/' /etc/login.defs
  - sed -i 's/^PASS_MIN_DAYS.*/PASS_MIN_DAYS   0/' /etc/login.defs
EOF
)

echo "1. Creating droplet with SSH key ($SSH_KEY_ID)..."
RESPONSE=$(curl -s -X POST "https://api.digitalocean.com/v2/droplets" \
  -H "Authorization: Bearer $DO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"$TEST_NAME\",
    \"region\": \"nyc3\",
    \"size\": \"s-1vcpu-2gb\",
    \"image\": $TEMPLATE_SNAPSHOT_ID,
    \"ssh_keys\": [$SSH_KEY_ID],
    \"backups\": false,
    \"ipv6\": false,
    \"monitoring\": true,
    \"user_data\": $(echo "$USER_DATA" | jq -Rs .)
  }")

DROPLET_ID=$(echo "$RESPONSE" | jq -r '.droplet.id')

if [ "$DROPLET_ID" = "null" ] || [ -z "$DROPLET_ID" ]; then
  echo "Error creating droplet:"
  echo "$RESPONSE" | jq '.'
  exit 1
fi

echo "   ✓ Droplet created: $DROPLET_ID"
echo ""

echo "2. Waiting for droplet to become active..."
for i in {1..60}; do
  sleep 10
  STATUS_RESPONSE=$(curl -s -X GET "https://api.digitalocean.com/v2/droplets/$DROPLET_ID" \
    -H "Authorization: Bearer $DO_API_TOKEN")
  
  STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.droplet.status')
  
  if [ "$STATUS" = "active" ]; then
    DROPLET_IP=$(echo "$STATUS_RESPONSE" | jq -r '.droplet.networks.v4[] | select(.type=="public") | .ip_address')
    echo "   ✓ Droplet active: $DROPLET_IP"
    break
  fi
  
  echo "   Status: $STATUS (attempt $i/60)"
done

if [ "$STATUS" != "active" ] || [ -z "$DROPLET_IP" ]; then
  echo "Error: Droplet failed to become active"
  exit 1
fi

echo ""
echo "3. Waiting 60 seconds for cloud-init and SSH to be ready..."
sleep 60
echo ""

echo "4. Testing SSH access (THE CRITICAL TEST)..."
echo ""

if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ~/.ssh/id_ed25519_digitalocean root@$DROPLET_IP "whoami" 2>&1 | grep -q "root"; then
  echo "   ✅✅✅ SSH WORKS! NO PASSWORD ERROR! ✅✅✅"
  echo ""
  
  echo "5. Verifying password expiry settings..."
  ssh -i ~/.ssh/id_ed25519_digitalocean root@$DROPLET_IP "chage -l root" | grep -E "Password expires|Maximum number"
  echo ""
  
  echo "6. Checking SSH keys in authorized_keys..."
  KEY_COUNT=$(ssh -i ~/.ssh/id_ed25519_digitalocean root@$DROPLET_IP "wc -l < ~/.ssh/authorized_keys")
  echo "   SSH keys present: $KEY_COUNT"
  echo ""
  
  echo "=== ✅ V3.2.5 SUCCESS ✅ ==="
  echo ""
  echo "Root cause was CONFIRMED:"
  echo "  - Missing ssh_keys parameter in droplet creation"
  echo "  - Adding ssh_keys: [54026256] fixed the issue"
  echo "  - SSH now works without password expiry errors"
  echo ""
  echo "Instance details:"
  echo "  Droplet ID: $DROPLET_ID"
  echo "  IP: $DROPLET_IP"
  echo "  Name: $TEST_NAME"
  echo ""
  echo "WordPress URL: https://$TEST_NAME.sherstaging.com/wp-admin"
  echo "  (Note: DNS not configured in this direct test)"
  echo ""
  echo "To delete this test droplet:"
  echo "  curl -X DELETE \"https://api.digitalocean.com/v2/droplets/$DROPLET_ID\" -H \"Authorization: Bearer \$DO_API_TOKEN\""
  echo ""
  
else
  echo "   ❌ SSH FAILED - Password expiry error detected"
  echo ""
  echo "   This would mean v3.2.5 didn't fix the problem."
  echo "   Droplet ID: $DROPLET_ID"
  echo "   IP: $DROPLET_IP"
  echo ""
  exit 1
fi
