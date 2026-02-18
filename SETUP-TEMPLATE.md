# Template Droplet Setup for REST API Configuration

## Overview

This document explains how to prepare the template droplet (ID: 551293569) for REST API-based WordPress configuration, eliminating the need for SSH access to containers.

## Prerequisites

- Access to template droplet (via SSH, console, or Docker exec)
- WordPress admin account: `clients@sheragency.com`
- WP-CLI available in the WordPress environment

## One-Time Setup

### Step 1: Access WordPress Environment

Depending on your setup:

**Option A: Direct SSH (if WordPress is on host)**
```bash
ssh root@<template-droplet-ip>
```

**Option B: Docker Container**
```bash
ssh root@<template-droplet-ip>
docker exec -it <wordpress-container> bash
```

**Option C: LXD Container**
```bash
ssh root@<template-droplet-ip>
lxc exec <wordpress-container> -- bash
```

### Step 2: Create Application Password

Run this command in the WordPress environment:

```bash
wp user application-password create clients@sheragency.com "WP-Instance-Creator" --path=/var/www/html --allow-root
```

**Example output:**
```
Success: Created application password.
Password: AbCd 1234 EfGh 5678 IjKl 9012
```

**Important:** Copy the password (remove spaces):
```
AbCd1234EfGh5678IjKl9012
```

### Step 3: Add to Environment Variables

Add the Application Password to your DigitalOcean App Platform environment:

1. Go to: https://cloud.digitalocean.com/apps/7ztm4/settings
2. Navigate to "Environment Variables"
3. Add new variable:
   - **Name:** `WP_APP_PASSWORD`
   - **Value:** `AbCd1234EfGh5678IjKl9012` (your password without spaces)
   - **Scope:** All components
   - **Encryption:** Encrypted
4. Save and redeploy

### Step 4: Verify REST API Access

Test that the REST API is accessible and authentication works:

```bash
# Check REST API is available
curl http://<your-domain>/wp-json/

# Test authentication (replace PASSWORD with your Application Password)
curl -X GET http://<your-domain>/wp-json/wp/v2/settings \
  -H "Authorization: Basic $(echo -n 'clients@sheragency.com:PASSWORD' | base64)"
```

You should see JSON output with WordPress settings.

## Implementation Selection

### Option 1: Pure REST API (Recommended for Docker/LXD)
- **File:** `server-v2-no-ssh.js`
- **Requirements:** Pre-configured Application Password in template
- **SSH needed:** No
- **Best for:** Containerized WordPress (Docker, LXD)

### Option 2: Bootstrap with Minimal SSH
- **File:** `server-restapi.js`
- **Requirements:** SSH access to WP-CLI
- **SSH needed:** Only once per instance (to create Application Password)
- **Best for:** Traditional droplets with SSH access

### Option 3: Original SSH Method
- **File:** `server.js` (current)
- **Requirements:** Full SSH access to MySQL and WP-CLI
- **SSH needed:** Yes, for all operations
- **Status:** Current blocker with containers

## Deployment Steps

### 1. Choose Implementation

For Docker/LXD template, use Option 1 (Pure REST API):

```bash
cd /Users/max/.openclaw/workspace-forge/wp-instance-creator
cp server-v2-no-ssh.js server.js
```

### 2. Update package.json

Ensure dependencies are installed:

```bash
npm install
```

### 3. Commit and Push

```bash
git add server.js SETUP-TEMPLATE.md
git commit -m "feat: implement REST API configuration (no SSH required)"
git push origin main
```

### 4. Deploy to DigitalOcean

The app will auto-deploy from GitHub. Monitor at:
https://cloud.digitalocean.com/apps/7ztm4/

### 5. Test End-to-End

1. Visit: https://wp-instance-creator-7ztm4.ondigitalocean.app
2. Create a test instance (e.g., subdomain: `rest-test`)
3. Monitor job status via `/api/status/<jobId>`
4. Verify:
   - Droplet created
   - DNS configured
   - WordPress accessible
   - Admin password works
   - REST API configured site correctly

### 6. Clean Up Test

Delete the test droplet via DigitalOcean console.

## Troubleshooting

### Error: "WP API error: 401 Unauthorized"

**Cause:** Application Password not set or incorrect.

**Fix:**
1. Verify `WP_APP_PASSWORD` env var is set in DigitalOcean App Platform
2. Recreate Application Password on template droplet
3. Update env var and redeploy

### Error: "WordPress not accessible after 300s"

**Cause:** WordPress or web server not starting in container.

**Fix:**
1. SSH to template droplet
2. Check container status: `docker ps` or `lxc list`
3. Check container logs: `docker logs <container>` or `lxc exec <container> -- journalctl`
4. Verify nginx/apache is running in container

### Error: "REST API test failed"

**Cause:** REST API not enabled or blocked.

**Fix:**
1. Verify REST API is accessible: `curl http://<domain>/wp-json/`
2. Check nginx/apache configuration for REST API blocks
3. Ensure `.htaccess` or nginx config allows REST API requests

## Configuration Reference

### Required Environment Variables

```bash
# DigitalOcean
DO_API_TOKEN=dop_v1_...

# App Security
FORM_PASSWORD=your-secure-password

# WordPress REST API (NEW)
WP_ADMIN_USER=clients@sheragency.com
WP_APP_PASSWORD=AbCd1234EfGh5678IjKl9012

# Legacy (not needed for REST API version)
# SSH_PRIVATE_KEY=... (can be removed)
```

### REST API Endpoints Used

1. **GET /wp-json/** - API discovery
2. **GET /wp-json/wp/v2/settings** - Get current settings
3. **POST /wp-json/wp/v2/settings** - Update site URL, title, permalinks
4. **GET /wp-json/wp/v2/users** - Search for users
5. **POST /wp-json/wp/v2/users/{id}** - Update user password

## Benefits of REST API Approach

✅ **Container-friendly:** Works with Docker/LXD/any containerized WordPress  
✅ **No SSH required:** Zero SSH commands after template is set up  
✅ **Secure:** Uses WordPress Application Passwords (can be revoked)  
✅ **Maintainable:** Standard WordPress REST API (well-documented)  
✅ **Fast:** No SSH handshake delays  
✅ **Reliable:** Fewer network dependencies (HTTP only)  

## Next Steps

1. Complete template droplet setup (Steps 1-4 above)
2. Deploy new version (choose Option 1 or 2)
3. Test with a real instance
4. Update documentation with any findings
5. Consider automating SSL installation (e.g., Cloudflare API)
