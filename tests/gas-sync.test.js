const fs=require('fs'),vm=require('vm'),assert=require('assert');
function mkSheet(headers, rows){ const data=[headers,...rows];
  return { data, getLastRow:()=>data.length, getLastColumn:()=>headers.length,
    getRange(r,c,nr=1,nc=1){ return { getValues:()=>{const o=[];for(let i=0;i<nr;i++){o.push(data[r-1+i].slice(c-1,c-1+nc));}return o;},
      setValues:(v)=>{ v.forEach((row,i)=>{ if(!data[r-1+i]) data[r-1+i]=[]; row.forEach((x,j)=>data[r-1+i][c-1+j]=x); }); } }; },
    deleteRow(n){ data.splice(n-1,1); } }; }
const sheets={
  perms:mkSheet(['username','featureKey','enabled','updatedAt','updatedBy'],[['ad','users_view','true','',''],['ad','payments_review','true','','']]),
  users:mkSheet(['username','passHash','contact'],[['a','old','keep@me'],['gone','x','y']]),
  admins:mkSheet(['username','passHash','createdAt','createdBy','token','tokenExpires','role'],[]),
  attempts:mkSheet(['username','weeklyId','answersJson'],[['u','w1','A'],['u','w2','B']]),
};
const mustChange={};
const ctx=vm.createContext({console,
  USERS_SHEET:'Users',ADMINS_SHEET:'Admins',ADMIN_PERMS_SHEET:'AP',SETTINGS_SHEET:'S',PAYMENTS_SHEET:'P',PROGRESS_SHEET:'Pr',PROGRESS_HISTORY_SHEET:'PH',PROGRESS_BACKUPS_SHEET:'PB',PUSHTOKENS_SHEET:'PT',WEEKLYSETS_SHEET:'WS',WEEKLYSTARTS_SHEET:'WSt',WEEKLYATTEMPTS_SHEET:'WA',QREPORTS_SHEET:'Q',SUBJ_SUBMISSIONS_SHEET:'SS',STUDYDOCS_SHEET:'SD',QINDEX_SHEET:'QI',QSTATE_SHEET:'QS',QEVENTS_SHEET:'QE',QSTATS_SHEET:'QT',
  APP_VERSION:'t', PropertiesService:{getScriptProperties:()=>({getProperty:(k)=>k==='SYNC_KEY'?'secret':null})},
  safeEqual_:(a,b)=>a===b, withLock_:(f)=>f(), logAction_(){}, _invalidateSheet_(){},
  adminMustChangePassword_:(u)=>!!mustChange[u], setAdminMustChange_:(u,on)=>{mustChange[u]=on;},
  getAdminPermsSheet_:()=>sheets.perms,getUsersSheet_:()=>sheets.users,getAdminsSheet_:()=>sheets.admins,getWeeklyAttemptsSheet_:()=>sheets.attempts});
