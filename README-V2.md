# WordPress Instance Creator v2.0 - REST API Edition

## What Changed?

### v1.0 (SSH-based)
- ❌ Used SSH to run MySQL commands
- ❌ Used SSH to run WP-CLI commands  
- ❌ Required direct access to MySQL and wp binary
- ❌ **Blocker:** Doesn't work with Docker/LXD containers

### v2.0 (REST API-based)
- ✅ Uses WordPress REST API for all configuration
- ✅ No SSH required (after initial template setup)
- ✅ Works with Docker, LXD, or any containerized WordPress
- ✅ Leverages Application Passwords for secure authentication

## Architecture

### Before (v1.0 - SSH)
```
Automation App → DigitalOcean API (create droplet)
                ↓
Automation App → SSH → MySQL (update site URLs)
                ↓
Automation App → SSH → WP-CLI (set password, fix permissions)
```

### After (v2.0 - REST API)
```
Automation App → DigitalOcean API (create droplet)
                ↓
Automation App → WordPress REST API (all configuration)
                - Update site URLs
                - Set admin password
                - Configure permalinks
                - (No SSH needed!)
```

## Implementation Options

We created **three versions** for flexibility:

### 1. `server-original-ssh.js` (v1.0)
- **Status:** Current production (has container issues)
- Uses SSH for everything
- Blocked by LXD/Docker container access

### 2. `server-restapi.js` (v2.0 Hybrid)
- Uses SSH **once** to bootstrap Application Password
- Then uses REST API for configuration
- Falls back gracefully if SSH bootstrap fails

### 3. `server.js` (v2.0 Pure REST API) ← **RECOMMENDED**
- **Zero SSH** after template is configured
- Requires one-time Application Password setup on template
- Best for containerized environments

## Setup Required

Before deploying, you **must** configure the template droplet:

1. **Create Application Password on Template:**

   ```bash
   # SSH to template droplet (ID: 551293569)
   ssh root@<template-ip>
   
   # Access WordPress (adjust for your container setup)
   # Option A: If WordPress is in Docker
   docker exec -it <container-name> bash
   
   # Option B: If WordPress is in LXD
   lxc exec <container-name> -- bash
   
   # Create Application Password
   wp user application-password create clients@sheragency.com "WP-Instance-Creator" --path=/var/www/html --allow-root
   ```

2. **Add to DigitalOcean App Environment:**

   - Go to: https://cloud.digitalocean.com/apps/7ztm4/settings
   - Add environment variable:
     - Name: `WP_APP_PASSWORD`
     - Value: `<password-from-step-1>` (remove spaces)
     - Encrypted: Yes
   - Save and redeploy

3. **Optional: Remove SSH_PRIVATE_KEY**

   The new version doesn't need SSH, so you can remove `SSH_PRIVATE_KEY` from environment variables (but it won't hurt to leave it).

## Deployment

### Automated (Current Setup)
```bash
git add .
git commit -m "feat: REST API configuration (v2.0)"
git push origin main
```

DigitalOcean will auto-deploy from GitHub.

### Manual Testing
```bash
npm install
WP_APP_PASSWORD=your-app-password npm start
```

Visit: http://localhost:3000

## Testing

### 1. Health Check
```bash
curl http://localhost:3000/api/health
```

Expected output:
```json
{
  "status": "ok",
  "version": "2.0-restapi-no-ssh",
  "config": {
    "hasDoToken": true,
    "hasFormPassword": true,
    "hasWpAppPassword": true
  }
}
```

### 2. Create Test Instance
```bash
curl -X POST http://localhost:3000/api/create-instance \
  -H "Content-Type: application/json" \
  -d '{
    "subdomain": "rest-test",
    "wpAdminPassword": "SecurePass123!",
    "password": "your-form-password"
  }'
```

Expected output:
```json
{
  "success": true,
  "jobId": "uuid-here",
  "message": "Instance creation started (REST API configuration - no SSH required)",
  "statusUrl": "/api/status/uuid-here"
}
```

### 3. Monitor Progress
```bash
curl http://localhost:3000/api/status/<jobId>
```

