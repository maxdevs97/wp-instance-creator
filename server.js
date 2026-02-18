const express = require('express');
const fetch = require('node-fetch');
const { Client } = require('ssh2');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Configuration
const DO_API_TOKEN = process.env.DO_API_TOKEN;
const FORM_PASSWORD = process.env.FORM_PASSWORD;
const SSH_PRIVATE_KEY = process.env.SSH_PRIVATE_KEY;
const TEMPLATE_DROPLET_ID = '551293569';
const DOMAIN = 'sherstaging.com';

// DigitalOcean API helper
async function doApiCall(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${DO_API_TOKEN}`,
      'Content-Type': 'application/json'
    }
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(`https://api.digitalocean.com/v2${endpoint}`, options);
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(data.message || `API call failed: ${response.statusText}`);
  }
  
  return data;
}

// Sleep helper
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// SSH command executor
async function sshExecute(host, commands) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const results = [];
    
    conn.on('ready', () => {
      console.log(`SSH connected to ${host}`);
      
      const executeCommand = (index) => {
        if (index >= commands.length) {
          conn.end();
          resolve(results);
          return;
        }
        
        const cmd = commands[index];
        console.log(`Executing: ${cmd}`);
        
        conn.exec(cmd, (err, stream) => {
          if (err) {
            conn.end();
            reject(err);
            return;
          }
          
          let stdout = '';
          let stderr = '';
          
          stream.on('data', (data) => {
            stdout += data.toString();
          });
          
          stream.stderr.on('data', (data) => {
            stderr += data.toString();
          });
          
          stream.on('close', (code) => {
            results.push({ cmd, stdout, stderr, code });
            executeCommand(index + 1);
          });
        });
      };
      
      executeCommand(0);
    });
    
    conn.on('error', (err) => {
      reject(err);
    });
    
    conn.connect({
      host,
      port: 22,
      username: 'root',
      privateKey: SSH_PRIVATE_KEY
    });
  });
}

// Password verification endpoint
app.post('/api/verify-password', (req, res) => {
  const { password } = req.body;
  
  if (password === FORM_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Invalid password' });
  }
});

