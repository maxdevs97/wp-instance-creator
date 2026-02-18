const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { Client } = require('ssh2');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Configuration
const DO_API_TOKEN = process.env.DO_API_TOKEN;
const FORM_PASSWORD = process.env.FORM_PASSWORD;

// Fix SSH private key (only needed for bootstrap)
let SSH_PRIVATE_KEY = process.env.SSH_PRIVATE_KEY;
if (SSH_PRIVATE_KEY) {
  SSH_PRIVATE_KEY = SSH_PRIVATE_KEY.replace(/\\n/g, '\n');
  SSH_PRIVATE_KEY = SSH_PRIVATE_KEY.replace(/^["']|["']$/g, '');
}

const TEMPLATE_DROPLET_ID = '551293569';
const DOMAIN = 'sherstaging.com';
const WP_ADMIN_USER = 'clients@sheragency.com';

// In-memory job queue
const jobs = new Map();

// Job status structure
function createJob(jobId, subdomain) {
  return {
    id: jobId,
    subdomain,
    status: 'pending',
    progress: {
      step: 'queued',
      message: 'Job queued, waiting to start...',
      steps: []
    },
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function updateJobProgress(jobId, step, message, status = null) {
  const job = jobs.get(jobId);
  if (!job) return;
  
  job.progress.step = step;
  job.progress.message = message;
  job.progress.steps.push({
    step,
    message,
    timestamp: new Date().toISOString()
  });
  
  if (status) {
    job.status = status;
  }
  
  job.updatedAt = new Date().toISOString();
  console.log(`[Job ${jobId}] ${step}: ${message}`);
}

function completeJob(jobId, result) {
  const job = jobs.get(jobId);
  if (!job) return;
  
  job.status = 'completed';
  job.result = result;
  job.updatedAt = new Date().toISOString();
  console.log(`[Job ${jobId}] Completed successfully`);
}

function failJob(jobId, error) {
  const job = jobs.get(jobId);
  if (!job) return;
  
  job.status = 'failed';
  job.error = error;
  job.updatedAt = new Date().toISOString();
  console.error(`[Job ${jobId}] Failed:`, error);
}

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

// WordPress REST API helper
async function wpApiCall(domain, endpoint, method = 'GET', body = null, auth = null, maxRetries = 3) {
  const url = `http://${domain}/wp-json${endpoint}`;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const options = {
        method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'WP-Instance-Creator/2.0'
        },
        timeout: 30000
      };
      
      if (auth) {
        const authString = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
        options.headers['Authorization'] = `Basic ${authString}`;
      }
      
      if (body) {
        options.body = JSON.stringify(body);
      }
      
      console.log(`WP API ${method} ${url} (attempt ${attempt}/${maxRetries})`);
      const response = await fetch(url, options);
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.message || `WP API call failed: ${response.statusText}`);
      }
      
      return data;
    } catch (error) {
      console.error(`WP API attempt ${attempt} failed:`, error.message);
      if (attempt < maxRetries) {
        await sleep(5000); // Wait 5 seconds before retry
      } else {
        throw error;
      }
    }
  }
}

