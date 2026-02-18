# WordPress Instance Creator - Test Plan

## Test Date: 2026-02-18

## Environment
- **GitHub Repo**: https://github.com/maxdevs97/wp-instance-creator
- **DigitalOcean App ID**: 1816b1a0-5264-4109-88f4-86626f226d38
- **Deployment Status**: In Progress
- **Template Droplet**: wordpress-managed-20260212 (ID: 551293569)

## Pre-Testing Constraints

### Droplet Limit Issue
- **Current Status**: 2/3 droplets used
- **Available Slots**: 1
- **Limit Increase**: Requested from DO support
- **Testing Strategy**: 
  - ✅ Test snapshot creation (does not count against limit)
  - ⚠️ Create only ONE test droplet (will reach limit)
  - ❌ Cannot test multiple instances until limit raised
  - **Alternative**: Delete wp-mbstest2-fix-0217 (ID: 552433252) to free up slot

## Test Cases

### 1. Application Health Check
**Objective**: Verify application is running and configured correctly

- [ ] Access application URL
- [ ] Check `/api/health` endpoint
- [ ] Verify all environment variables loaded:
  - [ ] DO_API_TOKEN present
  - [ ] FORM_PASSWORD present
  - [ ] SSH_PRIVATE_KEY present

**Expected Result**: Health check returns 200 OK with all config flags true

---

### 2. Password Gate Authentication
**Objective**: Verify team password protection works

**Test Steps**:
1. Load application homepage
2. Verify form is hidden
3. Enter incorrect password
4. Verify error message
5. Enter correct password: `SherTeam2026!Secure`
6. Verify form unlocks

**Expected Result**: Form only accessible with correct password

---

### 3. Form Validation
**Objective**: Test input validation

**Test Cases**:
- [ ] Empty subdomain → Should show required field error
- [ ] Invalid subdomain characters (uppercase, spaces, special) → Should show validation error
- [ ] Valid subdomain (lowercase, numbers, hyphens) → Should accept
- [ ] Empty WP password → Should show required field error
- [ ] Weak WP password (<8 chars) → Should show length error
- [ ] Valid WP password (8+ chars) → Should accept

**Expected Result**: All validation rules enforced on frontend

---

### 4. Snapshot Creation (NON-DESTRUCTIVE)
**Objective**: Test snapshot creation without creating droplet

**Prerequisites**: 
- Template droplet must be active
- DO API token must have snapshot permissions

**Test Steps**:
1. Monitor DigitalOcean API directly:
```bash
curl -H "Authorization: Bearer $DO_API_TOKEN" \
  https://api.digitalocean.com/v2/droplets/551293569/actions \
  -X POST \
  -d '{"type":"snapshot","name":"test-snapshot-20260218"}'
```
2. Check action status
3. Verify snapshot appears in snapshots list
4. Delete test snapshot after verification

**Expected Result**: 
- Snapshot creation succeeds
- Takes 3-5 minutes
- Snapshot ID returned
- Can be used as image source

**Status**: ⏳ Pending manual test

---

### 5. DNS Record Management (NON-DESTRUCTIVE)
**Objective**: Verify DNS API access

**Test Steps**:
1. List existing DNS records:
```bash
curl -H "Authorization: Bearer $DO_API_TOKEN" \
  https://api.digitalocean.com/v2/domains/sherstaging.com/records
```
2. Verify mbstest1 and mbstest2 records exist
3. (Optional) Create test A record for `api-test.sherstaging.com`
4. Verify record created
5. Delete test record

**Expected Result**: API can read and create DNS records

**Status**: ⏳ Pending manual test

---

### 6. Full Instance Creation (DESTRUCTIVE - Will Use Droplet Slot)
**Objective**: Test complete workflow end-to-end

**⚠️ WARNING**: This test will:
- Create a snapshot (3-5 min)
- Create a new droplet (uses 1 slot)
- Configure DNS
- Install SSL certificate
- Takes 8-12 minutes total

**Prerequisites**:
- Have 1 free droplet slot OR delete wp-mbstest2-fix-0217 first
- Choose unique subdomain (e.g., `test1`, `forge-test`)
- Prepare to verify results

**Test Steps**:
1. Access form at live URL
2. Enter password: `SherTeam2026!Secure`
3. Enter subdomain: `test1` (or other unused)
4. Enter WP password: `TestPass123!`
5. Submit form
6. Monitor real-time logs in browser
7. Wait for completion (8-12 min)
8. Verify response includes:
   - Domain name
   - Droplet ID
   - Droplet IP
   - Admin URL

**Verification Steps**:
1. Check DigitalOcean dashboard:
   - [ ] New droplet exists with correct name
   - [ ] Droplet is running
   - [ ] Correct size and region
2. Check DNS:
   - [ ] A record exists for subdomain
   - [ ] Points to correct IP
   - [ ] Wait 1-2 min for propagation
