# v3.2.2 - Password Field Removal

**Release Date:** February 19, 2026  
**Commit:** 00b92ee

## Summary
Removed the non-functional WordPress admin password field from the form and updated the completion message to reference 1Password for password management.

## Background
In v3.0, the ability to set passwords via REST API was removed. The password field remained in the form but was non-functional. The template includes a standard password that is inherited by all instances and managed via 1Password.

## Changes

### User-Facing Changes
1. **Form**
   - Removed "WordPress Admin Password" input field
   - Removed helper text about username
   - Simplified form to only require subdomain input

2. **Completion Page**
   - Added explicit password row in credentials section
   - Password field displays: `(should appear in 1Password)` 
   - Provides clear indication that password is managed externally

### Technical Changes
1. **Frontend (public/index.html)**
   - Removed `wpPassword` input field and label
   - Removed `wpPassword` variable from `createInstance()` function
   - Removed `wpAdminPassword` from API request payload
   - Removed form reset for removed field
   - Added password display row in completion results

2. **Backend (server.js)**
   - Removed `wpAdminPassword` parameter from `/api/create-instance` endpoint
   - Updated validation to only require `subdomain`
   - Removed `wpAdminPassword` from job metadata
   - Updated `processJob()` to not expect password parameter
   - Updated version strings to `3.2.2-password-field-removal`
   - Added console message about password management

3. **Package (package.json)**
   - Updated version to `3.2.2-password-field-removal`

## Migration Notes
No migration required. Existing jobs and instances are unaffected.

## Testing Checklist
- [ ] Form displays without password field
- [ ] Form validation works with only subdomain
- [ ] Instance creation completes successfully
- [ ] Completion page shows password row with 1Password message
- [ ] Health endpoint returns correct version
- [ ] No console errors in browser or server

## Related Issues
Resolves cleanup issue from v3.0 REST API password setting removal.

## Next Steps
Consider adding link to 1Password vault or documentation about accessing the standard template password.
