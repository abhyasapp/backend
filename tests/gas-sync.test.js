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
  USERS_SHEET:'Users',ADMINS_SHEET:'Admins',ADMIN_PERMS_SHEET:'AP',SETTINGS_SHEET:'S',PAYMENTS_SHEET:'P',PROGRESS_SHEET:'Pr',PROGRESS_HISTORY_SHEET:'PH',PROGRESS_BACKUPS_SHEET:'PB',PUSHTOKENS_SHEET:'PT',WEEKLYSETS_SHEET:'WS',WEEKLYSTARTS_SHEET:'WSt',WEEKLYATTEMPTS_SHEET:'WA',QREPORTS_SHEET:'Q',SUBJ_SUBMISSIONS_SHEET:'SS',STUDYDOCS_SHEET:'SD',
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