3. Check site accessibility:
   - [ ] `https://test1.sherstaging.com` loads
   - [ ] SSL certificate valid (Let's Encrypt)
   - [ ] WordPress site displays (not errors)
4. Check WordPress admin:
   - [ ] `https://test1.sherstaging.com/wp-admin` loads
   - [ ] Can login with `clients@sheragency.com` and test password
   - [ ] Dashboard accessible
   - [ ] Site URL correct in Settings > General

**Expected Result**: 
- All steps complete successfully
- Site loads with valid SSL
- WordPress admin login works
- Site fully functional

**Status**: ⏳ Blocked by droplet limit

---

### 7. Error Handling
**Objective**: Test error scenarios

**Test Cases**:
- [ ] Duplicate subdomain → Should error gracefully
- [ ] Invalid DO API token → Should error with auth message
- [ ] Network timeout → Should report timeout error
- [ ] SSH failure → Should report connection error

**Expected Result**: All errors handled gracefully with clear messages

**Status**: ⏳ Pending

---

### 8. Log Output Quality
**Objective**: Verify logging is useful for debugging

**Checks**:
- [ ] Each major step logged
- [ ] Timestamps or sequence clear
- [ ] Errors clearly marked
- [ ] Success indicators present
- [ ] Warnings for non-critical issues

**Expected Result**: Logs provide clear progress tracking

**Status**: ⏳ Pending full test

---

## Testing Strategy Given Constraints

### Phase 1: Non-Destructive Testing (COMPLETED)
✅ Code review
✅ Local server start test
✅ Environment variable validation
✅ GitHub repo creation
✅ DigitalOcean deployment initiated

### Phase 2: API Verification (CAN DO NOW)
- [ ] Test DigitalOcean API access
- [ ] List existing droplets
- [ ] List DNS records
- [ ] Test snapshot creation manually
- [ ] Test DNS record creation (with test subdomain)

### Phase 3: Single Full Test (REQUIRES DECISION)
**Option A**: Wait for droplet limit increase
- ✅ No manual cleanup needed
- ❌ Delays testing
- ❌ Unknown wait time

**Option B**: Delete wp-mbstest2-fix-0217 to free slot
- ✅ Can test immediately
- ✅ Validates full workflow
- ⚠️ Loses existing test instance
- **Recommended if instance not needed**

**Option C**: Test snapshot only, defer droplet creation
- ✅ Tests 80% of workflow
- ✅ No limit impact
- ❌ Can't verify DNS/SSL/WordPress config
- ❌ Incomplete validation

## Known Issues & Limitations

1. **SSH Key Format**: Ed25519 key used; verify compatibility with ssh2 library
2. **Certbot Timing**: SSL cert requires DNS propagation; may need retry logic
3. **WordPress CLI**: Assumes `wp` CLI installed on template droplet
4. **Database Access**: Assumes MySQL accessible with root user
5. **Snapshot Cleanup**: No automatic snapshot deletion (should add)
6. **Droplet Limit**: Will fail if account at limit
7. **DNS Propagation**: 1-5 minute delay before SSL can be installed

## Manual Verification Checklist

After successful instance creation:

**DigitalOcean Console**:
- [ ] Droplet exists
- [ ] Correct name format `wp-{subdomain}`
- [ ] Running status
- [ ] Correct IP assigned
- [ ] DNS record points to IP

**Website**:
- [ ] Site loads at HTTPS URL
- [ ] SSL certificate valid (green lock)
- [ ] WordPress homepage displays
- [ ] No mixed content warnings

**WordPress Admin**:
- [ ] Admin panel accessible
- [ ] Login works with provided credentials
- [ ] Dashboard shows correct site URL
- [ ] Can create test post
- [ ] Media upload works
- [ ] Plugin management accessible

**Performance**:
- [ ] Page load time reasonable (<3s)
- [ ] No server errors in browser console
- [ ] nginx/PHP-FPM responding

## Post-Test Cleanup

After testing complete:
- [ ] Document results in this file
- [ ] Screenshot successful creation
- [ ] Save logs from test run
- [ ] Decide: keep or delete test droplet
- [ ] Delete test snapshot if created
- [ ] Update README with any findings

## Recommendations for Production Use

Based on testing:
1. Add snapshot cleanup job (delete old snapshots after 7 days)
2. Add droplet limit check before starting
3. Add DNS propagation wait/retry for SSL
4. Add email notification when complete
5. Add instance management UI (list/delete)
6. Consider rate limiting (prevent abuse)
7. Add cost tracking (monitor spending)

## Test Results

### Deployment Status
- **Deployment Initiated**: 2026-02-18 17:31 UTC
- **Build Status**: Pending (checking...)
- **Live URL**: TBD
- **First Deploy Time**: TBD

### API Testing Results
(To be completed)

### Full Workflow Test Results
(To be completed after droplet limit resolved)

---

**Test Conducted By**: Forge (OpenClaw Agent)
**Test Date**: 2026-02-18
**Next Steps**: Check deployment status, then proceed with API verification tests
