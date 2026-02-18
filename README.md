# WordPress Instance Creator

Automated WordPress instance creation tool that clones the template droplet `mbstest1.sherstaging.com` and configures new instances with SSL, DNS, and WordPress settings.

## Features

- 🚀 **Automated Droplet Cloning**: Creates snapshot of template droplet and deploys new instance
- 🌐 **DNS Configuration**: Automatically creates A records for new subdomains
- 🔒 **SSL Certificates**: Installs Let's Encrypt SSL certificates via certbot
- 🔧 **WordPress Configuration**: Updates site URLs, admin passwords, and permissions
- 🔐 **Password Protected**: Team password gate for security
- 📊 **Real-time Logging**: Shows detailed progress of each step

## Template Droplet

- **Name**: wordpress-managed-20260212
- **ID**: 551293569
- **IP**: 45.55.140.46
- **Domain**: mbstest1.sherstaging.com

## How It Works

1. **Create Snapshot**: Takes a snapshot of the template droplet
2. **Deploy Droplet**: Creates a new droplet from the snapshot
3. **Configure DNS**: Adds A record for `{subdomain}.sherstaging.com`
4. **SSH Configuration**: Connects to new droplet and:
   - Updates WordPress site URLs in database
   - Sets admin password for `clients@sheragency.com`
   - Fixes file permissions (uploads, plugins)
   - Installs SSL certificate with certbot
   - Restarts nginx
5. **Verify**: Tests that the site is accessible with HTTPS

## Setup

### Prerequisites

- Node.js 18+
- DigitalOcean account with API access
- SSH private key for connecting to droplets
- Domain managed in DigitalOcean DNS

### Environment Variables

Create a `.env` file with:

```env
DO_API_TOKEN=your_digitalocean_api_token
FORM_PASSWORD=your_team_password
SSH_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
```

### Local Development

```bash
npm install
npm start
```

Visit `http://localhost:3000`

### Deployment to DigitalOcean App Platform

```bash
# Push to GitHub
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/maxdevs97/wp-instance-creator.git
git push -u origin main

# Deploy via DO console or CLI
# Add environment variables in App Platform settings
```

## Usage

1. Visit the form URL
2. Enter team password to unlock form
3. Enter desired subdomain (e.g., "project1" → project1.sherstaging.com)
4. Enter WordPress admin password
5. Click "Create WordPress Instance"
6. Wait 5-10 minutes for automation to complete
7. Access your new site at `https://{subdomain}.sherstaging.com`

## WordPress Admin Login

- **URL**: `https://{subdomain}.sherstaging.com/wp-admin`
- **Username**: `clients@sheragency.com`
- **Password**: (whatever you set in the form)

## API Endpoints

### `POST /api/verify-password`
Verify team password

**Request:**
```json
{
  "password": "team_password"
}
```

**Response:**
```json
{
  "success": true
}
```

### `POST /api/create-instance`
Create new WordPress instance

**Request:**
```json
{
  "subdomain": "project1",
  "wpAdminPassword": "secure_password",
  "password": "team_password"
}
```

**Response:**
```json
{
  "success": true,
  "message": "WordPress instance created successfully",
  "details": {
    "domain": "project1.sherstaging.com",
    "dropletId": "123456789",
    "dropletIp": "1.2.3.4",
    "snapshotId": "987654321",
    "wpAdminUrl": "https://project1.sherstaging.com/wp-admin",
    "wpAdminUser": "clients@sheragency.com"
  },
  "log": [
    "Creating snapshot of template droplet...",
    "Snapshot completed successfully",
    "..."
  ]
}
```

### `GET /api/health`
Health check endpoint

## Limitations

- **Droplet Limit**: Check DigitalOcean account droplet limit before creating instances
- **DNS Propagation**: May take 1-5 minutes for DNS to fully propagate
- **SSL Certificate**: Requires domain to be accessible via HTTP first (certbot verification)
- **Snapshot Time**: Creating snapshot takes 3-5 minutes
- **Droplet Boot**: New droplet takes 1-2 minutes to boot and be SSH-ready

## Troubleshooting

### "Droplet creation failed"
- Check DigitalOcean droplet limit
- Verify API token has write permissions
- Check account billing status

### "DNS configuration failed"
- Verify domain is managed in DigitalOcean
- Check API token has DNS management permissions
- Ensure subdomain doesn't already exist

### "SSL certificate installation failed"
- Wait 5 minutes for DNS propagation
- Check that port 80 is accessible
- Verify domain points to correct IP
- Check nginx is running

### "SSH connection failed"
- Verify SSH private key is correct
- Wait longer for droplet to boot (try 60 seconds)
- Check droplet firewall rules
- Verify SSH key was copied to template droplet

## Security Notes

- Form password protects the interface from unauthorized use
- All API calls use DigitalOcean API token authentication
- SSH uses private key authentication (no passwords)
- SSL certificates are automatically installed
- Admin passwords should be strong (8+ characters required)

## Future Enhancements

- [ ] Email notifications when instance is ready
- [ ] Custom WordPress plugin installation
- [ ] Database import from existing site
- [ ] Automatic backups configuration
- [ ] Multi-region support
- [ ] Bulk instance creation
- [ ] Instance management dashboard (list, delete, restart)

## License

MIT

## Support

For issues or questions, contact the development team.
