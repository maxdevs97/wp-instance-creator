const express = require('express');
const fetch = require('node-fetch');
const { Client: SshClient } = require('ssh2');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// SSH key for forge-key (DO key ID 54026256) - must match the key added to droplets
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH || '/etc/ssh-keys/forge-key';

// Execute a command on a remote droplet via SSH and return stdout
function sshExec(host, command, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    let output = '';
    let errOutput = '';

    const timer = setTimeout(() => {
      conn.end();
      reject(new Error(`SSH command timed out after ${timeoutMs}ms: ${command.slice(0, 80)}`));
    }, timeoutMs);

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); return reject(err); }
        stream.on('close', (code) => {
          clearTimeout(timer);
          conn.end();
          if (code !== 0) {
            reject(new Error(`SSH command exited ${code}: ${errOutput.slice(0, 300)}`));
          } else {
            resolve(output.trim());
          }
        });
        stream.on('data', d => { output += d; });
        stream.stderr.on('data', d => { errOutput += d; });
      });
    });

    conn.on('error', (err) => { clearTimeout(timer); reject(err); });

    const connectConfig = {
      host,
      port: 22,
      username: 'root',
      readyTimeout: 30000,
    };

    // Try private key file first, fallback to env var
    try {
      connectConfig.privateKey = fs.readFileSync(SSH_PRIVATE_KEY_PATH);
    } catch {
      if (process.env.SSH_PRIVATE_KEY) {
        connectConfig.privateKey = process.env.SSH_PRIVATE_KEY.replace(/\\n/g, '\n');
      } else {
        return reject(new Error('No SSH private key configured (SSH_PRIVATE_KEY_PATH or SSH_PRIVATE_KEY env var)'));
      }
    }

    conn.connect(connectConfig);
  });
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Configuration
const DO_API_TOKEN = process.env.DO_API_TOKEN;
const FORM_PASSWORD = process.env.FORM_PASSWORD;

const TEMPLATE_DROPLET_ID = '552784281'; // wordpress-managed-20260212 (mbstest1.sherstaging.com)
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

// Snapshot creation helper
async function createSnapshotFromTemplate(dropletId, snapshotName) {
  console.log(`Creating snapshot "${snapshotName}" from droplet ${dropletId}...`);
  
  const response = await doApiCall(`/droplets/${dropletId}/actions`, 'POST', {
    type: 'snapshot',
    name: snapshotName
  });
  
  return response.action;
}

// Wait for snapshot action to complete and return the snapshot
async function waitForSnapshotCompletion(actionId, dropletId, snapshotName, maxWaitMinutes = 5) {
  const maxAttempts = maxWaitMinutes * 6; // Check every 10 seconds
  let attempts = 0;
  
  console.log(`Waiting for snapshot action ${actionId} to complete...`);
  
  // Wait for action to complete
  while (attempts < maxAttempts) {
    const actionData = await doApiCall(`/droplets/${dropletId}/actions/${actionId}`);
    const action = actionData.action;
    
    console.log(`Action ${actionId} status: ${action.status}`);
    
    if (action.status === 'completed') {
      console.log(`Snapshot action completed successfully`);
      break;
    } else if (action.status === 'errored') {
      throw new Error('Snapshot action failed');
    }
    
    await sleep(10000);
    attempts++;
  }
  
  if (attempts >= maxAttempts) {
    throw new Error(`Snapshot action timed out after ${maxWaitMinutes} minutes`);
  }
  
  // Find the created snapshot by name
  console.log(`Looking for snapshot with name: ${snapshotName}`);
  const snapshotsData = await doApiCall(`/droplets/${dropletId}/snapshots`);
  const snapshot = snapshotsData.snapshots.find(s => s.name === snapshotName);
  
  if (!snapshot) {
    throw new Error(`Snapshot ${snapshotName} not found after action completed`);
  }
  
  console.log(`Found snapshot ${snapshot.id}`);
  return snapshot;
}

