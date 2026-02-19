#!/usr/bin/env node
/**
 * v3.2.5 Diagnosis Script
 * Creates a test droplet with enhanced cloud-init for diagnostics
 */

const fetch = require('node-fetch');

const DO_API_TOKEN = process.env.DO_API_TOKEN;
if (!DO_API_TOKEN) {
  console.error('Error: DO_API_TOKEN environment variable not set');
  process.exit(1);
}
const TEMPLATE_SNAPSHOT_ID = '217727089';

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

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const testName = `wp-diagnosis-${Date.now()}`;
  
  console.log('=== v3.2.5 Diagnosis Test ===\n');
  console.log(`Creating test droplet: ${testName}`);
  
  // Enhanced cloud-init with comprehensive logging
  const userData = `#cloud-config
preserve_hostname: false
runcmd:
  - echo "=== CLOUD-INIT RUNCMD START ===" >> /var/log/password-fix-debug.log
  - date >> /var/log/password-fix-debug.log
  - echo "--- Before chage ---" >> /var/log/password-fix-debug.log
  - chage -l root >> /var/log/password-fix-debug.log 2>&1
  - grep "^root:" /etc/shadow >> /var/log/password-fix-debug.log 2>&1
  - echo "--- Running chage command ---" >> /var/log/password-fix-debug.log
  - chage -I -1 -m 0 -M 99999 -E -1 root >> /var/log/password-fix-debug.log 2>&1
  - echo "Exit code: $?" >> /var/log/password-fix-debug.log
  - echo "--- After chage ---" >> /var/log/password-fix-debug.log
  - chage -l root >> /var/log/password-fix-debug.log 2>&1
  - grep "^root:" /etc/shadow >> /var/log/password-fix-debug.log 2>&1
  - echo "--- Updating login.defs ---" >> /var/log/password-fix-debug.log
  - sed -i 's/^PASS_MAX_DAYS.*/PASS_MAX_DAYS   99999/' /etc/login.defs
  - sed -i 's/^PASS_MIN_DAYS.*/PASS_MIN_DAYS   0/' /etc/login.defs
  - grep -E "^PASS_MAX_DAYS|^PASS_MIN_DAYS" /etc/login.defs >> /var/log/password-fix-debug.log
  - echo "=== CLOUD-INIT RUNCMD COMPLETE ===" >> /var/log/password-fix-debug.log
  - chmod 644 /var/log/password-fix-debug.log
`;

  console.log('\n--- Cloud-init user_data ---');
  console.log(userData);
  console.log('--- End user_data ---\n');
  
  // Create droplet with SSH key
  console.log('Creating droplet...');
  const createResponse = await doApiCall('/droplets', 'POST', {
    name: testName,
    region: 'nyc3',
    size: 's-1vcpu-2gb',
    image: parseInt(TEMPLATE_SNAPSHOT_ID),
    backups: false,
    ipv6: false,
    monitoring: true,
    ssh_keys: [54026256], // forge-key
    user_data: userData
  });
  
  const dropletId = createResponse.droplet.id;
  console.log(`✓ Droplet created: ${dropletId}`);
  
  // Wait for droplet to be active
  console.log('Waiting for droplet to become active...');
  let dropletIp = null;
  let attempts = 0;
  
  while (attempts < 60) {
    await sleep(10000);
    const dropletStatus = await doApiCall(`/droplets/${dropletId}`);
    
    if (dropletStatus.droplet.status === 'active') {
      dropletIp = dropletStatus.droplet.networks.v4.find(n => n.type === 'public')?.ip_address;
      break;
    }
    attempts++;
  }
  
  if (!dropletIp) {
    throw new Error('Droplet failed to become active');
  }
  
  console.log(`✓ Droplet active: ${dropletIp}`);
  console.log('\nWaiting 60 seconds for cloud-init to complete...\n');
  await sleep(60000);
  
  console.log('=== DIAGNOSIS READY ===\n');
  console.log('Droplet Details:');
  console.log(`  ID: ${dropletId}`);
  console.log(`  Name: ${testName}`);
  console.log(`  IP: ${dropletIp}`);
  console.log('');
  console.log('Run these commands to diagnose:');
  console.log('');
  console.log('1. Check if SSH works:');
  console.log(`   ssh -i ~/.ssh/id_ed25519_digitalocean root@${dropletIp} whoami`);
  console.log('');
  console.log('2. View password fix debug log:');
  console.log(`   ssh -i ~/.ssh/id_ed25519_digitalocean root@${dropletIp} "cat /var/log/password-fix-debug.log"`);
  console.log('');
  console.log('3. Check cloud-init status:');
  console.log(`   ssh -i ~/.ssh/id_ed25519_digitalocean root@${dropletIp} "cloud-init status --long"`);
  console.log('');
  console.log('4. Check current password expiry:');
  console.log(`   ssh -i ~/.ssh/id_ed25519_digitalocean root@${dropletIp} "chage -l root"`);
  console.log('');
  console.log('5. View cloud-init logs:');
  console.log(`   ssh -i ~/.ssh/id_ed25519_digitalocean root@${dropletIp} "tail -100 /var/log/cloud-init.log"`);
  console.log('');
  console.log('To delete this test droplet:');
  console.log(`   curl -X DELETE "https://api.digitalocean.com/v2/droplets/${dropletId}" -H "Authorization: Bearer ${DO_API_TOKEN}"`);
  console.log('');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