vm.runInContext(fs.readFileSync(require('path').join(__dirname,'..','gas','sync.gs'),'utf8'),ctx);
const run=(c)=>vm.runInContext(c,ctx);
ctx.p={key:'bad',tables:'users'}; assert.equal(run('syncPull(p)').success,false);
// pull returns headers (even for GAS-only column discovery)
ctx.p={key:'secret',tables:'users'}; let pull=run('syncPull(p)'); assert.deepEqual(pull.headers.users,['username','passHash','contact']);
// composite keys: update w1 only, w2 intact; new w3 inserted
ctx.p={key:'secret',tables:{weekly_attempts:[{username:'u',weeklyId:'w1',answersJson:'A2'},{username:'u',weeklyId:'w3',answersJson:'C'}]}};
let r=run('syncPush(p)'); assert.equal(r.success,true); assert.deepEqual(r.results.weekly_attempts,{inserted:1,updated:1,skipped:0,deleted:0});
assert.deepEqual(sheets.attempts.data.slice(1).map(x=>x.join(':')),['u:w1:A2','u:w2:B','u:w3:C']);
// GAS-only column preserved on update
ctx.p={key:'secret',tables:{users:[{username:'a',passHash:'new'}]}}; run('syncPush(p)');
assert.deepEqual(sheets.users.data[1],['a','new','keep@me']);
// deletes by composite key + by simple key
ctx.p={key:'secret',tables:{},deletes:{admin_permissions:[{username:'ad',featureKey:'payments_review'}],users:[{username:'gone'}]}};
r=run('syncPush(p)'); assert.equal(r.success,true);
assert.deepEqual(sheets.perms.data.slice(1).map(x=>x[1]),['users_view']);
assert.deepEqual(sheets.users.data.slice(1).map(x=>x[0]),['a']);
// admins must_change passthrough
ctx.p={key:'secret',tables:{admins:[{username:'admin',passHash:'h',role:'owner',must_change_password:'true'}]}}; run('syncPush(p)');
assert.equal(mustChange['admin'],true);
ctx.p={key:'secret',tables:'admins'}; pull=run('syncPull(p)'); assert.equal(pull.tables.admins[0].must_change_password,'true');
console.log('GAS sync harness: all assertions passed');
/* ── correction sync contract (sync/apply_corrections.py) ───────────── */
(function () {
  var H = ['id','uid','fileId','questionSnapshot','reason','note','reportedBy','reportedAt','status','optionsSnapshot','correctIndex','chosenIndex','section','appVersion','resolvedAt','resolvedBy','corrected','correctedSnapshot','qid'];
  function row(o) {
    return [o.id,o.uid,o.fileId,o.q,'typo','n','stu','2026-10-01T00:00:00Z','resolved',
      JSON.stringify(o.options),0,1,'practice','2.06',o.resolvedAt,'admin','TRUE',JSON.stringify(o.snapshot),o.qid || ''];
  }
  var rows = [H,
    row({ id:'R1', uid:'FA_50', fileId:'FA', q:'trim A', qid:48213, options:['30','60'], resolvedAt:'2026-10-31T09:00:00Z',
      snapshot:{ uid:'corr_a1', at:'2026-10-31T09:12:44Z',
        before:{ question:'51. bearing 60 deg', options:['30','60','120','150'] },
        after:{ question:'51. bearing 63 deg', options:['30','63','120','150'], correctIndex:1, explanation:'x' },
        q:'legacy', options:['30','63'], correct:1, explanation:'x' } }),
    row({ id:'R2', uid:'FA_50', fileId:'FA', q:'trim B', options:['a','b'], resolvedAt:'2026-10-31T09:20:00Z',
      snapshot:{ uid:'corr_a1', at:'2026-10-31T09:12:44Z', before:{ question:'x', options:[] },
        after:{ question:'dup', options:['a','b'], correctIndex:0 } } }),
    row({ id:'R3', uid:'FB_7', fileId:'FB', q:'legacy', options:['yes','no'], qid:'a-123-456-789012', resolvedAt:'2026-10-31T10:00:00Z',
      snapshot:{ q:'Legacy after', options:['yes','no'], correct:1, explanation:'' } })
  ];
  var cctx = vm.createContext({
    console: console,
    QREPORTS_SHEET: 'Q',
    PropertiesService: { getScriptProperties: function () { return { getProperty: function () { return 'secret'; } }; } },
    _cachedSheetData_: function () { return { data: rows }; },
    getQReportsSheet_: function () { return null; },
    safeEqual_: function (a, b) { return a === b; },
    Utilities: { getUuid: function () { return 'u'; } },
    SpreadsheetApp: {}, DriveApp: {}, CacheService: { getScriptCache: function () { return {}; } }
  });
  vm.runInContext(fs.readFileSync(require('path').join(__dirname, '..', 'gas', 'report.gs'), 'utf8'), cctx);
  var call = function (p) { return vm.runInContext('syncCorrectionsSince', cctx)(p); };

  var bad = call({ key: 'bad', since: 0, limit: 500 });
  assert.equal(bad.success, false);
  assert.equal(bad.unauthorized, true);
  assert.ok(/SYNC_KEY/.test(bad.error), 'a bad key must name SYNC_KEY');

  var p1 = call({ key: 'secret', since: 0, limit: 1 });
  assert.equal(p1.count, 1);
  assert.equal(p1.truncated, true);
  assert.equal(p1.total, 2);
  assert.equal(p1.now, new Date(p1.corrections[0].correctedAt).getTime(),
    'watermark must be the newest correctedAt actually sent');

  var p2 = call({ key: 'secret', since: p1.now, limit: 500 });
  var uids = p2.corrections.map(function (c) { return c.uid; });
  assert.ok(uids.indexOf('corr_a1') !== -1 && uids.indexOf('R3') !== -1,
    'the row past the limit must not be lost');

  var c = p2.corrections.filter(function (x) { return x.uid === 'corr_a1'; })[0];
  assert.equal(c.before.question, '51. bearing 60 deg');
  assert.ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(c.correctedAt), 'correctedAt must be ISO-8601');
  assert.equal(c.after.correctIndex, 1);
  assert.equal(c.before.options.length, 4);
  assert.equal(c.qid, '48213');

  var legacy = p2.corrections.filter(function (x) { return x.uid === 'R3'; })[0];
  assert.equal(legacy.after.correctIndex, 1);
  assert.equal(legacy.after.question, 'Legacy after');
  // A hyphenated qid must survive the sheet round-trip as a string, not null.
  assert.equal(legacy.qid, 'a-123-456-789012');

  // Published content ids are "<fileId>-<position>" and the old normaliser
  // rejected all of them, so qid was stored as "". A question must also be
  // located by its id before the position is trusted.
  var normQid = vm.runInContext('normalizeQReportQid_', cctx);
  assert.equal(normQid('1-VeNFb81ynETihERKfWNUOZSqrYopyOH-1'), '1-VeNFb81ynETihERKfWNUOZSqrYopyOH-1');
  assert.equal(normQid(48213), '48213');
  assert.equal(normQid('a-123-456-789012'), 'a-123-456-789012');
  assert.equal(normQid('nonsense'), '');
  // Public qn ids as the pipeline actually publishes them: dotted, letter
  // prefixed and word subtopics. These used to normalise to "" so the report
  // fell back to the stale position.
  assert.equal(normQid('G0011.110001'), 'g0011.110001');
  assert.equal(normQid('50011.110001'), '50011.110001');
  assert.equal(normQid('5002mixedqn10001'), '5002mixedqn10001');
  assert.equal(normQid('g0011.110001'), 'g0011.110001');
  var indexFor = vm.runInContext('questionIndexForId_', cctx);
  var arrQ = [{ id: 'X-1' }, { id: '1-VeNF-2' }, { q: 'no id here' }];
  assert.equal(indexFor(arrQ, 9, '1-VeNF-2'), 1, 'must resolve by id, ignoring the stale position');
  assert.equal(indexFor(arrQ, 2, ''), 2, 'must use the position when no id was supplied');
  assert.equal(indexFor(arrQ, 0, 'no-such-id'), -1, 'an unknown id must not fall back to the position');

  console.log('GAS correction-sync contract: all assertions passed');
})();