// Wait for WordPress to be accessible
async function waitForWordPress(domain, maxWaitSeconds = 300) {
  const startTime = Date.now();
  let lastError = null;
  
  while ((Date.now() - startTime) / 1000 < maxWaitSeconds) {
    try {
      const response = await fetch(`http://${domain}`, {
        timeout: 10000,
        headers: { 'User-Agent': 'WP-Instance-Creator/2.0' }
      });
      
      if (response.ok) {
        console.log(`✓ WordPress is accessible at http://${domain}`);
        return true;
      }
      
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    
    await sleep(10000); // Wait 10 seconds between checks
  }
  
  throw new Error(`WordPress not accessible after ${maxWaitSeconds}s. Last error: ${lastError}`);
}

// Bootstrap WordPress admin user with Application Password via SSH (one-time only)
async function bootstrapWordPressAuth(dropletIp, appPassword) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    
    const commands = [
      // Create Application Password for the admin user
      `wp user application-password create ${WP_ADMIN_USER} "WP-Instance-Creator" --app_password="${appPassword}" --path=/var/www/html --allow-root || echo "Password already exists"`,
      
      // Verify WP-CLI works
      `wp user get ${WP_ADMIN_USER} --path=/var/www/html --allow-root`,
      
      // Enable REST API (should be enabled by default, but ensure it)
      `wp rewrite structure '/%postname%/' --path=/var/www/html --allow-root`
    ];
    
    let commandIndex = 0;
    const results = [];
    
    conn.on('ready', () => {
      console.log(`✓ SSH connected to ${dropletIp} for bootstrap`);
      
      const executeNext = () => {
        if (commandIndex >= commands.length) {
          conn.end();
          resolve(results);
          return;
        }
        
        const cmd = commands[commandIndex];
        console.log(`Bootstrap: ${cmd.substring(0, 100)}`);
        
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
            commandIndex++;
            executeNext();
          });
        });
      };
      
      executeNext();
    });
    
    conn.on('error', (err) => {
      console.error(`✗ Bootstrap SSH error:`, err.message);
      reject(err);
    });
    
    console.log(`Attempting bootstrap SSH connection to ${dropletIp}...`);
    conn.connect({
      host: dropletIp,
      port: 22,
      username: 'root',
      privateKey: SSH_PRIVATE_KEY,
      readyTimeout: 50000
    });
  });
}

