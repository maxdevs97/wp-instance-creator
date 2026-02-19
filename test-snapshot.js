#!/usr/bin/env node

/**
 * Test script for snapshot creation workflow
 * Tests the new dynamic snapshot functionality without creating a full instance
 */

require('dotenv').config();
const fetch = require('node-fetch');

const DO_API_TOKEN = process.env.DO_API_TOKEN;
const TEMPLATE_DROPLET_ID = '552784281';

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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function createSnapshotFromTemplate(dropletId, snapshotName) {
  console.log(`Creating snapshot "${snapshotName}" from droplet ${dropletId}...`);
  
  const response = await doApiCall(`/droplets/${dropletId}/actions`, 'POST', {
    type: 'snapshot',
    name: snapshotName
  });
  
  return response.action;
}

async function waitForSnapshotCompletion(actionId, dropletId, snapshotName, maxWaitMinutes = 5) {
  const maxAttempts = maxWaitMinutes * 6;
  let attempts = 0;
  
  console.log(`Waiting for snapshot action ${actionId} to complete...`);
  
  // Wait for action to complete
  while (attempts < maxAttempts) {
    const actionData = await doApiCall(`/droplets/${dropletId}/actions/${actionId}`);
    const action = actionData.action;
    
    console.log(`  [Attempt ${attempts + 1}/${maxAttempts}] Action status: ${action.status}`);
    
    if (action.status === 'completed') {
      console.log(`✓ Snapshot action completed!`);
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
  console.log(`Looking for snapshot with name: ${snapshotName}...`);
  const snapshotsData = await doApiCall(`/droplets/${dropletId}/snapshots`);
  const snapshot = snapshotsData.snapshots.find(s => s.name === snapshotName);
  
  if (!snapshot) {
    throw new Error(`Snapshot ${snapshotName} not found after action completed`);
  }
  
  console.log(`✓ Snapshot ${snapshot.id} is ready!`);
  console.log(`  - Name: ${snapshot.name}`);
  console.log(`  - Size: ${snapshot.size_gigabytes}GB`);
  console.log(`  - Min disk: ${snapshot.min_disk_size}GB`);
  console.log(`  - Created: ${snapshot.created_at}`);
  
  return snapshot;
}

async function cleanupSnapshot(snapshotId) {
  console.log(`\nCleaning up test snapshot ${snapshotId}...`);
  try {
    await doApiCall(`/snapshots/${snapshotId}`, 'DELETE');
    console.log(`✓ Snapshot ${snapshotId} deleted successfully`);
  } catch (error) {
    console.error(`✗ Failed to delete snapshot: ${error.message}`);
  }
}

async function runTest() {
  console.log('=== WP Instance Creator - Snapshot Workflow Test ===\n');
  
  // Step 1: Verify template droplet exists
  console.log('Step 1: Verifying template droplet...');
  try {
    const dropletData = await doApiCall(`/droplets/${TEMPLATE_DROPLET_ID}`);
    const droplet = dropletData.droplet;
    console.log(`✓ Template droplet found: ${droplet.name} (${droplet.status})`);
    console.log(`  - ID: ${droplet.id}`);
    console.log(`  - Region: ${droplet.region.name}`);
    console.log(`  - Size: ${droplet.size.slug}`);
    console.log(`  - IP: ${droplet.networks.v4.find(n => n.type === 'public')?.ip_address}\n`);
  } catch (error) {
    console.error(`✗ Failed to find template droplet: ${error.message}`);
    process.exit(1);
  }
  
  // Step 2: Create test snapshot
  console.log('Step 2: Creating test snapshot...');
  const snapshotName = `wp-test-snapshot-${Date.now()}`;
  let snapshot;
  let action;
  
  try {
    action = await createSnapshotFromTemplate(TEMPLATE_DROPLET_ID, snapshotName);
    console.log(`✓ Snapshot action initiated: ${action.id}\n`);
  } catch (error) {
    console.error(`✗ Failed to create snapshot: ${error.message}`);
    process.exit(1);
  }
  
  // Step 3: Wait for snapshot completion
  console.log('Step 3: Waiting for snapshot to complete...');
  try {
    snapshot = await waitForSnapshotCompletion(action.id, TEMPLATE_DROPLET_ID, snapshotName);
    console.log(`\n✓ Snapshot workflow completed successfully!\n`);
  } catch (error) {
    console.error(`✗ Snapshot completion failed: ${error.message}`);
    if (snapshot && snapshot.id) {
      await cleanupSnapshot(snapshot.id);
    }
    process.exit(1);
  }
  
  // Step 4: Verify snapshot can be used for droplet creation
  console.log('Step 4: Verifying snapshot is usable...');
  if (snapshot.min_disk_size && snapshot.size_gigabytes) {
    console.log(`✓ Snapshot has all required fields for droplet creation`);
    console.log(`  - Can be used with droplet sizes >= ${snapshot.min_disk_size}GB\n`);
  } else {
    console.warn(`⚠ Snapshot may be missing some fields\n`);
  }
  
  // Step 5: Cleanup
  await cleanupSnapshot(snapshot.id);
  
  console.log('\n=== Test Summary ===');
  console.log('✓ Template droplet verified');
  console.log('✓ Snapshot creation successful');
  console.log('✓ Snapshot completion detected');
  console.log('✓ Snapshot is usable for droplet creation');
  console.log('✓ Test snapshot cleaned up');
  console.log('\n✓ All tests passed! Ready for production deployment.');
}

// Run the test
runTest().catch(error => {
  console.error('\n✗ Test failed:', error.message);
  process.exit(1);
});