/* ── header top-up contract (gas/code.gs, _topUpHeaders_) ─────────────
   A sheet created before QREPORT_HEADERS gained "id" at the FRONT must still
   get that key column, or syncPush refuses the table forever. */
(function () {
  var H = ['id','uid','fileId','questionSnapshot','reason','note','reportedBy','reportedAt','status',
    'optionsSnapshot','correctIndex','chosenIndex','section','appVersion','resolvedAt','resolvedBy','corrected',
    'correctedSnapshot','qid'];
  function sheetWith(headers, name) {
    var data = [headers.slice()];
    return {
      getName: function () { return name; },
      getLastColumn: function () { return data[0].length; },
      getRange: function (row, col, nRows, nCols) {
        var cell = {
          getValues: function () {
            return data.slice(row - 1, row - 1 + nRows)
              .map(function (line) { return line.slice(col - 1, col - 1 + nCols); });
          },
          setValues: function (values) {
            values.forEach(function (line, i) {
              var at = row - 1 + i;
              if (!data[at]) data[at] = [];
              line.forEach(function (x, j) { data[at][col - 1 + j] = x; });
            });
            return cell;
          },
          setFontWeight: function () { return cell; },
          setBackground: function () { return cell; },
          setFontColor: function () { return cell; }
        };
        return cell;
      },
      headers: function () { return data[0]; }
    };
  }

  var ctx = vm.createContext({
    console: console,
    SpreadsheetApp: { BandingTheme: { PINK: 1, BLUE: 1, LIGHT_GREY: 1 } },
    PropertiesService: {
      getScriptProperties: function () { return { getProperty: function () { return null; }, setProperty: function () {} }; },
      getUserProperties: function () { return { getProperty: function () { return null; } }; }
    },
    Utilities: { getUuid: function () { return 'u'; } },
    DriveApp: {}, CacheService: { getScriptCache: function () { return {}; } },
    Session: { getActiveUser: function () { return { getEmail: function () { return ''; } }; } },
    HtmlService: { createHtmlOutputFromFile: function () { return {}; } }
  });
  vm.runInContext(fs.readFileSync(require('path').join(__dirname, '..', 'gas', 'code.gs'), 'utf8'), ctx);
  var topUp = vm.runInContext('_topUpHeaders_', ctx);

  // A sheet from before "id" was added at the front of QREPORT_HEADERS.
  var old = sheetWith(H.slice(1), 'QuestionReports');
  topUp(old, H, '#d81b60');
  assert.ok(old.headers().indexOf('id') !== -1, 'the missing key column must be added');
  assert.equal(old.headers().length, H.length);
  assert.deepEqual(old.headers().slice(0, 3), ['uid', 'fileId', 'questionSnapshot'],
    'existing columns must keep their names and order');

  // A complete sheet is left alone, and a padded header is not duplicated.
  var done = sheetWith(H, 'QuestionReports2');
  topUp(done, H, '#d81b60');
  assert.equal(done.headers().length, H.length, 'a complete sheet must not be extended');

  var padded = sheetWith(H.slice(1).concat([' id ']), 'QuestionReports3');
  topUp(padded, H, '#d81b60');
  assert.equal(padded.headers().filter(function (h) { return String(h).trim() === 'id'; }).length, 1,
    '" id " already names the key column');

  console.log('GAS header top-up contract: all assertions passed');
})();