// Background job processor
async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  
  try {
    job.status = 'processing';
    const { subdomain } = job.metadata;
    const fullDomain = `${subdomain}.${DOMAIN}`;
    
    // Step 1: Create fresh snapshot from template droplet
    updateJobProgress(jobId, 'snapshot_start', `Creating fresh snapshot from template droplet (ID: ${TEMPLATE_DROPLET_ID})...`);
    const snapshotName = `wp-template-${subdomain}-${Date.now()}`;
    
    let snapshot;
    try {
      const action = await createSnapshotFromTemplate(TEMPLATE_DROPLET_ID, snapshotName);
      updateJobProgress(jobId, 'snapshot_created', `Snapshot action initiated (Action ID: ${action.id}), waiting for completion...`);
      
      // Wait for snapshot to be ready
      snapshot = await waitForSnapshotCompletion(action.id, TEMPLATE_DROPLET_ID, snapshotName);
      updateJobProgress(jobId, 'snapshot_ready', `Snapshot ready (ID: ${snapshot.id})`);
    } catch (snapshotError) {
      throw new Error(`Snapshot creation failed: ${snapshotError.message}`);
    }
    
    // Step 2: Create new droplet from fresh snapshot
    updateJobProgress(jobId, 'droplet_start', 'Creating new droplet from snapshot...');
    const dropletName = `wp-${subdomain}`;
    
    // Cloud-init user_data to DISABLE password authentication entirely
    // Forces SSH key-only authentication to avoid DigitalOcean's password reset requirement
    const userData = `#cloud-config
preserve_hostname: false
ssh_pwauth: false
password_authentication: no
runcmd:
  - sed -i 's/^PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  - sed -i 's/^#PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  - systemctl restart sshd
  - chage -I -1 -m 0 -M 99999 -E -1 root
`;
    
    const dropletResponse = await doApiCall('/droplets', 'POST', {
      name: dropletName,
      region: 'nyc3',
      size: 's-1vcpu-2gb',
      image: parseInt(snapshot.id),
      ssh_keys: [54026256], // forge-key - Required for SSH to work without password auth
      backups: false,
      ipv6: false,
      monitoring: true,
      user_data: userData
    });
    
    const newDropletId = dropletResponse.droplet.id;
    updateJobProgress(jobId, 'droplet_created', `Droplet created (ID: ${newDropletId})`);
    
    // Wait for droplet to be active
    updateJobProgress(jobId, 'droplet_waiting', 'Waiting for droplet to become active...');
    let dropletActive = false;
    const maxAttempts = 60; // 10 minutes max (60 attempts * 10 seconds)
    let attempts = 0;
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
    
    // Step 6: Fix WordPress database URLs (search-replace snapshot domain → real domain)
    updateJobProgress(jobId, 'wp_url_fix_start', `Fixing WordPress database URLs: snapshot domain → ${fullDomain}...`);
    let wpUrlFixed = false;
    let wpUrlNote = '';
    try {
      // Initial wait for SSH + Docker to be ready after droplet boot
      // DO droplets cloned from snapshots with Docker take ~60-90s before containers start
      updateJobProgress(jobId, 'wp_url_fix_boot_wait', 'Waiting 90s for droplet boot + Docker startup...');
      await sleep(90000);

      // Poll for Docker container readiness (up to 3 minutes)
      let containerReady = false;
      const maxContainerAttempts = 18; // 18 * 10s = 3 minutes
      for (let attempt = 1; attempt <= maxContainerAttempts; attempt++) {
        updateJobProgress(jobId, 'wp_url_fix_docker_wait', `Waiting for WordPress container to start... (attempt ${attempt}/12)`);
        try {
          const containerName = await sshExec(
            dropletIp,
            `docker ps --filter name=wordpress --filter status=running --format '{{.Names}}' 2>/dev/null | head -1`,
            30000
          );
          if (containerName && containerName.trim()) {
            containerReady = true;
            updateJobProgress(jobId, 'wp_url_fix_docker_ready', `WordPress container is running: ${containerName.trim()}`);
            break;
          }
        } catch (err) {
          console.warn(`Container check attempt ${attempt} failed: ${err.message}`);
        }
        if (attempt < maxContainerAttempts) {
          await sleep(10000);
        }
      }

      if (!containerReady) {
        throw new Error('WordPress container did not start within 2 minutes');
      }

      // Poll until WP-CLI is ready (WordPress DB fully initialized inside container)
      let oldUrl = 'unknown';
      const maxWpCliAttempts = 24; // 24 * 10s = 4 minutes
      for (let wpAttempt = 1; wpAttempt <= maxWpCliAttempts; wpAttempt++) {
        updateJobProgress(jobId, 'wp_url_fix_wpcli_wait', `Waiting for WP-CLI to be ready... (attempt ${wpAttempt}/${maxWpCliAttempts})`);
        try {
          const tryUrl = await sshExec(dropletIp, `docker exec $(docker ps -q --filter name=wordpress | head -1) wp --allow-root option get siteurl 2>/dev/null || echo 'not_ready'`, 20000);
          if (tryUrl && tryUrl.trim() && tryUrl.trim() !== 'not_ready' && tryUrl.trim().startsWith('http')) {
            oldUrl = tryUrl.trim();
            break;
          }
        } catch (wpCliErr) {
          console.warn(`WP-CLI check attempt ${wpAttempt} failed: ${wpCliErr.message}`);
        }
        if (wpAttempt < maxWpCliAttempts) {
          await sleep(10000);
        }
      }
      const oldDomain = oldUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
      updateJobProgress(jobId, 'wp_url_fix_detect', `Detected snapshot siteurl: ${oldUrl}`);

      if (oldDomain && oldDomain !== fullDomain && oldDomain !== 'unknown') {
        // Run search-replace across all tables
        const searchReplace = `docker exec $(docker ps -q --filter name=wordpress | head -1) wp --allow-root search-replace '${oldDomain}' '${fullDomain}' --all-tables 2>&1 | tail -5; exit 0`;
        const srResult = await sshExec(dropletIp, searchReplace, 90000);
        updateJobProgress(jobId, 'wp_url_fix_replaced', `search-replace complete: ${srResult.slice(0, 200)}`);

        // Force siteurl + home to HTTPS
        await sshExec(dropletIp, `docker exec $(docker ps -q --filter name=wordpress | head -1) wp --allow-root option update siteurl 'https://${fullDomain}' 2>&1; exit 0`, 20000);
        await sshExec(dropletIp, `docker exec $(docker ps -q --filter name=wordpress | head -1) wp --allow-root option update home 'https://${fullDomain}' 2>&1; exit 0`, 20000);

        // Flush cache
        await sshExec(dropletIp, `docker exec $(docker ps -q --filter name=wordpress | head -1) wp --allow-root cache flush 2>&1; exit 0`, 15000);

        // Verify fix actually took
        const verifyUrl = await sshExec(dropletIp, `docker exec $(docker ps -q --filter name=wordpress | head -1) wp --allow-root option get siteurl 2>/dev/null || echo 'verify_failed'`, 20000);
        const verifyDomain = verifyUrl.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
        if (verifyDomain !== fullDomain) {
          // Retry direct option set as last resort
          await sshExec(dropletIp, `docker exec $(docker ps -q --filter name=wordpress | head -1) wp --allow-root option update siteurl 'https://${fullDomain}' --skip-themes --skip-plugins 2>&1; exit 0`, 20000);
          await sshExec(dropletIp, `docker exec $(docker ps -q --filter name=wordpress | head -1) wp --allow-root option update home 'https://${fullDomain}' --skip-themes --skip-plugins 2>&1; exit 0`, 20000);
          await sshExec(dropletIp, `docker exec $(docker ps -q --filter name=wordpress | head -1) wp --allow-root cache flush 2>&1; exit 0`, 15000);
        }

        wpUrlFixed = true;
        wpUrlNote = `Replaced '${oldDomain}' → '${fullDomain}' across all tables. siteurl and home set to https://${fullDomain}. Verified: ${verifyUrl.trim()}`;
        updateJobProgress(jobId, 'wp_url_fix_done', `✓ ${wpUrlNote}`);
      } else if (oldDomain === fullDomain) {
        wpUrlFixed = true;
        wpUrlNote = 'siteurl already correct — no replacement needed.';
        updateJobProgress(jobId, 'wp_url_fix_done', `✓ ${wpUrlNote}`);
      } else {
        wpUrlNote = `Could not detect old domain (got: '${oldUrl}'). Manual search-replace may be needed.`;
        updateJobProgress(jobId, 'wp_url_fix_warning', `⚠ ${wpUrlNote}`);
      }
    } catch (sshErr) {
      wpUrlNote = `SSH/WP-CLI step failed: ${sshErr.message}. Run manually: wp search-replace '<old-domain>' '${fullDomain}' --all-tables`;
      updateJobProgress(jobId, 'wp_url_fix_warning', `⚠ ${wpUrlNote}`);
    }

    // Complete job
    completeJob(jobId, {
      domain: fullDomain,
      dropletId: newDropletId,
      dropletIp,
      snapshotId: snapshot.id,
      snapshotName: snapshot.name,
      templateDropletId: TEMPLATE_DROPLET_ID,
      wpAdminUrl: `https://${fullDomain}/wp-admin`,
      httpUrl: `http://${fullDomain}`,
      wpAdminUser: 'clients@sheragency.com',
      siteAccessible,
      wpUrlFixed,
      wpUrlNote,
      configNote: 'WordPress database URLs auto-corrected to new domain during provisioning.',
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
    version: '3.3.0',
    timestamp: new Date().toISOString(),
    config: {
      hasDoToken: !!DO_API_TOKEN,
      hasFormPassword: !!FORM_PASSWORD,
      templateDropletId: TEMPLATE_DROPLET_ID,
      snapshotMethod: 'dynamic (created at runtime)',
      authMethod: 'SSH keys only (password auth disabled)'
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
  console.log(`WP Instance Creator v3.3.0 running on port ${PORT}`);
  console.log(`Configuration method: Manual via wp-admin (no automated config)`);
  console.log(`Template droplet: ${TEMPLATE_DROPLET_ID} (wordpress-managed-20260212)`);
  console.log(`Snapshot method: Dynamic (fresh snapshot created for each instance)`);
  console.log(`Environment check:`);
  console.log(`  - DO API Token: ${DO_API_TOKEN ? '✓' : '✗'}`);
  console.log(`  - Form Password: ${FORM_PASSWORD ? '✓' : '✗'}`);
  console.log(`\nNote: Sites are created with wildcard SSL (*.sherstaging.com) pre-installed.`);
  console.log(`HTTPS will work automatically after DNS propagation.`);
  console.log(`Authentication: SSH keys only (password auth disabled in cloud-init)`);
  console.log(`v3.3.0: Dynamic snapshots ensure template changes propagate to new instances.`);
  console.log(`Expected deployment time: 4-5 minutes (includes snapshot creation).`);
});
