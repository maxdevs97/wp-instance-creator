# Deployment Checklist - v2.0 REST API Implementation

## Status: ✅ Code Deployed to GitHub

**Commit:** d8d31ba  
**GitHub:** https://github.com/maxdevs97/wp-instance-creator  
**App Platform:** https://cloud.digitalocean.com/apps/7ztm4  

## Next Steps

### 1. Configure Template Droplet (ONE-TIME SETUP) ⚠️ REQUIRED

The new version requires an Application Password to be configured on the template droplet.

**Template Droplet ID:** 551293569

#### Step 1a: SSH to Template Droplet

```bash
# Get the template droplet IP from DigitalOcean
doctl compute droplet get 551293569 --format Name,PublicIPv4

# SSH to the template
ssh root@<template-ip>
```

#### Step 1b: Access WordPress Environment

Since your template uses Docker/LXD, you need to access the WordPress container:

**If using Docker:**
```bash
# List containers
docker ps

# Access WordPress container (replace with actual container name)
docker exec -it <wordpress-container> bash
```

**If using LXD:**
```bash
# List containers
lxc list

# Access WordPress container (replace with actual container name)
lxc exec <wordpress-container> -- bash
```

#### Step 1c: Create Application Password

Once inside the WordPress environment:

```bash
# Create Application Password for automation user
wp user application-password create clients@sheragency.com "WP-Instance-Creator" --path=/var/www/html --allow-root
```

**Expected output:**
```
Success: Created application password.
Password: AbCd 1234 EfGh 5678 IjKl 9012
```

**IMPORTANT:** Copy the password and remove spaces:
```
AbCd1234EfGh5678IjKl9012
```

### 2. Add Environment Variable to DigitalOcean App

#### Step 2a: Navigate to App Settings

Go to: https://cloud.digitalocean.com/apps/7ztm4/settings

#### Step 2b: Add Environment Variable

1. Click "Edit" next to "Environment Variables"
2. Click "Add Variable"
3. Configure:
   - **Name:** `WP_APP_PASSWORD`
   - **Value:** `<your-application-password>` (no spaces)
   - **Scope:** All components
   - **Encryption:** ✅ Encrypt
4. Click "Save"

#### Step 2c: Trigger Redeploy

The app should auto-redeploy after saving environment variables.

If not, manually trigger:
1. Go to: https://cloud.digitalocean.com/apps/7ztm4
2. Click "Actions" → "Force Rebuild and Deploy"

### 3. Verify Deployment

#### Step 3a: Check Health Endpoint

```bash
curl https://wp-instance-creator-7ztm4.ondigitalocean.app/api/health
```

**Expected output:**
```json
{
  "status": "ok",
  "version": "2.0-restapi-no-ssh",
  "config": {
    "hasDoToken": true,
    "hasFormPassword": true,
    "hasWpAppPassword": true  ← SHOULD BE TRUE
  },
  "stats": {
    "totalJobs": 0,
    "pending": 0,
    "processing": 0,
    "completed": 0,
    "failed": 0
  }
}
```

**⚠️ If `hasWpAppPassword: false`:**
- Environment variable not set or not loaded
- Check DigitalOcean App Platform environment variables
- Verify spelling: `WP_APP_PASSWORD` (case-sensitive)
- Trigger another rebuild

#### Step 3b: Check Deployment Logs

https://cloud.digitalocean.com/apps/7ztm4/logs

Look for:
```
WP Instance Creator v2.0 (Pure REST API) running on port 3000
Configuration method: WordPress REST API only (zero SSH)
Environment check:
  - DO API Token: ✓
  - Form Password: ✓
  - WP App Password: ✓  ← SHOULD BE CHECKED
```

### 4. Run End-to-End Test

#### Step 4a: Create Test Instance

1. Visit: https://wp-instance-creator-7ztm4.ondigitalocean.app
2. Enter:
   - **Subdomain:** `rest-api-test`
   - **WP Admin Password:** `TestPass123!`
   - **Form Password:** `<your-form-password>`
3. Click "Create Instance"
4. Copy the Job ID

#### Step 4b: Monitor Progress

```bash
# Replace JOB_ID with the actual job ID from step 4a
curl https://wp-instance-creator-7ztm4.ondigitalocean.app/api/status/<JOB_ID>
```