// Background job processor
async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  
  try {
    job.status = 'processing';
    const { subdomain, wpAdminPassword } = job.metadata;
    const fullDomain = `${subdomain}.${DOMAIN}`;
    
    // Generate deterministic Application Password for this instance
    const appPassword = Buffer.from(`${subdomain}-${Date.now()}`).toString('base64').substring(0, 24);
    
    // Step 1: Create snapshot of template droplet
    updateJobProgress(jobId, 'snapshot_start', 'Creating snapshot of template droplet...');
    const snapshotName = `wp-snapshot-${subdomain}-${Date.now()}`;
    
    const snapshotResponse = await doApiCall(
      `/droplets/${TEMPLATE_DROPLET_ID}/actions`,
      'POST',
      { type: 'snapshot', name: snapshotName }
    );
    
    const actionId = snapshotResponse.action.id;
    updateJobProgress(jobId, 'snapshot_initiated', `Snapshot creation initiated (Action ID: ${actionId})`);
    
    // Wait for snapshot to complete
    updateJobProgress(jobId, 'snapshot_waiting', 'Waiting for snapshot to complete (3-5 minutes)...');
    let snapshotComplete = false;
    let attempts = 0;
    const maxAttempts = 60;
    
    while (!snapshotComplete && attempts < maxAttempts) {
      await sleep(10000);
      const actionStatus = await doApiCall(`/actions/${actionId}`);
      
      if (actionStatus.action.status === 'completed') {
        snapshotComplete = true;
        updateJobProgress(jobId, 'snapshot_complete', 'Snapshot completed successfully');
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
    
    updateJobProgress(jobId, 'snapshot_found', `Snapshot ID: ${snapshot.id}`);
    
    // Step 2: Create new droplet from snapshot
    updateJobProgress(jobId, 'droplet_start', 'Creating new droplet from snapshot...');
    const dropletName = `wp-${subdomain}`;
    
    const dropletResponse = await doApiCall('/droplets', 'POST', {
      name: dropletName,
      region: 'nyc3',
      size: 's-1vcpu-1gb',
      image: snapshot.id,
      ssh_keys: [54026256], // forge-key - only for bootstrap
      backups: false,
      ipv6: false,
      monitoring: true
    });
    
    const newDropletId = dropletResponse.droplet.id;
    updateJobProgress(jobId, 'droplet_created', `Droplet created (ID: ${newDropletId})`);
    
    // Wait for droplet to be active
    updateJobProgress(jobId, 'droplet_waiting', 'Waiting for droplet to become active...');
    let dropletActive = false;
    attempts = 0;
    let dropletIp = null;
    
    while (!dropletActive && attempts < maxAttempts) {
      await sleep(10000);
      const dropletStatus = await doApiCall(`/droplets/${newDropletId}`);
      
      if (dropletStatus.droplet.status === 'active') {
        dropletActive = true;
        dropletIp = dropletStatus.droplet.networks.v4.find(n => n.type === 'public')?.ip_address;
        updateJobProgress(jobId, 'droplet_active', `Droplet active with IP: ${dropletIp}`);
      }
      attempts++;
    }
    
    if (!dropletActive || !dropletIp) {
      throw new Error('Droplet failed to become active or no IP assigned');
    }
    
    // Step 3: Configure DNS
    updateJobProgress(jobId, 'dns_start', 'Configuring DNS A record...');
    
    const existingRecords = await doApiCall(`/domains/${DOMAIN}/records`);
    const existingRecord = existingRecords.domain_records.find(
      r => r.type === 'A' && r.name === subdomain
    );
    
    if (existingRecord) {
      await doApiCall(
        `/domains/${DOMAIN}/records/${existingRecord.id}`,
        'PUT',
        { data: dropletIp }
      );
      updateJobProgress(jobId, 'dns_updated', 'Updated existing DNS A record');
    } else {
      await doApiCall(`/domains/${DOMAIN}/records`, 'POST', {
        type: 'A',
        name: subdomain,
        data: dropletIp,
        ttl: 300
      });
      updateJobProgress(jobId, 'dns_created', 'Created new DNS A record');
    }
    
    // Step 4: Wait for WordPress to be accessible
    updateJobProgress(jobId, 'wp_wait', 'Waiting for WordPress to be accessible (checking HTTP)...');
    await sleep(60000); // Initial wait for boot
    await waitForWordPress(fullDomain, 120); // Wait up to 2 more minutes
    updateJobProgress(jobId, 'wp_ready', 'WordPress is accessible via HTTP');
    
    // Step 5: Bootstrap authentication (one-time SSH to create Application Password)
    updateJobProgress(jobId, 'auth_bootstrap', 'Bootstrapping WP REST API authentication...');
    await sleep(10000); // Brief wait for SSH to be ready
    
    try {
      const bootstrapResults = await bootstrapWordPressAuth(dropletIp, appPassword);
      updateJobProgress(jobId, 'auth_created', 'Application Password created for REST API access');
    } catch (error) {
      console.error('Bootstrap failed:', error.message);
      updateJobProgress(jobId, 'auth_warning', `Bootstrap warning: ${error.message} (continuing...)`);
    }
    
    // Step 6: Configure WordPress via REST API
    updateJobProgress(jobId, 'rest_config_start', 'Configuring WordPress via REST API...');
    
    const auth = {
      username: WP_ADMIN_USER,
      password: appPassword
    };
    
    // Update site URL and title
    try {
      await wpApiCall(fullDomain, '/wp/v2/settings', 'POST', {
        title: `${subdomain} - Sher Agency`,
        url: `http://${fullDomain}`
      }, auth);
      updateJobProgress(jobId, 'rest_url_updated', 'Site URL configured via REST API');
    } catch (error) {
      updateJobProgress(jobId, 'rest_url_warning', `Site URL update warning: ${error.message}`);
    }
    
    // Update permalink structure
    try {
      await wpApiCall(fullDomain, '/wp/v2/settings', 'POST', {
        permalink_structure: '/%postname%/'
      }, auth);
      updateJobProgress(jobId, 'rest_permalinks_updated', 'Permalink structure configured via REST API');
    } catch (error) {
      updateJobProgress(jobId, 'rest_permalinks_warning', `Permalink update warning: ${error.message}`);
    }
    
    // Get admin user ID to update password
    try {
      const users = await wpApiCall(fullDomain, '/wp/v2/users?search=' + encodeURIComponent(WP_ADMIN_USER), 'GET', null, auth);
      
      if (users && users.length > 0) {
        const adminUserId = users[0].id;
        
        // Update admin password
        await wpApiCall(fullDomain, `/wp/v2/users/${adminUserId}`, 'POST', {
          password: wpAdminPassword
        }, auth);
        updateJobProgress(jobId, 'rest_password_updated', 'Admin password updated via REST API');
      } else {
        updateJobProgress(jobId, 'rest_password_warning', 'Admin user not found for password update');
      }
    } catch (error) {
      updateJobProgress(jobId, 'rest_password_warning', `Password update warning: ${error.message}`);
    }
    
    // Step 7: Verify site is accessible
    updateJobProgress(jobId, 'verify_start', `Verifying site at http://${fullDomain}...`);
    await sleep(5000);
    
    let siteAccessible = false;
    try {
      const siteCheck = await fetch(`http://${fullDomain}`, { 
        timeout: 10000,
        headers: { 'User-Agent': 'WP-Instance-Creator/2.0' }
      });
      
      if (siteCheck.ok) {
        updateJobProgress(jobId, 'verify_success', '✓ Site is accessible (HTTP)');
        siteAccessible = true;
      } else {
        updateJobProgress(jobId, 'verify_warning', `⚠ Site returned status ${siteCheck.status}`);
      }
    } catch (error) {
      updateJobProgress(jobId, 'verify_warning', `⚠ Site check failed: ${error.message}`);
    }
    
    // Complete job
    completeJob(jobId, {
      domain: fullDomain,
      dropletId: newDropletId,
      dropletIp,
      snapshotId: snapshot.id,
      wpAdminUrl: `http://${fullDomain}/wp-admin`,
      wpAdminUser: WP_ADMIN_USER,
      siteAccessible,
      configMethod: 'REST API',
      sslStatus: 'pending',
      sslNote: 'SSL certificate not installed yet. Wait 5-10 minutes for DNS propagation, then use /api/install-ssl endpoint.'
    });
    
  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);
    updateJobProgress(jobId, 'error', `ERROR: ${error.message}`, 'failed');
    failJob(jobId, error.message);
  }
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
  
  if (password !== FORM_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Invalid password' });
  }
  
  if (!subdomain || !wpAdminPassword) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }
  
  if (!/^[a-z0-9-]+$/.test(subdomain)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid subdomain format. Use only lowercase letters, numbers, and hyphens.' 
    });
  }
  
  const jobId = uuidv4();
  const job = createJob(jobId, subdomain);
  job.metadata = { subdomain, wpAdminPassword };
  jobs.set(jobId, job);
  
  processJob(jobId).catch(err => {
    console.error(`Background job ${jobId} error:`, err);
  });
  
  res.json({
    success: true,
    jobId,
    message: 'Instance creation started (using REST API configuration)',
    statusUrl: `/api/status/${jobId}`
  });
});

