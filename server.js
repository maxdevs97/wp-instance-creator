const express = require('express');
const fetch = require('node-fetch');
const { Client } = require('ssh2');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
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

// In-memory job queue
const jobs = new Map();

// Job status structure
function createJob(jobId, subdomain) {
  return {
    id: jobId,
    subdomain,
    status: 'pending', // pending, processing, completed, failed
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

// SSH command executor with retry logic
async function sshExecute(host, commands, maxRetries = 5, retryDelay = 10000) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`SSH attempt ${attempt}/${maxRetries} to ${host}`);
      
      return await new Promise((resolve, reject) => {
        const conn = new Client();
        const results = [];
        let connectionTimeout;
        
        // Set a 60-second connection timeout
        connectionTimeout = setTimeout(() => {
          conn.end();
          reject(new Error('SSH connection timeout after 60 seconds'));
        }, 60000);
        
        conn.on('ready', () => {
          clearTimeout(connectionTimeout);
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
          clearTimeout(connectionTimeout);
          reject(err);
        });
        
        conn.on('timeout', () => {
          clearTimeout(connectionTimeout);
          conn.end();
          reject(new Error('SSH connection timeout'));
        });
        
        conn.connect({
          host,
          port: 22,
          username: 'root',
          privateKey: SSH_PRIVATE_KEY,
          readyTimeout: 50000, // 50 seconds for ready event
          timeout: 60000 // 60 seconds overall timeout
        });
      });
      
    } catch (error) {
      lastError = error;
      console.error(`SSH attempt ${attempt} failed:`, error.message);
      
      if (attempt < maxRetries) {
        console.log(`Waiting ${retryDelay/1000}s before retry...`);
        await sleep(retryDelay);
      }
    }
  }
  
  throw new Error(`SSH failed after ${maxRetries} attempts: ${lastError.message}`);
}

// Background job processor
async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  
  try {
    job.status = 'processing';
    const { subdomain, wpAdminPassword } = job.metadata;
    const fullDomain = `${subdomain}.${DOMAIN}`;
    
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
    updateJobProgress(jobId, 'snapshot_waiting', 'Waiting for snapshot to complete (this may take 3-5 minutes)...');
    let snapshotComplete = false;
    let attempts = 0;
    const maxAttempts = 60; // 10 minutes max
    
    while (!snapshotComplete && attempts < maxAttempts) {
      await sleep(10000); // Wait 10 seconds
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
      ssh_keys: [54026256], // forge-key - required for SSH access
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
      await sleep(10000); // Wait 10 seconds
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
    
    // Step 4: Wait for SSH to be ready (extended wait)
    updateJobProgress(jobId, 'ssh_wait', 'Waiting for SSH to be ready (60 seconds for cloud-init)...');
    await sleep(60000); // Wait 60 seconds for droplet to fully boot and cloud-init to complete
    
    // Step 5: SSH into droplet and configure with retry logic
    updateJobProgress(jobId, 'ssh_connect', 'Connecting via SSH to configure WordPress (will retry if needed)...');
    
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
    
    const sshResults = await sshExecute(dropletIp, sshCommands, 5, 10000);
    updateJobProgress(jobId, 'ssh_complete', 'WordPress configuration completed via SSH');
    
    // Check for any command failures
    const failedCommands = sshResults.filter(r => r.code !== 0);
    if (failedCommands.length > 0) {
      updateJobProgress(jobId, 'ssh_warnings', `Warning: ${failedCommands.length} command(s) had non-zero exit codes`);
    }
    
    // Step 6: Verify site is accessible
    updateJobProgress(jobId, 'verify_start', `Testing site accessibility at https://${fullDomain}...`);
    await sleep(5000); // Brief wait for nginx restart
    
    let siteAccessible = false;
    try {
      const siteCheck = await fetch(`https://${fullDomain}`, { 
        timeout: 10000,
        headers: { 'User-Agent': 'WP-Instance-Creator/1.0' }
      });
      
      if (siteCheck.ok) {
        updateJobProgress(jobId, 'verify_success', '✓ Site is accessible with SSL');
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
      wpAdminUrl: `https://${fullDomain}/wp-admin`,
      wpAdminUser: 'clients@sheragency.com',
      siteAccessible
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

// Main endpoint: Create WordPress instance (now returns immediately with job ID)
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
  
  // Create job
  const jobId = uuidv4();
  const job = createJob(jobId, subdomain);
  job.metadata = { subdomain, wpAdminPassword };
  jobs.set(jobId, job);
  
  // Start processing in background
  processJob(jobId).catch(err => {
    console.error(`Background job ${jobId} error:`, err);
  });
  
  // Return immediately with job ID
  res.json({
    success: true,
    jobId,
    message: 'Instance creation started',
    statusUrl: `/api/status/${jobId}`
  });
});

// Status endpoint: Get job status
app.get('/api/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({
      success: false,
      message: 'Job not found'
    });
  }
  
  // Return job status without sensitive metadata
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

// List all jobs (for debugging)
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

app.listen(PORT, () => {
  console.log(`WP Instance Creator running on port ${PORT}`);
  console.log(`Environment check:`);
  console.log(`  - DO API Token: ${DO_API_TOKEN ? '✓' : '✗'}`);
  console.log(`  - Form Password: ${FORM_PASSWORD ? '✓' : '✗'}`);
  console.log(`  - SSH Key: ${SSH_PRIVATE_KEY ? '✓' : '✗'}`);
});
