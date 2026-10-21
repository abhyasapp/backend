# Frontend work required

The frontend repo was not part of this upload, so none of this is implemented here.
Every item below matches a response field the backend now returns.

## Must do
1. **Quiz engine** (`quiz-engine.js`): read `res.result` (already parsed). Fall back to
   `JSON.parse(res.content)` only for old caches; bump the cache version so stale
   empty entries are dropped. When every client does this, set `FILE_LEGACY_CONTENT=false`.
2. **Fallback sessions** (`admin/core.js`, `net.js`): on `sessionInvalid` coming from the
   GAS fallback, do not log the user/admin out — retry once on Supabase, or show the fallback banner.
3. **`mustChangePassword`**: any response (login, adminLogin, any admin call) may carry
   `mustChangePassword: true`. Show the change-password screen, call `adminchangepassword`
   `{currentPassword, newPassword}`, then store the returned `adminToken`.
4. **Admin-accounts UI** (owner only, `isOwner` from login / `adminlistadmins`):
   - hide create / promote / delete / permissions / reset buttons for non-owners;
   - promote dialog: permission checkboxes from `allFeatures` minus `ownerOnlyFeatures`
     → `adminpromoteusertoadmin {targetUsername, permissions}`;
   - `adminresetadminpassword {targetUsername}` → show `tempPassword` **once**;
   - `adminpromoteowner` / `admindemoteowner {targetUsername}`.
5. **No tokens in GET URLs** (`quiz-engine.js`): send `getfile` / `getfiles` as POST.

## Should do
- Route `getfiles` like `getfile`; delete the unused `client/js/api-adapter.js` reference if any remains.
- Fallback banner on the `abhyas:fallback` event; disable `updateProfile` / `adminGetPermissions` while on fallback.
- Handle `backupLimit: true` (GAS cannot verify Supabase hashes) with a "try again later" message.
- Bump the version together in `version.js`, `config.js`, `sw.js`, `package.json`.

## Product backlog carried over (from the handover; not part of this backend)
Timed-exam answer un-select · 60-day plan (Level 7 + GK, daily target bar, >85 % accuracy) ·
storage-full warning + optional Google backup (never auto-delete) · remove question from the
wrong-answer bank · report incomplete / wrong questions (backend endpoints already exist).
