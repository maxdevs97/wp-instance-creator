#!/bin/bash
# Create test droplet with enhanced cloud-init for v3.2.5 diagnosis

set -e

DO_API_TOKEN="${DO_API_TOKEN:-$(cat .env.digitalocean | grep DO_API_TOKEN | cut -d= -f2)}"
TEMPLATE_SNAPSHOT_ID="217727089"
SSH_KEY_ID="54026256"
TEST_NAME="wp-diagnosis-$(date +%s)"

echo "=== v3.2.5 Diagnosis Test ==="
echo ""
echo "Creating test droplet: $TEST_NAME"
echo ""

# Create cloud-init user data
USER_DATA=$(cat <<'EOF'
#cloud-config
preserve_hostname: false
runcmd:
  - echo "=== CLOUD-INIT RUNCMD START ===" >> /var/log/password-fix-debug.log
  - date >> /var/log/password-fix-debug.log
  - echo "--- Before chage ---" >> /var/log/password-fix-debug.log
  - chage -l root >> /var/log/password-fix-debug.log 2>&1
  - grep "^root:" /etc/shadow >> /var/log/password-fix-debug.log 2>&1
  - echo "--- Running chage command ---" >> /var/log/password-fix-debug.log
  - chage -I -1 -m 0 -M 99999 -E -1 root >> /var/log/password-fix-debug.log 2>&1
  - echo "Exit code: $?" >> /var/log/password-fix-debug.log
  - echo "--- After chage ---" >> /var/log/password-fix-debug.log
  - chage -l root >> /var/log/password-fix-debug.log 2>&1
  - grep "^root:" /etc/shadow >> /var/log/password-fix-debug.log 2>&1
  - echo "--- Updating login.defs ---" >> /var/log/password-fix-debug.log
  - sed -i 's/^PASS_MAX_DAYS.*/PASS_MAX_DAYS   99999/' /etc/login.defs
  - sed -i 's/^PASS_MIN_DAYS.*/PASS_MIN_DAYS   0/' /etc/login.defs
  - grep -E "^PASS_MAX_DAYS|^PASS_MIN_DAYS" /etc/login.defs >> /var/log/password-fix-debug.log
  - echo "=== CLOUD-INIT RUNCMD COMPLETE ===" >> /var/log/password-fix-debug.log
  - chmod 644 /var/log/password-fix-debug.log
EOF
)

# Create droplet
echo "Creating droplet..."
RESPONSE=$(curl -s -X POST "https://api.digitalocean.com/v2/droplets" \
  -H "Authorization: Bearer $DO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"$TEST_NAME\",
    \"region\": \"nyc3\",
    \"size\": \"s-1vcpu-2gb\",
    \"image\": $TEMPLATE_SNAPSHOT_ID,
    \"backups\": false,
    \"ipv6\": false,
    \"monitoring\": true,
    \"ssh_keys\": [$SSH_KEY_ID],
    \"user_data\": $(echo "$USER_DATA" | jq -Rs .)
  }")

DROPLET_ID=$(echo "$RESPONSE" | jq -r '.droplet.id')

if [ "$DROPLET_ID" = "null" ] || [ -z "$DROPLET_ID" ]; then
  echo "Error creating droplet:"
  echo "$RESPONSE" | jq '.'
  exit 1
fi

echo "✓ Droplet created: $DROPLET_ID"
echo ""
echo "Waiting for droplet to become active..."

# Wait for droplet to be active
for i in {1..60}; do
  sleep 10
  STATUS_RESPONSE=$(curl -s -X GET "https://api.digitalocean.com/v2/droplets/$DROPLET_ID" \
    -H "Authorization: Bearer $DO_API_TOKEN")
  
  STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.droplet.status')
  
  if [ "$STATUS" = "active" ]; then
    DROPLET_IP=$(echo "$STATUS_RESPONSE" | jq -r '.droplet.networks.v4[] | select(.type=="public") | .ip_address')
    echo "✓ Droplet active: $DROPLET_IP"
    break
  fi
  
  echo "  Status: $STATUS (attempt $i/60)"
done

if [ "$STATUS" != "active" ] || [ -z "$DROPLET_IP" ]; then
  echo "Error: Droplet failed to become active"
  exit 1
fi

echo ""
echo "Waiting 60 seconds for cloud-init to complete..."
sleep 60

echo ""
echo "=== DIAGNOSIS READY ==="
echo ""
echo "Droplet Details:"
echo "  ID: $DROPLET_ID"
echo "  Name: $TEST_NAME"
echo "  IP: $DROPLET_IP"
echo ""
echo "Testing SSH access now..."
echo ""

# Test SSH
echo "1. Testing SSH connection:"
if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ~/.ssh/id_ed25519_digitalocean root@$DROPLET_IP "whoami" 2>&1; then
  echo "   ✓ SSH works!"
  echo ""
  
  echo "2. Checking password fix debug log:"
  ssh -i ~/.ssh/id_ed25519_digitalocean root@$DROPLET_IP "cat /var/log/password-fix-debug.log" 2>&1 || echo "   ⚠ Debug log not found"
  echo ""
  
  echo "3. Checking cloud-init status:"
  ssh -i ~/.ssh/id_ed25519_digitalocean root@$DROPLET_IP "cloud-init status --long" 2>&1
  echo ""
  
  echo "4. Checking current password expiry:"
  ssh -i ~/.ssh/id_ed25519_digitalocean root@$DROPLET_IP "chage -l root" 2>&1
  echo ""
else
  echo "   ✗ SSH FAILED - Password expiry issue still present"
  echo ""
  echo "   This means v3.2.4 fix did not work."
  echo ""
fi

echo ""
echo "To delete this test droplet:"
echo "  curl -X DELETE \"https://api.digitalocean.com/v2/droplets/$DROPLET_ID\" -H \"Authorization: Bearer $DO_API_TOKEN\""
echo ""
echo "Or save for debugging:"
echo "  Droplet ID: $DROPLET_ID"
echo "  IP: $DROPLET_IP"
echo ""
