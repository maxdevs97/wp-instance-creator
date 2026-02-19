# SSL Setup Guide for WordPress Instance Creator

## Problem

When creating new WordPress instances from the template, SSL certificates don't automatically work because:
- Template has SSL for `mbstest1.sherstaging.com`
- New subdomains (e.g., `client1.sherstaging.com`) don't have certificates
- Certbot certificates are subdomain-specific

## Solution Options

### Option 1: Wildcard SSL Certificate (Recommended)

Set up a wildcard SSL certificate on the template droplet that covers `*.sherstaging.com`.

**Prerequisites:**
- Access to DigitalOcean DNS (already have via API)
- Template droplet with SSH access
- Certbot with DNS challenge plugin

**Setup Steps:**

1. SSH to template droplet:
```bash
ssh root@<template-droplet-ip>
```

2. Install certbot DNS plugin:
```bash
apt-get update
apt-get install -y certbot python3-certbot-nginx python3-certbot-dns-digitalocean
```

3. Create DigitalOcean API token file:
```bash
mkdir -p /root/.secrets
cat > /root/.secrets/digitalocean.ini << EOF
dns_digitalocean_token = YOUR_DIGITALOCEAN_API_TOKEN
EOF
chmod 600 /root/.secrets/digitalocean.ini
```

**Note:** Replace `YOUR_DIGITALOCEAN_API_TOKEN` with your actual DigitalOcean API token (available in `.env` file).

4. Request wildcard certificate:
```bash
certbot certonly \
  --dns-digitalocean \
  --dns-digitalocean-credentials /root/.secrets/digitalocean.ini \
  --dns-digitalocean-propagation-seconds 60 \
  -d sherstaging.com \
  -d '*.sherstaging.com' \
  --non-interactive \
  --agree-tos \
  -m admin@sheragency.com
```

5. Configure nginx to use wildcard certificate:
```bash
# Edit nginx config
nano /etc/nginx/sites-available/default

# Update SSL certificate paths:
ssl_certificate /etc/letsencrypt/live/sherstaging.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/sherstaging.com/privkey.pem;

# Test and reload nginx
nginx -t
systemctl reload nginx
```

6. Set up auto-renewal:
```bash
# Add renewal cron job
crontab -e

# Add this line:
0 3 * * * certbot renew --quiet --deploy-hook "systemctl reload nginx"
```

7. Create snapshot:
```bash
# Via DigitalOcean API (from local machine)
curl -X POST "https://api.digitalocean.com/v2/droplets/<template-droplet-id>/actions" \
  -H "Authorization: Bearer $DO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"snapshot","name":"wp-template-wildcard-ssl"}'
```

**Result:** All new instances will have HTTPS working immediately for any subdomain.

---

### Option 2: Certbot Automation After Droplet Creation

Add certbot automation to the workflow that runs after each droplet is created.

**Implementation:**

Add SSH connection to the new droplet after DNS propagation:

```javascript
// In server.js, after DNS propagation step

// Step 6: Install SSL certificate
updateJobProgress(jobId, 'ssl_start', 'Installing SSL certificate...');

const sshKey = process.env.SSH_PRIVATE_KEY;
if (sshKey) {
  const { NodeSSH } = require('node-ssh');
  const ssh = new NodeSSH();
  
  await ssh.connect({
    host: dropletIp,
    username: 'root',
    privateKey: sshKey
  });
  
  // Wait for certbot to be available
  await ssh.execCommand('which certbot', { cwd: '/root' });
  
  // Run certbot
  const result = await ssh.execCommand(
    `certbot --nginx -d ${fullDomain} --non-interactive --agree-tos -m admin@sheragency.com`,
    { cwd: '/root' }
  );
  
  if (result.code === 0) {
    updateJobProgress(jobId, 'ssl_complete', 'SSL certificate installed successfully');
    sslStatus = 'installed';
    wpAdminUrl = `https://${fullDomain}/wp-admin`;
  } else {
    updateJobProgress(jobId, 'ssl_warning', `SSL installation failed: ${result.stderr}`);
  }
  
  ssh.dispose();
}
```

**Requirements:**
- Valid SSH key with access to new droplets
- `node-ssh` package: `npm install node-ssh`
- 5-10 minute wait for DNS propagation before running certbot

---

### Option 3: Cloudflare SSL (Alternative)

Use Cloudflare for SSL termination instead of Let's Encrypt.

**Setup Steps:**

1. Add `sherstaging.com` to Cloudflare
2. Set nameservers at domain registrar to Cloudflare's nameservers
3. Enable SSL/TLS in Cloudflare (Full or Flexible mode)
4. All subdomains automatically get SSL via Cloudflare

**Pros:**
- Zero configuration needed per instance
- Automatic SSL for all subdomains
- DDoS protection included
- Free tier available

**Cons:**
- Requires changing nameservers
- SSL terminates at Cloudflare (not origin)
- Extra layer between users and droplets

---

## Current Implementation

**Version 3.1 (This Version):**
- ✅ Fixed username display (shows `clients@sheragency.com`)
- ✅ Added `/api/install-ssl` endpoint (returns manual setup instructions)
- ⚠️ HTTPS requires manual setup or implementation of Option 1/2/3

**Manual SSL Setup (Current Workaround):**

After creating an instance:

1. Wait 5-10 minutes for DNS propagation
2. SSH to the new droplet:
```bash
ssh root@<droplet-ip>
```

3. Run certbot:
```bash
certbot --nginx -d <subdomain>.sherstaging.com --non-interactive --agree-tos -m admin@sheragency.com
```

4. Verify HTTPS works:
```bash
curl -I https://<subdomain>.sherstaging.com
```

---

## Recommended Next Steps

1. **Immediate:** Implement Option 1 (Wildcard SSL) - most reliable
2. **Short-term:** Document manual SSL setup for users
3. **Long-term:** Consider Cloudflare if creating many instances

---

## Technical Notes

**Why doesn't the template SSL copy over?**
- SSL certificates are domain-specific
- Certbot stores certs at `/etc/letsencrypt/live/<domain>/`
- Template has cert for `mbstest1.sherstaging.com`
- New instances need certs for their own subdomains
- Wildcard cert solves this by covering `*.sherstaging.com`

**Can we use the same cert for all subdomains?**
- Yes, with a wildcard certificate
- Standard cert only covers exact domain listed
- Wildcard cert (`*.sherstaging.com`) covers all subdomains

**SSH Key Issue:**
- Current SSH key in `.env` doesn't work for template droplet
- Need to either:
  - Add the key to template droplet's `authorized_keys`
  - OR generate new key pair and add to DigitalOcean account
  - OR use DigitalOcean API to retrieve droplet root password

---

## Files Modified in This Update

1. `server.js`:
   - Added `wpAdminUser: 'clients@sheragency.com'` to completion result
   - Changed `sslStatus` from `'not configured'` to `'pending'`
   - Added `/api/install-ssl` endpoint
   - Updated version to `3.1-fixed-username-ssl`

2. `SSL-SETUP-GUIDE.md` (this file):
   - Comprehensive SSL setup documentation
   - Three implementation options
   - Manual workaround steps

---

## Support

For questions about SSL setup, contact Max or refer to:
- Let's Encrypt docs: https://letsencrypt.org/docs/
- Certbot docs: https://certbot.eff.org/
- DigitalOcean DNS API: https://docs.digitalocean.com/reference/api/api-reference/#tag/Domain-Records