// Status endpoint
app.get('/api/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({
      success: false,
      message: 'Job not found'
    });
  }
  
  res.json({
    success: true,
    job: {
      id: job.id,
      subdomain: job.subdomain,
      status: job.status,
      progress: job.progress,
      result: job.result,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    }
  });
});

// List all jobs
app.get('/api/jobs', (req, res) => {
  const jobList = Array.from(jobs.values()).map(job => ({
    id: job.id,
    subdomain: job.subdomain,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  }));
  
  res.json({
    success: true,
    count: jobList.length,
    jobs: jobList
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    version: '2.0-restapi',
    timestamp: new Date().toISOString(),
    config: {
      hasDoToken: !!DO_API_TOKEN,
      hasFormPassword: !!FORM_PASSWORD,
      hasSshKey: !!SSH_PRIVATE_KEY
    },
    stats: {
      totalJobs: jobs.size,
      pending: Array.from(jobs.values()).filter(j => j.status === 'pending').length,
      processing: Array.from(jobs.values()).filter(j => j.status === 'processing').length,
      completed: Array.from(jobs.values()).filter(j => j.status === 'completed').length,
      failed: Array.from(jobs.values()).filter(j => j.status === 'failed').length
    }
  });
});

// SSL installation endpoint (still uses certbot via minimal SSH)
app.post('/api/install-ssl', async (req, res) => {
  const { jobId, password } = req.body;
  
  if (password !== FORM_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Invalid password' });
  }
  
  const job = jobs.get(jobId);
  if (!job) {
    return res.status(404).json({ success: false, message: 'Job not found' });
  }
  
  if (job.status !== 'completed') {
    return res.status(400).json({ 
      success: false, 
      message: 'Job must be completed before installing SSL' 
    });
  }
  
  const { domain, dropletIp } = job.result;
  
  if (!dropletIp) {
    return res.status(400).json({ 
      success: false, 
      message: 'No droplet IP found in job result' 
    });
  }
  
  try {
    updateJobProgress(jobId, 'ssl_start', 'Installing SSL certificate...');
    
    // Check DNS propagation
    const dns = require('dns').promises;
    let dnsResolved = false;
    try {
      const addresses = await dns.resolve4(domain);
      dnsResolved = addresses.includes(dropletIp);
      if (!dnsResolved) {
        return res.status(400).json({
          success: false,
          message: `DNS not yet propagated. Domain resolves to ${addresses.join(', ')} but expected ${dropletIp}. Please wait and try again.`
        });
      }
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: `DNS lookup failed: ${error.message}. Domain may not be propagated yet.`
      });
    }
    
    updateJobProgress(jobId, 'ssl_dns_ok', '✓ DNS propagation verified');
    
    // Install SSL via SSH (certbot) - minimal SSH use
    const sslCommands = [
      `certbot --nginx -d ${domain} --non-interactive --agree-tos --email clients@sheragency.com --redirect`,
      `systemctl restart nginx`
    ];
    
    const conn = new Client();
    
    await new Promise((resolve, reject) => {
      conn.on('ready', () => {
        let cmdIndex = 0;
        
        const executeNext = () => {
          if (cmdIndex >= sslCommands.length) {
            conn.end();
            resolve();
            return;
          }
          
          const cmd = sslCommands[cmdIndex];
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
              if (code !== 0) {
                conn.end();
                reject(new Error(`Command failed: ${stderr}`));
                return;
              }
              cmdIndex++;
              executeNext();
            });
          });
        };
        
        executeNext();
      });
      
      conn.on('error', reject);
      
      conn.connect({
        host: dropletIp,
        port: 22,
        username: 'root',
        privateKey: SSH_PRIVATE_KEY,
        readyTimeout: 50000
      });
    });
    
    // Update site URLs to HTTPS via REST API
    const appPassword = Buffer.from(`${job.subdomain}-${Date.now()}`).toString('base64').substring(0, 24);
    const auth = {
      username: WP_ADMIN_USER,
      password: appPassword
    };
    
    try {
      await wpApiCall(domain, '/wp/v2/settings', 'POST', {
        url: `https://${domain}`
      }, auth);
    } catch (error) {
      console.warn('Failed to update URL to HTTPS via REST API:', error.message);
    }
    
    updateJobProgress(jobId, 'ssl_complete', '✓ SSL certificate installed successfully');
    job.result.sslStatus = 'installed';
    job.result.wpAdminUrl = `https://${domain}/wp-admin`;
    job.result.sslNote = 'SSL certificate installed via Let\'s Encrypt';
    
    res.json({
      success: true,
      message: 'SSL certificate installed successfully',
      wpAdminUrl: `https://${domain}/wp-admin`
    });
    
  } catch (error) {
    updateJobProgress(jobId, 'ssl_error', `✗ SSL installation error: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'SSL installation failed',
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`WP Instance Creator v2.0 (REST API) running on port ${PORT}`);
  console.log(`Environment check:`);
  console.log(`  - DO API Token: ${DO_API_TOKEN ? '✓' : '✗'}`);
  console.log(`  - Form Password: ${FORM_PASSWORD ? '✓' : '✗'}`);
  console.log(`  - SSH Key: ${SSH_PRIVATE_KEY ? '✓' : '✗'}`);
  console.log(`Configuration method: WordPress REST API (minimal SSH)`);
});
