/* migrate-files.gs — Copy every Drive file to Supabase Storage.
   Does NOT change the app. App keeps reading from Drive.
   Safe to run multiple times (upsert). */

function migrateAllFilesToSupabase() {
  const SUPA_URL = 'https://kdysjiiefvxnkrykgykz.supabase.co';
  const SUPA_KEY = PropertiesService.getScriptProperties().getProperty('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPA_KEY) throw new Error('Set SUPABASE_SERVICE_ROLE_KEY in Script Properties first (Project Settings → Script Properties).');

  const results = {
    subjectiveQuestions: { total: 0, uploaded: 0, failed: 0, errors: [] },
    weeklySets:          { total: 0, uploaded: 0, failed: 0, errors: [] },
    studyDocs:           { total: 0, uploaded: 0, failed: 0, errors: [] },
    subjectiveAnswers:   { total: 0, uploaded: 0, failed: 0, errors: [] },
    paymentScreenshots:  { total: 0, uploaded: 0, failed: 0, errors: [] }
  };

  function upload(file, bucket, tracker, prefix) {
    try {
      const fileName = file.getName();
      const storagePath = prefix + '/' + fileName;
      const blob = file.getBlob();
      const url = SUPA_URL + '/storage/v1/object/' + bucket + '/' + storagePath;
      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        headers: {
          'Authorization': 'Bearer ' + SUPA_KEY,
          'Content-Type': blob.getContentType() || 'application/octet-stream',
          'x-upsert': 'true'
        },
        payload: blob.getBytes(),
        muteHttpExceptions: true
      });
      const code = response.getResponseCode();
      if (code >= 200 && code < 300) {
        tracker.uploaded++;
        Logger.log('  ✓ ' + fileName + ' → ' + bucket + '/' + storagePath);
      } else {
        throw new Error('HTTP ' + code + ': ' + response.getContentText().slice(0, 200));
      }
    } catch (e) {
      tracker.failed++;
      tracker.errors.push({ fileId: file.getId(), name: file.getName(), error: e.message });
      Logger.log('  ✗ ' + file.getName() + ' — ' + e.message);
    }
  }

  // 1. Subjective question JSONs
  Logger.log('=== Subjective questions ===');
  try {
    const folders = DriveApp.getFoldersByName('SubjectiveQuestions');
    while (folders.hasNext()) {
      const files = folders.next().getFiles();
      while (files.hasNext()) {
        const f = files.next();
        results.subjectiveQuestions.total++;
        upload(f, 'subjective-content', results.subjectiveQuestions, 'questions');
        Utilities.sleep(100);
      }
    }
  } catch (e) { Logger.log('Subjective questions error: ' + e.message); }

  // 2. Weekly sets (by fileId from sheet)
  Logger.log('=== Weekly sets ===');
  const wsData = getWeeklySetsSheet_().getDataRange().getValues();
  for (let i = 1; i < wsData.length; i++) {
    const fileId = String(wsData[i][2] || '').trim();
    if (!fileId || !/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) continue;
    results.weeklySets.total++;
    try {
      upload(DriveApp.getFileById(fileId), 'weekly-sets', results.weeklySets, 'sets');
    } catch (e) {
      results.weeklySets.failed++;
      results.weeklySets.errors.push({ fileId, error: e.message });
      Logger.log('  ✗ weekly set ' + fileId + ' — ' + e.message);
    }
    Utilities.sleep(100);
  }

  // 3. Study PDFs
  Logger.log('=== Study docs ===');
  const sdData = getStudyDocsSheet_().getDataRange().getValues();
  for (let i = 1; i < sdData.length; i++) {
    const fileId = String(sdData[i][5] || '').trim();
    if (!fileId || !/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) continue;
    results.studyDocs.total++;
    try {
      upload(DriveApp.getFileById(fileId), 'study-docs', results.studyDocs, 'migrated');
    } catch (e) {
      results.studyDocs.failed++;
      results.studyDocs.errors.push({ fileId, error: e.message });
      Logger.log('  ✗ study doc ' + fileId + ' — ' + e.message);
    }
    Utilities.sleep(100);
  }

  // 4. Subjective answer PDFs
  Logger.log('=== Subjective answers ===');
  const subData = getSubjSubmissionsSheet_().getDataRange().getValues();
  for (let i = 1; i < subData.length; i++) {
    const fileId = String(subData[i][10] || '').trim();
    if (!fileId || !/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) continue;
    results.subjectiveAnswers.total++;
    try {
      upload(DriveApp.getFileById(fileId), 'subjective', results.subjectiveAnswers, 'migrated');
    } catch (e) {
      results.subjectiveAnswers.failed++;
      results.subjectiveAnswers.errors.push({ fileId, error: e.message });
      Logger.log('  ✗ answer ' + fileId + ' — ' + e.message);
    }
    Utilities.sleep(100);
  }

  // 5. Payment screenshots
  Logger.log('=== Payment screenshots ===');
  const payData = getPaymentsSheet_().getDataRange().getValues();
  for (let i = 1; i < payData.length; i++) {
    const url = String(payData[i][8] || '').trim();
    if (!url) continue;
    const fileId = driveIdFromUrl_(url);
    if (!fileId) continue;
    results.paymentScreenshots.total++;
    try {
      upload(DriveApp.getFileById(fileId), 'payments', results.paymentScreenshots, 'migrated');
    } catch (e) {
      results.paymentScreenshots.failed++;
      results.paymentScreenshots.errors.push({ fileId, error: e.message });
      Logger.log('  ✗ screenshot ' + fileId + ' — ' + e.message);
    }
    Utilities.sleep(100);
  }

  Logger.log('═══════════════════════════════════════════════');
  Logger.log('SUMMARY');
  Logger.log('═══════════════════════════════════════════════');
  Object.keys(results).forEach(k => {
    const r = results[k];
    Logger.log(k + ': ' + r.uploaded + '/' + r.total + ' uploaded, ' + r.failed + ' failed');
    r.errors.forEach(e => Logger.log('    ERROR: ' + JSON.stringify(e)));
  });
  Logger.log('═══════════════════════════════════════════════');
  return results;
}
function findSubjectiveFiles() {
  Logger.log('=== All folders with "subjective" in the name ===');
  const allFolders = DriveApp.getFolders();
  let count = 0;
  while (allFolders.hasNext()) {
    const f = allFolders.next();
    if (f.getName().toLowerCase().includes('subjective')) {
      Logger.log('  Folder: "' + f.getName() + '" (id: ' + f.getId() + ')');
      const files = f.getFiles();
      let fileCount = 0;
      while (files.hasNext()) { files.next(); fileCount++; }
      Logger.log('    Files inside: ' + fileCount);
      count++;
    }
  }
  if (!count) Logger.log('  (none found)');
  
  Logger.log('=== SUBJECTIVE_FILE_REFS in client (first 5) ===');
  const code = UrlFetchApp.fetch('https://abhyasapp.github.io/abhyas-app/js/data/subjective-data.js', { muteHttpExceptions: true }).getContentText();
  const matches = code.match(/fileId\s*:\s*['"]([A-Za-z0-9_-]{20,})['"]/g);
  if (matches) matches.slice(0, 5).forEach(m => Logger.log('  ' + m));
  else Logger.log('  (no fileIds found in file)');
}
function migrateSubjectiveQuestions() {
  const SUPA_URL = 'https://kdysjiiefvxnkrykgykz.supabase.co';
  const SUPA_KEY = PropertiesService.getScriptProperties().getProperty('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPA_KEY) throw new Error('Set SUPABASE_SERVICE_ROLE_KEY first');

  // Fetch deployed client to get actual fileIds used by the app
  const resp = UrlFetchApp.fetch('https://abhyasapp.github.io/abhyas-app/js/data/subjective-data.js', { muteHttpExceptions: true });
  const code = resp.getContentText();

  // Extract every fileId: "..."
  const regex = /fileId\s*:\s*['"]([A-Za-z0-9_-]{20,})['"]/g;
  const fileIds = [];
  let m;
  while ((m = regex.exec(code)) !== null) {
    if (fileIds.indexOf(m[1]) === -1) fileIds.push(m[1]);
  }

  Logger.log('Found ' + fileIds.length + ' unique fileIds in client');

  let uploaded = 0, failed = 0;
  const errors = [];

  for (const fileId of fileIds) {
    try {
      const file = DriveApp.getFileById(fileId);
      const fileName = file.getName();
      const storagePath = 'questions/' + fileName;
      const blob = file.getBlob();

      const uploadUrl = SUPA_URL + '/storage/v1/object/subjective-content/' + storagePath;
      const r = UrlFetchApp.fetch(uploadUrl, {
        method: 'post',
        headers: {
          'Authorization': 'Bearer ' + SUPA_KEY,
          'Content-Type': blob.getContentType() || 'application/json',
          'x-upsert': 'true'
        },
        payload: blob.getBytes(),
        muteHttpExceptions: true
      });

      const code = r.getResponseCode();
      if (code >= 200 && code < 300) {
        uploaded++;
        Logger.log('  ✓ ' + fileName);
      } else {
        throw new Error('HTTP ' + code + ': ' + r.getContentText().slice(0, 150));
      }
    } catch (e) {
      failed++;
      errors.push({ fileId, error: e.message });
      Logger.log('  ✗ ' + fileId + ' — ' + e.message);
    }
    Utilities.sleep(100);
  }

  Logger.log('═══════════════════════════════════');
  Logger.log('Subjective questions: ' + uploaded + '/' + fileIds.length + ' uploaded, ' + failed + ' failed');
  errors.forEach(e => Logger.log('  ERROR: ' + JSON.stringify(e)));
  return { uploaded, failed, total: fileIds.length, errors };
}