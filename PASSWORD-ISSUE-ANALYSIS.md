# WordPress Instance Creator - Password Change Issue Analysis

## Problem Statement
New WordPress instances created from template snapshot have different `clients@sheragency.com` password than the template droplet.

## Current State (v3.2.2)
- ✅ NO SSH commands in code
- ✅ NO password reset logic in Instance Creator
- ✅ NO wp-cli user update commands
- ✅ Code simply clones snapshot → creates droplet → sets DNS
- ✅ Deployed version confirmed: commit 00b92ee (Feb 19, 2026 19:46:43Z)

## Template Info
- **Template Droplet ID:** 552784281 (mbstest1.sherstaging.com)
- **Template Snapshot ID:** 217711524 (wordpress-managed-wildcard-ssl-20260219)
- **Snapshot Created:** Feb 19, 2026 18:51:02Z

## Potential Root Causes

### 1. Cloud-Init Scripts
DigitalOcean droplets may have cloud-init configuration that runs on first boot. This could include:
- Password reset commands
- User initialization scripts
- WordPress setup automation

**Check:** Run diagnostic script on new instance to inspect `/var/lib/cloud/`

### 2. WordPress First-Run Logic
When WordPress detects a domain change, it may:
- Trigger plugin activation hooks
- Run database migrations
- Reset certain configuration (unlikely to include passwords, but possible with plugins)

**Check:** Examine installed WordPress plugins for password management features

### 3. Systemd Services or Cron Jobs
The template droplet may have systemd services or cron jobs that:
- Run password rotation scripts
- Execute WP-CLI commands on boot
- Perform automated user management

**Check:** `systemctl list-units` and `crontab -l`

### 4. Template Snapshot Timing
The snapshot may have been created BEFORE the password was set to the expected value in 1Password.

**Check:** Verify password on template droplet 552784281 matches 1Password entry

### 5. WordPress Security Plugins
Plugins like Wordfence, iThemes Security, or custom security plugins may:
- Force password resets on new domain detection
- Implement automatic password rotation
- Lock accounts that haven't logged in recently

**Check:** `wp plugin list --path=/var/www/html --allow-root`

## Verification Steps

### Step 1: Verify Template Password
```bash
# SSH to template droplet
ssh root@<mbstest1-ip>

# Get current password hash
mysql -u root -e "SELECT user_login, user_pass FROM wordpress.wp_users WHERE user_login='clients@sheragency.com';"

# Save this hash for comparison
```

### Step 2: Create Test Instance
1. Use Instance Creator to create a new test instance (e.g., `passwordtest`)
2. Wait for completion
3. Immediately SSH to the new droplet before any other actions

### Step 3: Compare Password Hashes
```bash
# SSH to new instance
ssh root@<new-instance-ip>

# Get password hash
mysql -u root -e "SELECT user_login, user_pass FROM wordpress.wp_users WHERE user_login='clients@sheragency.com';"

# Compare with template hash
# If different, password was changed during/after creation
```

### Step 4: Run Diagnostics
```bash
chmod +x diagnose-password-issue.sh
./diagnose-password-issue.sh <new-instance-ip>
```

## Recommended Fixes

### Fix 1: Add SSH Key and Preserve Password (IF cloud-init is the culprit)
If cloud-init is resetting passwords, we need to:
1. Add SSH key to new droplets (for access)
2. Immediately after droplet boots, read the original password hash from template
3. Restore it before any scripts run

**Implementation:**
```javascript
// In server.js processJob function, after droplet is active:
const dropletResponse = await doApiCall('/droplets', 'POST', {
  name: dropletName,
  region: 'nyc3',
  size: 's-1vcpu-2gb',
  image: parseInt(TEMPLATE_SNAPSHOT_ID),
  ssh_keys: [54026256], // forge-key for emergency access
  backups: false,
  ipv6: false,
  monitoring: true,
  user_data: '' // Explicitly empty to prevent cloud-init password resets
});

// After droplet is active, verify password hasn't changed:
// (optional SSH check - only if issue persists)
```

### Fix 2: Disable Cloud-Init Password Management
Add explicit user_data to disable password changes:

```javascript
user_data: `#cloud-config
users:
  - default
  - name: root
    lock_passwd: false
chpasswd:
  expire: false
`
```

### Fix 3: Create Fresh Snapshot Without Cloud-Init State
The template snapshot may include cloud-init state that triggers on new droplets:

```bash
# SSH to template droplet
ssh root@<template-ip>

# Clean cloud-init state before creating snapshot
cloud-init clean --logs --seed
rm -rf /var/lib/cloud/instances/*
rm -rf /var/lib/cloud/instance

# Then create new snapshot via DigitalOcean console/API
```

### Fix 4: Post-Creation Password Verification
Add a verification step that:
1. Reads expected password hash from a secure config
2. After droplet creation, verifies the hash matches
3. If different, logs a warning and optionally restores

**Implementation:**
```javascript
// After droplet is active:
updateJobProgress(jobId, 'verify_password', 'Verifying password integrity...');

// SSH to check password (requires SSH key in droplet creation)
const passwordCheck = await sshExecute(dropletIp, [
  `mysql -u root -e "SELECT user_pass FROM wordpress.wp_users WHERE user_login='clients@sheragency.com';"`
]);

// Compare with expected hash (stored securely)
// Log warning if mismatch detected
```

## Testing Plan

1. **Run diagnostics** on newly created instance
2. **Compare password hashes** between template and new instance
3. **Identify the cause** from diagnostic output
4. **Implement appropriate fix** (likely Fix 3: clean cloud-init state)
5. **Create new snapshot** from cleaned template
6. **Update TEMPLATE_SNAPSHOT_ID** in server.js
7. **Test new instance creation** and verify password matches

## Action Items

- [ ] Run `diagnose-password-issue.sh` on a newly created instance
- [ ] Compare password hashes (template vs new instance)
- [ ] Review diagnostic output for automation scripts
- [ ] Implement fix based on findings
- [ ] Create new clean snapshot if needed
- [ ] Deploy and verify

## Expected Outcome
After implementing the fix, new instances should have **identical** `clients@sheragency.com` credentials as the template droplet/snapshot, with no password modifications during instance creation.
