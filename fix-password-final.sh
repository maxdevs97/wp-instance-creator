#!/bin/bash
# Final fix for password preservation issue
# This script sets a known password and creates a fresh snapshot

set -e

TEMPLATE_DROPLET_ID="552784281"
TEMPLATE_IP="104.236.89.141"
WP_USER_EMAIL="clients@sheragency.com"
WP_PASSWORD="TheSherPassword2024!"  # Known password

echo "========================================="
echo "WordPress Instance Creator - Password Fix"
echo "========================================="
echo ""
echo "This script will:"
echo "1. Set a known password for clients@sheragency.com on template droplet"
echo "2. Create a fresh snapshot with the correct password"
echo "3. Update server.js to use the new snapshot"
echo ""

# Step 1: Reset password on template droplet
echo "Step 1: Resetting password on template droplet..."
ssh -o StrictHostKeyChecking=no root@${TEMPLATE_IP} << 'ENDSSH'
# Generate WordPress password hash
WP_USER_EMAIL="clients@sheragency.com"
WP_PASSWORD="TheSherPassword2024!"
WP_CONTAINER="wordpress_wordpress_1"

# Use WordPress to generate the proper password hash
NEW_HASH=$(docker exec $WP_CONTAINER php -r "
require '/var/www/html/wp-includes/class-phpass.php';
\$hasher = new PasswordHash(8, true);
echo \$hasher->HashPassword('${WP_PASSWORD}');
")

echo "Generated hash: $NEW_HASH"

# Update the password in the database
docker exec wordpress_db_1 mysql -u wp_user -peiVZrqJxFDI8kgsRNxElXkXK wordpress -e \
"UPDATE wp_users SET user_pass='${NEW_HASH}' WHERE user_email='${WP_USER_EMAIL}';"

echo "✓ Password updated on template droplet"

# Verify the update
docker exec wordpress_db_1 mysql -u wp_user -peiVZrqJxFDI8kgsRNxElXkXK wordpress -e \
"SELECT user_login, user_email, LEFT(user_pass, 20) as pass_start FROM wp_users WHERE user_email='${WP_USER_EMAIL}';" 2>&1 | grep -v "Using a password"
ENDSSH

if [ $? -eq 0 ]; then
    echo "✓ Password successfully set on template droplet"
else
    echo "✗ Failed to set password on template droplet"
    exit 1
fi

# Step 2: Create fresh snapshot
echo ""
echo "Step 2: Creating fresh snapshot (this may take 5-10 minutes)..."
SNAPSHOT_NAME="wordpress-managed-wildcard-ssl-$(date +%Y%m%d-%H%M)"
echo "Snapshot name: ${SNAPSHOT_NAME}"

doctl compute droplet-action snapshot ${TEMPLATE_DROPLET_ID} --snapshot-name "${SNAPSHOT_NAME}" --wait

if [ $? -eq 0 ]; then
    echo "✓ Snapshot created successfully"
    
    # Get the new snapshot ID
    NEW_SNAPSHOT_ID=$(doctl compute snapshot list --format ID,Name | grep "${SNAPSHOT_NAME}" | awk '{print $1}')
    echo "✓ New snapshot ID: ${NEW_SNAPSHOT_ID}"
    
    # Step 3: Update server.js with new snapshot ID
    echo ""
    echo "Step 3: Updating server.js with new snapshot ID..."
    sed -i.bak "s/const TEMPLATE_SNAPSHOT_ID = '[0-9]*'/const TEMPLATE_SNAPSHOT_ID = '${NEW_SNAPSHOT_ID}'/" server.js
    
    if [ $? -eq 0 ]; then
        echo "✓ server.js updated with new snapshot ID"
        echo ""
        echo "========================================="
        echo "FIX COMPLETE!"
        echo "========================================="
        echo ""
        echo "Template Password: ${WP_PASSWORD}"
        echo "Template User: ${WP_USER_EMAIL}"
        echo "New Snapshot ID: ${NEW_SNAPSHOT_ID}"
        echo ""
        echo "Test by creating a new instance and logging in with:"
        echo "  Email: ${WP_USER_EMAIL}"
        echo "  Password: ${WP_PASSWORD}"
        echo ""
    else
        echo "✗ Failed to update server.js"
        exit 1
    fi
else
    echo "✗ Snapshot creation failed"
    exit 1
fi
