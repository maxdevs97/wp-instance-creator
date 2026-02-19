#!/bin/bash
# Diagnostic script to identify what's changing WordPress passwords

if [ -z "$1" ]; then
    echo "Usage: $0 <droplet-ip>"
    echo "Example: $0 64.23.145.78"
    exit 1
fi

DROPLET_IP=$1

echo "=== WordPress Password Change Diagnostic ==="
echo "Target droplet: $DROPLET_IP"
echo ""

echo "1. Checking for cloud-init user-data..."
ssh -o StrictHostKeyChecking=no root@$DROPLET_IP "cat /var/lib/cloud/instance/user-data.txt 2>/dev/null || echo 'No user-data found'"
echo ""

echo "2. Checking for cloud-init scripts..."
ssh -o StrictHostKeyChecking=no root@$DROPLET_IP "ls -la /var/lib/cloud/scripts/* 2>/dev/null || echo 'No cloud-init scripts found'"
echo ""

echo "3. Checking for rc.local startup script..."
ssh -o StrictHostKeyChecking=no root@$DROPLET_IP "cat /etc/rc.local 2>/dev/null || echo 'No rc.local found'"
echo ""

echo "4. Checking for systemd services that might modify WP..."
ssh -o StrictHostKeyChecking=no root@$DROPLET_IP "systemctl list-units --type=service --all | grep -E 'wp|wordpress|password' || echo 'No WordPress-related services found'"
echo ""

echo "5. Checking for cron jobs..."
ssh -o StrictHostKeyChecking=no root@$DROPLET_IP "crontab -l 2>/dev/null || echo 'No root crontab'"
ssh -o StrictHostKeyChecking=no root@$DROPLET_IP "crontab -l -u www-data 2>/dev/null || echo 'No www-data crontab'"
echo ""

echo "6. Checking WordPress cron..."
ssh -o StrictHostKeyChecking=no root@$DROPLET_IP "wp cron event list --path=/var/www/html --allow-root 2>/dev/null | head -20 || echo 'Cannot check WP cron'"
echo ""

echo "7. Checking for WordPress plugins that might change passwords..."
ssh -o StrictHostKeyChecking=no root@$DROPLET_IP "wp plugin list --path=/var/www/html --allow-root 2>/dev/null || echo 'Cannot list plugins'"
echo ""

echo "8. Checking current WordPress user info..."
ssh -o StrictHostKeyChecking=no root@$DROPLET_IP "wp user get clients@sheragency.com --path=/var/www/html --allow-root --format=json 2>/dev/null || echo 'Cannot get user info'"
echo ""

echo "9. Checking MySQL for password hash..."
ssh -o StrictHostKeyChecking=no root@$DROPLET_IP "mysql -u root -e \"SELECT user_login, user_pass FROM wordpress.wp_users WHERE user_login='clients@sheragency.com';\" 2>/dev/null || echo 'Cannot query MySQL'"
echo ""

echo "10. Checking for any WP-CLI commands in history..."
ssh -o StrictHostKeyChecking=no root@$DROPLET_IP "grep -E 'wp user|wp-cli|password' /root/.bash_history 2>/dev/null | tail -20 || echo 'No relevant commands in history'"
echo ""

echo "=== Diagnostic complete ==="
echo ""
echo "Next steps:"
echo "1. Review the output above for any automation that might be changing passwords"
echo "2. Check if cloud-init is running password reset commands"
echo "3. Verify no WordPress plugins are modifying user accounts on activation"
echo "4. Compare password hash on template vs new instance to confirm they're different"
