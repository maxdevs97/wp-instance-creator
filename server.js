const express = require('express');
const fetch = require('node-fetch');
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

// WordPress REST API credentials (pre-configured in template droplet)
const WP_ADMIN_USER = process.env.WP_ADMIN_USER || 'clients@sheragency.com';
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD; // Application Password from template

const TEMPLATE_DROPLET_ID = '552784281';
const DOMAIN = 'sherstaging.com';

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

// WordPress REST API helper with Application Password authentication
async function wpApiCall(domain, endpoint, method = 'GET', body = null, maxRetries = 5) {
  const url = `http://${domain}/wp-json${endpoint}`;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const options = {
        method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'WP-Instance-Creator/2.0',
          'Authorization': `Basic ${Buffer.from(`${WP_ADMIN_USER}:${WP_APP_PASSWORD}`).toString('base64')}`
        },
        timeout: 30000
      };
      
      if (body) {
        options.body = JSON.stringify(body);
      }
      
      console.log(`WP API ${method} ${endpoint} (attempt ${attempt}/${maxRetries})`);
      const response = await fetch(url, options);
      
      if (!response.ok) {
        const text = await response.text();
        let errorMsg = `HTTP ${response.status}`;
        try {
          const data = JSON.parse(text);
          errorMsg = data.message || errorMsg;
        } catch (e) {
          errorMsg = text.substring(0, 200);
        }
        throw new Error(`WP API error: ${errorMsg}`);
      }
      
      const data = await response.json();
      return data;
      
    } catch (error) {
      console.error(`WP API attempt ${attempt} failed:`, error.message);
      if (attempt < maxRetries) {
        await sleep(10000); // Wait 10 seconds before retry
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
  
  console.log(`Waiting for WordPress at http://${domain} (max ${maxWaitSeconds}s)...`);
  
  while ((Date.now() - startTime) / 1000 < maxWaitSeconds) {
    try {
      const response = await fetch(`http://${domain}/wp-json/`, {
        timeout: 10000,
        headers: { 'User-Agent': 'WP-Instance-Creator/2.0' }
      });
      
      if (response.ok) {
        console.log(`✓ WordPress REST API is accessible at http://${domain}/wp-json/`);
        return true;
      }
      
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    
    await sleep(10000); // Check every 10 seconds
  }
  
  throw new Error(`WordPress not accessible after ${maxWaitSeconds}s. Last error: ${lastError}`);
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
      size: 's-1vcpu-2gb',
      image: snapshot.id,
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
    
    // Step 4: Wait for WordPress to be accessible (with REST API check)
    updateJobProgress(jobId, 'wp_wait', 'Waiting for WordPress and REST API to be accessible...');
    await sleep(60000); // Initial wait for boot and services to start
    await waitForWordPress(fullDomain, 180); // Wait up to 3 more minutes
    updateJobProgress(jobId, 'wp_ready', 'WordPress REST API is accessible');
    
    // Step 5: Configure WordPress via REST API (NO SSH!)
    updateJobProgress(jobId, 'rest_config_start', 'Configuring WordPress via REST API...');
    
    // Update site URL
    try {
      await wpApiCall(fullDomain, '/wp/v2/settings', 'POST', {
        title: `${subdomain} - Sher Agency`,
        url: `http://${fullDomain}`
      });
      updateJobProgress(jobId, 'rest_url_updated', '✓ Site URL configured via REST API');
    } catch (error) {
      updateJobProgress(jobId, 'rest_url_error', `✗ Site URL update failed: ${error.message}`);
      throw error; // This is critical, fail the job
    }
    
    // Update permalink structure
    try {
      await wpApiCall(fullDomain, '/wp/v2/settings', 'POST', {
        permalink_structure: '/%postname%/'
      });
      updateJobProgress(jobId, 'rest_permalinks_updated', '✓ Permalink structure configured via REST API');
    } catch (error) {
      updateJobProgress(jobId, 'rest_permalinks_warning', `⚠ Permalink update failed: ${error.message}`);
    }
    
    // Get admin user and update password
    try {
      const users = await wpApiCall(fullDomain, `/wp/v2/users?search=${encodeURIComponent(WP_ADMIN_USER)}`, 'GET');
      
      if (users && users.length > 0) {
        const adminUserId = users[0].id;
        
        await wpApiCall(fullDomain, `/wp/v2/users/${adminUserId}`, 'POST', {
          password: wpAdminPassword
        });
        updateJobProgress(jobId, 'rest_password_updated', '✓ Admin password updated via REST API');
      } else {
        updateJobProgress(jobId, 'rest_password_warning', '⚠ Admin user not found for password update');
      }
    } catch (error) {
      updateJobProgress(jobId, 'rest_password_warning', `⚠ Password update failed: ${error.message}`);
    }
    
    // Step 6: Verify site is accessible
    updateJobProgress(jobId, 'verify_start', `Verifying site at http://${fullDomain}...`);
    await sleep(5000);
    
    let siteAccessible = false;
    try {
      const siteCheck = await fetch(`http://${fullDomain}`, { 
        timeout: 10000,
        headers: { 'User-Agent': 'WP-Instance-Creator/2.0' }
      });
      
      if (siteCheck.ok) {
        updateJobProgress(jobId, 'verify_success', '✓ Site is accessible');
        siteAccessible = true;
      } else {
        updateJobProgress(jobId, 'verify_warning', `⚠ Site returned HTTP ${siteCheck.status}`);
      }
    } catch (error) {
      updateJobProgress(jobId, 'verify_warning', `⚠ Site check failed: ${error.message}`);
    }
    
    // Step 7: Test REST API access
    try {
      const apiTest = await wpApiCall(fullDomain, '/wp/v2/settings', 'GET');
      updateJobProgress(jobId, 'api_test_success', '✓ REST API authentication verified');
    } catch (error) {
      updateJobProgress(jobId, 'api_test_warning', `⚠ REST API test failed: ${error.message}`);
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
      configMethod: 'REST API (no SSH)',
      sslStatus: 'pending',
      sslNote: 'SSL certificate not installed. Wait 5-10 minutes for DNS propagation, then use /api/install-ssl endpoint.'
    });
    
  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);
    updateJobProgress(jobId, 'error', `ERROR: ${error.message}`, 'failed');
    failJob(jobId, error.message);
  }
}