Watch for these steps in order:
1. ✅ `snapshot_start` - Creating snapshot
2. ✅ `snapshot_complete` - Snapshot ready
3. ✅ `droplet_created` - New droplet created
4. ✅ `droplet_active` - Droplet is running
5. ✅ `dns_created` - DNS record configured
6. ✅ `wp_ready` - WordPress REST API accessible
7. ✅ `rest_url_updated` - Site URL configured via REST API
8. ✅ `rest_permalinks_updated` - Permalinks configured via REST API
9. ✅ `rest_password_updated` - Admin password updated via REST API
10. ✅ `verify_success` - Site is accessible

#### Step 4c: Test the Site

Once status is "completed":

```bash
# Get the result from status endpoint
curl https://wp-instance-creator-7ztm4.ondigitalocean.app/api/status/<JOB_ID> | jq '.job.result'
```

Test the WordPress site:
```bash
# Visit the site
open http://rest-api-test.sherstaging.com

# Try logging into wp-admin
open http://rest-api-test.sherstaging.com/wp-admin
# User: clients@sheragency.com
# Pass: TestPass123!
```

Verify:
- ✅ Site loads correctly
- ✅ Can log into wp-admin with provided credentials
- ✅ Site URL in WP Admin Settings shows correct domain
- ✅ Permalinks are set to "Post name"

#### Step 4d: Clean Up Test Droplet

```bash
# Get droplet ID from result
curl https://wp-instance-creator-7ztm4.ondigitalocean.app/api/status/<JOB_ID> | jq '.job.result.dropletId'

# Delete via DigitalOcean console or API
doctl compute droplet delete <droplet-id>
```

### 5. Success Criteria

- [x] Code pushed to GitHub
- [ ] Application Password created on template droplet
- [ ] `WP_APP_PASSWORD` added to environment variables
- [ ] Health check shows `hasWpAppPassword: true`
- [ ] Test instance completes all 10 steps successfully
- [ ] WordPress site is accessible
- [ ] Admin login works with provided password
- [ ] Site URL is correctly configured
- [ ] Permalinks are correctly configured
- [ ] Test droplet cleaned up

## Rollback Plan (If Needed)

If the new version has issues:

1. **Revert to SSH version:**
   ```bash
   cd /Users/max/.openclaw/workspace-forge/wp-instance-creator
   git checkout main
   git revert HEAD
   git push origin main
   ```

2. **Or manually restore:**
   ```bash
   cp server-original-ssh.js server.js
   git add server.js
   git commit -m "rollback: restore SSH-based configuration"
   git push origin main
   ```

## What Changed vs v1.0

| Feature | v1.0 (SSH) | v2.0 (REST API) |
|---------|------------|-----------------|
| Configuration method | SSH commands | WordPress REST API |
| MySQL access | Direct via SSH | Not needed |
| WP-CLI access | Direct via SSH | Not needed |
| Container compatibility | ❌ Blocked | ✅ Works |
| Setup required | SSH key | Application Password |
| Authentication | SSH private key | Application Password |
| Speed | Slower (SSH handshake) | Faster (HTTP only) |
| Reliability | Network-dependent | More reliable |

## Benefits

✅ **Works with Docker/LXD containers** - no need for SSH access to containerized WordPress  
✅ **Simpler authentication** - Application Passwords are standard WordPress feature  
✅ **More maintainable** - uses documented WordPress REST API  
✅ **Faster** - no SSH connection overhead  
✅ **More reliable** - fewer network dependencies  
✅ **Better security** - Application Passwords can be revoked per-user  

## Documentation

- **Setup Guide:** `SETUP-TEMPLATE.md`
- **Implementation Guide:** `README-V2.md`
- **Original SSH version:** `server-original-ssh.js` (backed up)

## Support

If you encounter issues:

1. **Check logs:** https://cloud.digitalocean.com/apps/7ztm4/logs
2. **Review documentation:** `README-V2.md` and `SETUP-TEMPLATE.md`
3. **Test manually:**
   - Health endpoint: `/api/health`
   - Job status: `/api/status/<job-id>`
4. **Verify template setup:**
   - Application Password created
   - Environment variable set correctly

## Contact

Report results to Kit's inbox when complete.