Watch for these steps:
1. ✅ Snapshot created
2. ✅ Droplet created
3. ✅ DNS configured
4. ✅ WordPress REST API accessible
5. ✅ Site URL configured via REST API
6. ✅ Permalink structure configured via REST API
7. ✅ Admin password updated via REST API
8. ✅ Site verification passed

## API Endpoints

### POST /api/create-instance
Create a new WordPress instance.

**Body:**
```json
{
  "subdomain": "client-name",
  "wpAdminPassword": "SecurePassword123!",
  "password": "your-form-password"
}
```

**Response:**
```json
{
  "success": true,
  "jobId": "abc-123",
  "statusUrl": "/api/status/abc-123"
}
```

### GET /api/status/:jobId
Get job progress and status.

**Response:**
```json
{
  "success": true,
  "job": {
    "id": "abc-123",
    "subdomain": "client-name",
    "status": "completed",
    "progress": {
      "step": "verify_success",
      "message": "✓ Site is accessible",
      "steps": [...]
    },
    "result": {
      "domain": "client-name.sherstaging.com",
      "wpAdminUrl": "http://client-name.sherstaging.com/wp-admin",
      "wpAdminUser": "clients@sheragency.com",
      "configMethod": "REST API (no SSH)"
    }
  }
}
```

### GET /api/health
System health check.

### GET /api/jobs
List all jobs.

## WordPress REST API Usage

The automation uses these WordPress REST API endpoints:

1. **GET /wp-json/** - Verify API is accessible
2. **POST /wp-json/wp/v2/settings** - Update site URL and title
   ```json
   {
     "url": "http://subdomain.sherstaging.com",
     "title": "Client Site - Sher Agency"
   }
   ```

3. **POST /wp-json/wp/v2/settings** - Update permalink structure
   ```json
   {
     "permalink_structure": "/%postname%/"
   }
   ```

4. **GET /wp-json/wp/v2/users?search=...** - Find admin user

5. **POST /wp-json/wp/v2/users/{id}** - Update admin password
   ```json
   {
     "password": "NewSecurePassword123!"
   }
   ```

## Authentication

Uses **WordPress Application Passwords** (introduced in WP 5.6):

```
Authorization: Basic base64(username:app_password)
```

Example:
```bash
Authorization: Basic Y2xpZW50c0BzaGVyYWdlbmN5LmNvbTpBYkNkMTIzNEVmR2g1Njc4SWpLbDkwMTI=
```

## Security Notes

- Application Passwords can be revoked per-user via WP Admin
- Passwords are stored encrypted in DigitalOcean environment
- REST API uses HTTPS in production (after SSL installation)
- Each instance gets its own unique admin password

## Troubleshooting

### "WP API error: 401 Unauthorized"

**Cause:** Application Password not configured or incorrect.

**Fix:**
1. Verify `WP_APP_PASSWORD` environment variable
2. Recreate Application Password on template droplet
3. Update environment variable and redeploy

### "WordPress not accessible after 300s"

**Cause:** WordPress container not starting or web server issue.

**Fix:**
1. Check droplet status in DigitalOcean console
2. SSH to droplet and check container status
3. Review container logs for errors

### "REST API test failed"

**Cause:** REST API blocked or disabled.

**Fix:**
1. Test manually: `curl http://domain.com/wp-json/`
2. Check nginx/apache configuration
3. Verify WordPress REST API is enabled

## Migration from v1.0

If you're currently using the SSH-based version:

1. Set up Application Password on template (see Setup Required)
2. Add `WP_APP_PASSWORD` to environment variables
3. Deploy new version (automatic via GitHub)
4. Test with a new instance
5. Optionally remove `SSH_PRIVATE_KEY` (no longer needed)

## Future Improvements

- [ ] SSL installation via REST API or Cloudflare API (currently requires SSH)
- [ ] Plugin installation via REST API
- [ ] Theme configuration via REST API
- [ ] Automated backup configuration
- [ ] Multi-template support

## Support

For issues or questions:
- GitHub: https://github.com/maxdevs97/wp-instance-creator
- App: https://wp-instance-creator-7ztm4.ondigitalocean.app

## Version History

- **v2.0** (2026-02-18): REST API configuration, zero SSH required
- **v1.0** (2026-02-10): SSH-based configuration (initial release)
