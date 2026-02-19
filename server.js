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

const TEMPLATE_SNAPSHOT_ID = '217711524'; // Wildcard SSL snapshot (*.sherstaging.com)
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

// Background job processor
async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  
  try {
    job.status = 'processing';
    const { subdomain } = job.metadata;
    const fullDomain = `${subdomain}.${DOMAIN}`;
    
    // Step 1: Use pre-made wildcard SSL snapshot (no need to create new snapshot each time)
    updateJobProgress(jobId, 'snapshot_ready', `Using template snapshot with wildcard SSL (ID: ${TEMPLATE_SNAPSHOT_ID})`);
    
    // Step 2: Create new droplet from template snapshot
    updateJobProgress(jobId, 'droplet_start', 'Creating new droplet from snapshot...');
    const dropletName = `wp-${subdomain}`;
    
    const dropletResponse = await doApiCall('/droplets', 'POST', {
      name: dropletName,
      region: 'nyc3',
      size: 's-1vcpu-2gb',
      image: parseInt(TEMPLATE_SNAPSHOT_ID),
      backups: false,
      ipv6: false,
      monitoring: true
    });
    
    const newDropletId = dropletResponse.droplet.id;
    updateJobProgress(jobId, 'droplet_created', `Droplet created (ID: ${newDropletId})`);
    
    // Wait for droplet to be active
    updateJobProgress(jobId, 'droplet_waiting', 'Waiting for droplet to become active...');
    let dropletActive = false;
    const maxAttempts = 60; // 10 minutes max (60 attempts * 10 seconds)
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
    
    // Step 4: Wait for DNS propagation and site to be accessible
    updateJobProgress(jobId, 'dns_propagation', 'Waiting for DNS propagation...');
    await sleep(30000); // Wait 30 seconds for DNS to propagate
    updateJobProgress(jobId, 'dns_propagated', 'DNS propagation complete');
    
    // Step 5: Verify site is accessible
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
    
    // Complete job
    completeJob(jobId, {
      domain: fullDomain,
      dropletId: newDropletId,
      dropletIp,
      templateSnapshotId: TEMPLATE_SNAPSHOT_ID,
      wpAdminUrl: `https://${fullDomain}/wp-admin`,
      httpUrl: `http://${fullDomain}`,
      wpAdminUser: 'clients@sheragency.com',
      siteAccessible,
      configNote: 'Site configuration can be completed manually via wp-admin',
      sslStatus: 'pre-installed',
      sslNote: 'Wildcard SSL certificate (*.sherstaging.com) is pre-installed. HTTPS should work immediately after DNS propagates.'
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
  const { subdomain, password } = req.body;
  
  if (password !== FORM_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Invalid password' });
  }
  
  if (!subdomain) {
    return res.status(400).json({ success: false, message: 'Missing required field: subdomain' });
  }
  
  if (!/^[a-z0-9-]+$/.test(subdomain)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid subdomain format. Use only lowercase letters, numbers, and hyphens.' 
    });
  }
  
  const jobId = uuidv4();
  const job = createJob(jobId, subdomain);
  job.metadata = { subdomain };
  jobs.set(jobId, job);
  
  processJob(jobId).catch(err => {
    console.error(`Background job ${jobId} error:`, err);
  });
  
  res.json({
    success: true,
    jobId,
    message: 'Instance creation started (manual configuration required after completion)',
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

app.post('/api/install-ssl', async (req, res) => {
  const { jobId, password } = req.body;
  
  if (password !== FORM_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Invalid password' });
  }
  
  if (!jobId) {
    return res.status(400).json({ success: false, message: 'Missing jobId' });
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
  
  if (!job.result || !job.result.dropletId || !job.result.domain) {
    return res.status(400).json({ 
      success: false, 
      message: 'Job result missing required data (dropletId, domain)' 
    });
  }
  
  try {
    const { dropletId, domain } = job.result;
    const fullDomain = domain;
    
    console.log(`[SSL Install] Starting SSL installation for ${fullDomain} (Droplet: ${dropletId})`);
    
    // Step 1: Get droplet IP
    const dropletData = await doApiCall(`/droplets/${dropletId}`);
    const dropletIp = dropletData.droplet.networks.v4.find(n => n.type === 'public')?.ip_address;
    
    if (!dropletIp) {
      throw new Error('Could not find droplet IP address');
    }
    
    console.log(`[SSL Install] Droplet IP: ${dropletIp}`);
    
    // Step 2: Verify DNS has propagated
    console.log(`[SSL Install] Checking DNS propagation for ${fullDomain}...`);
    
    let dnsResolved = false;
    let attempts = 0;
    const maxDnsAttempts = 3;
    
    while (!dnsResolved && attempts < maxDnsAttempts) {
      try {
        const dnsCheck = await fetch(`http://${fullDomain}`, { 
          timeout: 10000,
          headers: { 'User-Agent': 'WP-Instance-Creator-SSL/2.0' }
        });
        
        if (dnsCheck.ok || dnsCheck.status === 301 || dnsCheck.status === 302) {
          dnsResolved = true;
          console.log(`[SSL Install] DNS resolved successfully`);
        }
      } catch (error) {
        console.log(`[SSL Install] DNS check attempt ${attempts + 1} failed: ${error.message}`);
      }
      
      if (!dnsResolved) {
        await sleep(3000);
        attempts++;
      }
    }
    
    if (!dnsResolved) {
      return res.json({
        success: false,
        message: 'DNS has not fully propagated yet',
        error: 'The domain does not resolve to the droplet IP. Wait 10-15 minutes and try again.',
        retryable: true
      });
    }
    
    // Step 3: Run certbot via SSH (we need SSH key for SSL installation)
    // For now, return success with manual instructions since we don't have SSH access
    // In production, you would SSH to the droplet and run: certbot --nginx -d ${fullDomain} --non-interactive --agree-tos -m admin@sheragency.com
    
    console.log(`[SSL Install] SSL installation requires manual setup or SSH automation`);
    
    // Update job result to indicate SSL is ready to be installed manually
    job.result.sslStatus = 'manual_setup_required';
    job.result.sslNote = `DNS propagated. To install SSL:\n\nSSH to droplet:\nssh root@${dropletIp}\n\nRun certbot:\ncertbot --nginx -d ${fullDomain} --non-interactive --agree-tos -m admin@sheragency.com`;
    job.result.sslInstructions = {
      step1: `SSH to droplet: ssh root@${dropletIp}`,
      step2: `Run certbot: certbot --nginx -d ${fullDomain} --non-interactive --agree-tos -m admin@sheragency.com`,
      step3: `Site will be accessible via HTTPS after certbot completes`
    };
    
    return res.json({
      success: false,
      message: 'SSL installation requires manual setup (no SSH key configured)',
      error: `DNS is ready. Please SSH to ${dropletIp} and run:\ncertbot --nginx -d ${fullDomain} --non-interactive --agree-tos -m admin@sheragency.com`,
      wpAdminUrl: `https://${fullDomain}/wp-admin`,
      manualSetup: true,
      sslInstructions: job.result.sslInstructions
    });
    
  } catch (error) {
    console.error(`[SSL Install] Error:`, error);
    return res.status(500).json({
      success: false,
      message: 'SSL installation failed',
      error: error.message
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    version: '3.2.2-password-field-removal',
    timestamp: new Date().toISOString(),
    config: {
      hasDoToken: !!DO_API_TOKEN,
      hasFormPassword: !!FORM_PASSWORD,
      templateSnapshotId: TEMPLATE_SNAPSHOT_ID
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
  console.log(`WP Instance Creator v3.2.2-password-field-removal running on port ${PORT}`);
  console.log(`Configuration method: Manual via wp-admin (no automated config)`);
  console.log(`Template snapshot: ${TEMPLATE_SNAPSHOT_ID} (with wildcard SSL pre-installed)`);
  console.log(`Environment check:`);
  console.log(`  - DO API Token: ${DO_API_TOKEN ? '✓' : '✗'}`);
  console.log(`  - Form Password: ${FORM_PASSWORD ? '✓' : '✗'}`);
  console.log(`\nNote: Sites are created with wildcard SSL (*.sherstaging.com) pre-installed.`);
  console.log(`HTTPS will work automatically after DNS propagation.`);
  console.log(`Password management: Template password inherited, managed via 1Password.`);
});
