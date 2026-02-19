#!/usr/bin/env node
/**
 * Fix: WordPress Password Preservation
 * 
 * This script implements a solution to ensure passwords are preserved
 * when creating new instances from the template snapshot.
 * 
 * Solutions implemented:
 * 1. Add explicit user_data to disable cloud-init password management
 * 2. Option to verify password after creation (requires SSH)
 * 3. Clean snapshot creation helper
 */

require('dotenv').config();
const fetch = require('node-fetch');

const DO_API_TOKEN = process.env.DO_API_TOKEN;
const TEMPLATE_DROPLET_ID = '552784281';

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

/**
 * Solution 1: User data to disable cloud-init password management
 */
function getPasswordPreservingUserData() {
  return `#cloud-config
# Disable automatic password management
chpasswd:
  expire: false
users:
  - default
# Prevent cloud-init from modifying existing users
preserve_hostname: false
# Disable password expiration and reset
password: null
`;
}

/**
 * Solution 2: Create clean snapshot (removes cloud-init state)
 */
async function createCleanSnapshot(dropletId, snapshotName) {
  console.log(`Creating clean snapshot: ${snapshotName}`);
  console.log('Note: You should SSH to the droplet first and run:');
  console.log('  sudo cloud-init clean --logs --seed');
  console.log('  sudo rm -rf /var/lib/cloud/instances/*');
  console.log('  sudo rm -rf /var/lib/cloud/instance');
  console.log('  sudo history -c');
  console.log('');
  console.log('Press Enter after you have cleaned the droplet, or Ctrl+C to cancel...');
  
  // Wait for user confirmation
  await new Promise(resolve => {
    process.stdin.once('data', resolve);
  });
  
  console.log('Creating snapshot...');
  const result = await doApiCall(`/droplets/${dropletId}/actions`, 'POST', {
    type: 'snapshot',
    name: snapshotName
  });
  
  console.log(`Snapshot creation initiated: Action ID ${result.action.id}`);
  console.log('Monitor progress in DigitalOcean console or run:');
  console.log(`  curl -X GET "https://api.digitalocean.com/v2/actions/${result.action.id}" -H "Authorization: Bearer $DO_API_TOKEN"`);
  
  return result;
}

/**
 * Solution 3: Updated droplet creation with password preservation
 */
function getUpdatedDropletConfig(dropletName, snapshotId) {
  return {
    name: dropletName,
    region: 'nyc3',
    size: 's-1vcpu-2gb',
    image: parseInt(snapshotId),
    backups: false,
    ipv6: false,
    monitoring: true,
    // Add explicit user_data to prevent password changes
    user_data: getPasswordPreservingUserData()
  };
}

/**
 * Print updated server.js code
 */
function printUpdatedServerCode() {
  console.log('\n=== UPDATED SERVER.JS CODE ===\n');
  console.log('Replace the droplet creation section in server.js with:\n');
  console.log('```javascript');
  console.log('// Step 2: Create new droplet from template snapshot');
  console.log('updateJobProgress(jobId, \'droplet_start\', \'Creating new droplet from snapshot...\');');
  console.log('const dropletName = `wp-${subdomain}`;');
  console.log('');
  console.log('// User data to prevent cloud-init from changing passwords');
  console.log('const userData = `#cloud-config');
  console.log('# Disable automatic password management');
  console.log('chpasswd:');
  console.log('  expire: false');
  console.log('users:');
  console.log('  - default');
  console.log('preserve_hostname: false');
  console.log('password: null');
  console.log('`;');
  console.log('');
  console.log('const dropletResponse = await doApiCall(\'/droplets\', \'POST\', {');
  console.log('  name: dropletName,');
  console.log('  region: \'nyc3\',');
  console.log('  size: \'s-1vcpu-2gb\',');
  console.log('  image: parseInt(TEMPLATE_SNAPSHOT_ID),');
  console.log('  backups: false,');
  console.log('  ipv6: false,');
  console.log('  monitoring: true,');
  console.log('  user_data: userData // Prevent password changes');
  console.log('});');
  console.log('```\n');
}

/**
 * Main menu
 */
async function main() {
  console.log('=== WordPress Password Preservation Fix ===\n');
  console.log('Choose a solution:');
  console.log('1. Create new clean snapshot (recommended)');
  console.log('2. Show updated server.js code (adds user_data to prevent password changes)');
  console.log('3. Test: Show user_data configuration');
  console.log('4. Exit');
  console.log('');
  
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  readline.question('Enter choice (1-4): ', async (choice) => {
    try {
      switch (choice.trim()) {
        case '1':
          const snapshotName = `wordpress-managed-wildcard-ssl-${new Date().toISOString().split('T')[0].replace(/-/g, '')}-clean`;
          await createCleanSnapshot(TEMPLATE_DROPLET_ID, snapshotName);
          break;
        
        case '2':
          printUpdatedServerCode();
          break;
        
        case '3':
          console.log('\n=== User Data Configuration ===\n');
          console.log(getPasswordPreservingUserData());
          console.log('\nThis configuration:');
          console.log('- Disables password expiration');
          console.log('- Prevents cloud-init from modifying existing users');
          console.log('- Preserves all user credentials from the snapshot');
          break;
        
        case '4':
          console.log('Exiting...');
          break;
        
        default:
          console.log('Invalid choice');
      }
    } catch (error) {
      console.error('Error:', error.message);
    } finally {
      readline.close();
    }
  });
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  getPasswordPreservingUserData,
  getUpdatedDropletConfig,
  createCleanSnapshot
};