// Main endpoint: Create WordPress instance
app.post('/api/create-instance', async (req, res) => {
  const { subdomain, wpAdminPassword, password } = req.body;
  
  // Verify password
  if (password !== FORM_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Invalid password' });
  }
  
  // Validate inputs
  if (!subdomain || !wpAdminPassword) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }
  
  // Validate subdomain format
  if (!/^[a-z0-9-]+$/.test(subdomain)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid subdomain format. Use only lowercase letters, numbers, and hyphens.' 
    });
  }
  
  const fullDomain = `${subdomain}.${DOMAIN}`;
  const logMessages = [];
  
  try {
    // Step 1: Create snapshot of template droplet
    logMessages.push('Creating snapshot of template droplet...');
    const snapshotName = `wp-snapshot-${subdomain}-${Date.now()}`;
    
    const snapshotResponse = await doApiCall(
      `/droplets/${TEMPLATE_DROPLET_ID}/actions`,
      'POST',
      { type: 'snapshot', name: snapshotName }
    );
    
    const actionId = snapshotResponse.action.id;
    logMessages.push(`Snapshot creation initiated (Action ID: ${actionId})`);
    
    // Wait for snapshot to complete
    logMessages.push('Waiting for snapshot to complete...');
    let snapshotComplete = false;
    let attempts = 0;
    const maxAttempts = 60; // 10 minutes max
    
    while (!snapshotComplete && attempts < maxAttempts) {
      await sleep(10000); // Wait 10 seconds
      const actionStatus = await doApiCall(`/actions/${actionId}`);
      
      if (actionStatus.action.status === 'completed') {
        snapshotComplete = true;
        logMessages.push('Snapshot completed successfully');
      } else if (actionStatus.action.status === 'errored') {
        throw new Error('Snapshot creation failed');
      }
      attempts++;
    }
    
    if (!snapshotComplete) {
      throw new Error('Snapshot creation timed out');
    }
    
    // Get snapshot ID
    const snapshots = await doApiCall('/snapshots?resource_type=droplet');
    const snapshot = snapshots.snapshots.find(s => s.name === snapshotName);
    
    if (!snapshot) {
      throw new Error('Snapshot not found after creation');
    }
    
    logMessages.push(`Snapshot ID: ${snapshot.id}`);
    
    // Step 2: Create new droplet from snapshot
    logMessages.push('Creating new droplet from snapshot...');
    const dropletName = `wp-${subdomain}`;
    
    const dropletResponse = await doApiCall('/droplets', 'POST', {
      name: dropletName,
      region: 'nyc3',
      size: 's-1vcpu-1gb',
      image: snapshot.id,
      ssh_keys: [], // Will use existing keys from snapshot
      backups: false,
      ipv6: false,
      monitoring: true
    });
    
    const newDropletId = dropletResponse.droplet.id;
    logMessages.push(`Droplet created (ID: ${newDropletId})`);
    
    // Wait for droplet to be active
    logMessages.push('Waiting for droplet to become active...');
    let dropletActive = false;
    attempts = 0;
    let dropletIp = null;
    
    while (!dropletActive && attempts < maxAttempts) {
      await sleep(10000); // Wait 10 seconds
      const dropletStatus = await doApiCall(`/droplets/${newDropletId}`);
      
      if (dropletStatus.droplet.status === 'active') {
        dropletActive = true;
        dropletIp = dropletStatus.droplet.networks.v4.find(n => n.type === 'public')?.ip_address;
        logMessages.push(`Droplet active with IP: ${dropletIp}`);
      }
      attempts++;
    }
    
    if (!dropletActive || !dropletIp) {
      throw new Error('Droplet failed to become active or no IP assigned');
    }
    
    // Step 3: Configure DNS
    logMessages.push('Configuring DNS A record...');
    
    // Check if record already exists
    const existingRecords = await doApiCall(`/domains/${DOMAIN}/records`);
    const existingRecord = existingRecords.domain_records.find(
      r => r.type === 'A' && r.name === subdomain
    );
    
    if (existingRecord) {
      // Update existing record
      await doApiCall(
        `/domains/${DOMAIN}/records/${existingRecord.id}`,
        'PUT',
        { data: dropletIp }
      );
      logMessages.push('Updated existing DNS A record');
    } else {
      // Create new record
      await doApiCall(`/domains/${DOMAIN}/records`, 'POST', {
        type: 'A',
        name: subdomain,
        data: dropletIp,
        ttl: 300
      });
      logMessages.push('Created new DNS A record');
    }
    
    // Step 4: Wait for SSH to be ready
    logMessages.push('Waiting for SSH to be ready...');
    await sleep(30000); // Wait 30 seconds for droplet to fully boot
    
    // Step 5: SSH into droplet and configure
    logMessages.push('Connecting via SSH to configure WordPress...');
    
    const sshCommands = [
      // Update site URL in WordPress database
      `mysql -u root -e "USE wordpress; UPDATE wp_options SET option_value='https://${fullDomain}' WHERE option_name IN ('siteurl', 'home');"`,
      
      // Update wp-config.php if needed
      `sed -i "s|define( 'WP_HOME'.*|define( 'WP_HOME', 'https://${fullDomain}' );|g" /var/www/html/wp-config.php || true`,
      `sed -i "s|define( 'WP_SITEURL'.*|define( 'WP_SITEURL', 'https://${fullDomain}' );|g" /var/www/html/wp-config.php || true`,
      
      // Set WP admin password
      `wp user update clients@sheragency.com --user_pass='${wpAdminPassword}' --path=/var/www/html --allow-root`,
      
      // Fix permissions
      `chown -R www-data:www-data /var/www/html/wp-content/uploads`,
      `chown -R www-data:www-data /var/www/html/wp-content/plugins`,
      `find /var/www/html/wp-content/uploads -type d -exec chmod 755 {} \\;`,
      `find /var/www/html/wp-content/uploads -type f -exec chmod 644 {} \\;`,
      `find /var/www/html/wp-content/plugins -type d -exec chmod 755 {} \\;`,
      `find /var/www/html/wp-content/plugins -type f -exec chmod 644 {} \\;`,
      
      // Install SSL certificate
      `certbot --nginx -d ${fullDomain} --non-interactive --agree-tos --email clients@sheragency.com --redirect`,
      
      // Restart nginx
      `systemctl restart nginx`
    ];
    
    const sshResults = await sshExecute(dropletIp, sshCommands);
    logMessages.push('WordPress configuration completed');
    
    // Check for any command failures
    const failedCommands = sshResults.filter(r => r.code !== 0);
    if (failedCommands.length > 0) {
      logMessages.push('Warning: Some commands had non-zero exit codes');
      failedCommands.forEach(f => {
        logMessages.push(`  - ${f.cmd}: exit code ${f.code}`);
        if (f.stderr) logMessages.push(`    ${f.stderr}`);
      });
    }
    
    // Step 6: Verify site is accessible
    logMessages.push(`Testing site accessibility at https://${fullDomain}...`);
    await sleep(5000); // Brief wait for nginx restart
    
    try {
      const siteCheck = await fetch(`https://${fullDomain}`, { 
        timeout: 10000,
        headers: { 'User-Agent': 'WP-Instance-Creator/1.0' }
      });
      
      if (siteCheck.ok) {
        logMessages.push('✓ Site is accessible with SSL');
      } else {
        logMessages.push(`⚠ Site returned status ${siteCheck.status}`);
      }
    } catch (error) {
      logMessages.push(`⚠ Site check failed: ${error.message}`);
    }
    
    // Success response
    res.json({
      success: true,
      message: 'WordPress instance created successfully',
      details: {
        domain: fullDomain,
        dropletId: newDropletId,
        dropletIp,
        snapshotId: snapshot.id,
        wpAdminUrl: `https://${fullDomain}/wp-admin`,
        wpAdminUser: 'clients@sheragency.com'
      },
      log: logMessages
    });
    
  } catch (error) {
    console.error('Error creating instance:', error);
    logMessages.push(`ERROR: ${error.message}`);
    
    res.status(500).json({
      success: false,
      message: error.message,
      log: logMessages
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    config: {
      hasDoToken: !!DO_API_TOKEN,
      hasFormPassword: !!FORM_PASSWORD,
      hasSshKey: !!SSH_PRIVATE_KEY
    }
  });
});

app.listen(PORT, () => {
  console.log(`WP Instance Creator running on port ${PORT}`);
  console.log(`Environment check:`);
  console.log(`  - DO API Token: ${DO_API_TOKEN ? '✓' : '✗'}`);
  console.log(`  - Form Password: ${FORM_PASSWORD ? '✓' : '✗'}`);
  console.log(`  - SSH Key: ${SSH_PRIVATE_KEY ? '✓' : '✗'}`);
});
