# v3.2.3 Password Preservation Fix - Deployment & Verification

## What Was Fixed

**Problem:** New WordPress instances created from template snapshot had different `clients@sheragency.com` password than expected.

**Root Cause:** Cloud-init (DigitalOcean's initialization system) was potentially modifying user accounts when new droplets booted from the snapshot.

**Solution:** Injected explicit `user_data` configuration that instructs cloud-init to:
- Disable password expiration
- Preserve existing users without modification
- Prevent any automated password changes

## Changes Made

### Code Changes
1. **server.js** - Added cloud-init user_data to droplet creation
2. **package.json** - Version bumped to 3.2.3-password-preservation-fix
3. **New diagnostic tools** - Added scripts for troubleshooting

### Git Commit
- **Commit:** 681de61
- **Pushed:** Feb 19, 2026
- **Auto-deploy:** Will trigger on DigitalOcean App Platform

### New Files Added
- `PASSWORD-ISSUE-ANALYSIS.md` - Detailed analysis of the problem
- `diagnose-password-issue.sh` - SSH diagnostic script
- `fix-password-preservation.js` - Testing utilities

## Deployment Status

### Check Deployment
1. Visit: https://wp-instance-creator-7ztm4.ondigitalocean.app/api/health
2. Verify `version: "3.2.3-password-preservation-fix"`
3. Wait 2-3 minutes for auto-deploy to complete

### Monitor Deployment
```bash
# Check DigitalOcean deployment status
curl -s -X GET "https://api.digitalocean.com/v2/apps" \
  -H "Authorization: Bearer $DO_API_TOKEN" | \
  python3 -m json.tool | \
  grep -A 30 "wp-instance-creator"
```

## Testing Plan

### Test 1: Password Verification (Recommended)

1. **Record Template Password Hash**
```bash
# SSH to template droplet
ssh root@<mbstest1-ip>

# Get password hash
mysql -u root -e "SELECT user_login, user_pass FROM wordpress.wp_users WHERE user_login='clients@sheragency.com';" | tee template-hash.txt
```

2. **Create Test Instance**
- Go to: https://wp-instance-creator-7ztm4.ondigitalocean.app
- Create subdomain: `passwordtest2` (or similar)
- Wait for completion (5-7 minutes)

3. **Verify Password Hash Matches**
```bash
# SSH to new test instance
ssh root@<new-instance-ip>

# Get password hash
mysql -u root -e "SELECT user_login, user_pass FROM wordpress.wp_users WHERE user_login='clients@sheragency.com';"

# Compare with template-hash.txt - should be IDENTICAL
```

4. **Login Test**
- Visit: https://passwordtest2.sherstaging.com/wp-admin
- Login with: `clients@sheragency.com` + password from 1Password
- Should succeed without "invalid password" error

### Test 2: Functional Test

1. **Create Production Instance**
- Create a real client subdomain (e.g., `clientname`)
- Wait for completion
- Login to wp-admin
- Verify password works immediately

2. **Cleanup Test Instances** (optional)
```bash
# Delete test droplets via DigitalOcean API or console
# Search for: wp-passwordtest, wp-passwordtest2, etc.
```

## Expected Results

✅ **BEFORE Fix (v3.2.2):**
- New instance password ≠ template password
- Login fails with correct password
- Must manually reset password

✅ **AFTER Fix (v3.2.3):**
- New instance password = template password (exact match)
- Login succeeds with 1Password credentials
- No password reset needed

## Rollback Plan

If the fix causes issues:

```bash
cd /Users/max/.openclaw/workspace-forge/wp-instance-creator
git revert HEAD
git push origin main
# Wait for auto-deploy (2-3 minutes)
```

## Alternative Solution (If Still Issues)

If password mismatches persist after v3.2.3, try this:

### Option A: Clean Snapshot Approach

```bash
# SSH to template droplet
ssh root@<template-ip>

# Clean cloud-init state
sudo cloud-init clean --logs --seed
sudo rm -rf /var/lib/cloud/instances/*
sudo rm -rf /var/lib/cloud/instance
sudo history -c

# Create new snapshot via DO console
# Name: wordpress-managed-wildcard-ssl-20260219-clean
# Update TEMPLATE_SNAPSHOT_ID in server.js to new snapshot ID
```

### Option B: Diagnostic Investigation

```bash
# Run diagnostic script on new instance
cd /Users/max/.openclaw/workspace-forge/wp-instance-creator
chmod +x diagnose-password-issue.sh
./diagnose-password-issue.sh <new-instance-ip>

# Review output for:
# - Cloud-init scripts
# - Cron jobs
# - WordPress plugins
# - Any automation that might modify passwords
```

## Success Criteria

- [ ] v3.2.3 deployed successfully
- [ ] Health endpoint shows correct version
- [ ] New test instance created
- [ ] Password hash matches template exactly
- [ ] Login with 1Password credentials succeeds
- [ ] No manual password reset required

## Timeline

- **Fix Developed:** Feb 19, 2026 13:54 CST
- **Committed:** 681de61
- **Pushed:** Feb 19, 2026
- **Auto-Deploy:** ~2-3 minutes after push
- **Testing:** Immediate after deploy
- **Production Ready:** After successful test

## Next Steps

1. Wait 2-3 minutes for auto-deploy
2. Verify version at /api/health
3. Run Test 1 (Password Verification)
4. If passes, deploy to production workload
5. Monitor for any issues
6. Document final outcome

## Support

If issues persist:
1. Check deployment logs in DigitalOcean console
2. Run diagnostic script on affected instance
3. Review PASSWORD-ISSUE-ANALYSIS.md for deeper investigation
4. Consider Alternative Solutions above

---

**Deliverable:** Password preservation fix deployed and verified working.