// API Routes

app.post('/api/verify-password', (req, res) => {
  const { password } = req.body;
  
  if (password === FORM_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Invalid password' });
  }
});

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
    message: 'Instance creation started (REST API configuration - no SSH required)',
    statusUrl: `/api/status/${jobId}`
  });
});

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

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    version: '2.0-restapi-no-ssh',
    timestamp: new Date().toISOString(),
    config: {
      hasDoToken: !!DO_API_TOKEN,
      hasFormPassword: !!FORM_PASSWORD,
      hasWpAppPassword: !!WP_APP_PASSWORD
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

// Note: SSL installation removed - would require implementing certbot via REST API
// or using a different SSL solution (e.g., Cloudflare, Let's Encrypt DNS challenge)

app.listen(PORT, () => {
  console.log(`WP Instance Creator v2.0 (Pure REST API) running on port ${PORT}`);
  console.log(`Configuration method: WordPress REST API only (zero SSH)`);
  console.log(`Environment check:`);
  console.log(`  - DO API Token: ${DO_API_TOKEN ? '✓' : '✗'}`);
  console.log(`  - Form Password: ${FORM_PASSWORD ? '✓' : '✗'}`);
  console.log(`  - WP App Password: ${WP_APP_PASSWORD ? '✓' : '✗'}`);
  
  if (!WP_APP_PASSWORD) {
    console.warn('\n⚠ WARNING: WP_APP_PASSWORD not set!');
    console.warn('You must configure an Application Password in the template droplet.');
    console.warn('Run this on the template:');
    console.warn(`  wp user application-password create ${WP_ADMIN_USER} "WP-Instance-Creator" --path=/var/www/html`);
  }
});