/* ── admin content read (gas/code.gs, handleGetFile) ──────────────────
   The admin console signs in on Supabase and gets a Supabase-issued token.
   GAS can only recognise it through bridgeHydrateAdminSession_, which needs the
   username — so handleGetFile must pass both, or every admin content read is
   refused and the console treats it as an expired session. */
(function () {
  var seen = [];
  var ctx = vm.createContext({
    console: console,
    SpreadsheetApp: { BandingTheme: { PINK: 1, BLUE: 1, LIGHT_GREY: 1 } },
    PropertiesService: {
      getScriptProperties: function () { return { getProperty: function () { return null; }, setProperty: function () {} }; },
      getUserProperties: function () { return { getProperty: function () { return null; } }; }
    },
    Utilities: { getUuid: function () { return 'u'; } },
    DriveApp: {}, CacheService: { getScriptCache: function () { return {}; } },
    Session: { getActiveUser: function () { return { getEmail: function () { return ''; } }; } },
    HtmlService: { createHtmlOutputFromFile: function () { return {}; } }
  });
  vm.runInContext(fs.readFileSync(require('path').join(__dirname, '..', 'gas', 'code.gs'), 'utf8'), ctx);
  vm.runInContext('checkAdmin_ = function (p) { __seen.push(p); return null; };', Object.assign(ctx, { __seen: seen }));
  vm.runInContext('authUser_ = function () { return { ok: false, error: { success: false, error: "x", sessionInvalid: true } }; };', ctx);

  vm.runInContext('handleGetFile({ fileId: "abc123", adminToken: "tok", username: "admin" })', ctx);
  assert.equal(seen.length, 1, 'an admin token must be checked');
  assert.equal(seen[0].adminToken, 'tok');
  assert.equal(seen[0].username, 'admin',
    'the username must travel with the token so the Supabase bridge can hydrate the session');

  console.log('GAS admin content read: all assertions passed');
})();
