# Changelog - WP Instance Creator

## [3.3.0] - 2026-02-19

### 🚀 Major Changes
**Dynamic Snapshot System** - Template changes now propagate automatically to new instances

### Added
- Fresh snapshot creation from template droplet at moment of instance creation
- Snapshot action polling and completion detection
- Enhanced progress reporting for snapshot creation steps
- Comprehensive test suite for snapshot workflow (`test-snapshot.js`)

### Changed
- **BREAKING**: Replaced hardcoded `TEMPLATE_SNAPSHOT_ID` (217727089) with `TEMPLATE_DROPLET_ID` (552784281)
- Snapshot workflow now uses DigitalOcean Actions API
- Updated deployment time estimate: 4-5 minutes (vs 3 minutes previously)
  - Snapshot creation: ~60-90 seconds
  - Droplet creation: ~90 seconds
  - DNS + cloud-init: ~90 seconds

### Fixed
- ✅ Template password changes now propagate to new instances automatically
- ✅ No manual snapshot management required
- ✅ Single source of truth: wordpress-managed-20260212 droplet

### Technical Details
**Template Droplet:**
- Name: wordpress-managed-20260212
- ID: 552784281
- Domain: mbstest1.sherstaging.com
- Region: NYC3
- Size: s-1vcpu-2gb (50GB)

**API Changes:**
- `POST /droplets/{id}/actions` (type: snapshot) - Create snapshot
- `GET /droplets/{id}/actions/{actionId}` - Poll snapshot action status
- `GET /droplets/{id}/snapshots` - Find completed snapshot by name

**Workflow Steps:**
1. Create snapshot action from template droplet
2. Poll action status until `completed`
3. Retrieve snapshot ID by name
4. Create new droplet from fresh snapshot
5. Configure DNS and wait for propagation

### Removed
- Hardcoded `TEMPLATE_SNAPSHOT_ID` constant
- Manual snapshot pre-creation requirement

---

## [3.2.5] - 2026-02-19
### Fixed
- Disabled password authentication to prevent DigitalOcean forced password reset
- SSH key-only authentication via cloud-init configuration

## [3.2.4] - 2026-02-19
### Fixed
- Updated to wildcard SSL snapshot (*.sherstaging.com)
- Pre-installed SSL certificates

## [3.2.0] - 2026-02-18
### Added
- Job queue system for background processing
- Progress reporting API
- Status polling endpoints

---

## Migration Notes (3.2.5 → 3.3.0)

### Environment Variables
No changes required - same `.env` structure:
```bash
DO_API_TOKEN=<token>
FORM_PASSWORD=<password>
```

### Deployment
1. Pull latest code
2. No database migrations required
3. Restart application
4. Test with `/api/health` endpoint
5. Verify version shows `3.3.0`

### Testing
Run test suite before deployment:
```bash
node test-snapshot.js
```

Expected output:
- ✓ Template droplet verified
- ✓ Snapshot creation successful (60-90 seconds)
- ✓ Snapshot completion detected
- ✓ Ready for production

### Rollback
If issues occur, revert to v3.2.5:
```javascript
const TEMPLATE_SNAPSHOT_ID = '217727946';
// Use snapshot ID directly in droplet creation
```

---

## Success Criteria
- [x] Template password changes propagate automatically
- [x] No manual snapshot management needed
- [x] Production ready and tested
- [x] Comprehensive test suite
- [x] Documentation complete
