// supabase/functions/api/index.ts
// Function router — maps ?action= to a handler. All handlers return a Response.
// CORS is applied per-request via withCors() using the ALLOWED_ORIGINS allow-list.

import { ALLOWED_ORIGINS, FUNCTION_VERSION } from './_shared/config.ts';
import { json, SECURITY_HEADERS } from './_shared/http.ts';
import { supabase } from './_shared/db.ts';

import * as Auth from './handlers/auth.ts';
import * as Users from './handlers/users.ts';
import * as Content from './handlers/content.ts';
import * as Weekly from './handlers/weekly.ts';
import * as Reports from './handlers/reports.ts';
import * as Admin from './handlers/admin.ts';
import * as Subj from './handlers/subjective.ts';
import * as Payments from './handlers/payments.ts';
import * as QState from './handlers/qstate.ts';
import * as Bootstrap from './handlers/bootstrap.ts';
import * as Pipeline from './handlers/pipeline.ts';

// ── Route table ────────────────────────────────────────────────────────
const ROUTES: Record<string, (params: any, req: Request) => Promise<Response>> = {

  // ── Health & Public ────────────────────────────────────────────────
  'ping': Auth.ping,
  'health': async () => {
    let users = 0, admins = 0;
    try {
      const [u, a] = await Promise.all([
        supabase.from('users').select('*', { count: 'exact', head: true }),
        supabase.from('admins').select('*', { count: 'exact', head: true }),
      ]);
      users = u.count ?? 0;
      admins = a.count ?? 0;
    } catch (e) {
      console.error('[health] count query failed:', e);
    }
    return json({
      success: true,
      backend: 'supabase',
      version: FUNCTION_VERSION,
      timestamp: new Date().toISOString(),
      checks: { users, admins },
    });
  },

  // ── Auth & Public ──────────────────────────────────────────────────
  'login': Auth.login,
  'googlelogin': Auth.googlelogin,
  'signup': Auth.signup,
  'checksession': Auth.checksession,
  'logoutotherdevices': Auth.logoutotherdevices,
  'checkadmincapable': Auth.checkadmincapable,
  'adminswitchfromuser': Auth.adminswitchfromuser,
  'adminlogin': Auth.adminlogin,
  'logclienterror': Auth.logclienterror,
  'getpublicinfo': Auth.getpublicinfo,
  'getsettings': Auth.getsettings,
  'getcontentkey': Auth.getcontentkey,

  // ── Users (self-service) ───────────────────────────────────────────
  'saveprogress': Users.saveprogress,
  'getprogress': Users.getprogress,
  'getprogresshistory': Users.getprogresshistory,
  'updateownmobile': Users.updateownmobile,
  'updateprofile': Users.updateprofile,
  'changepassword': Users.changepassword,
  'resetmyprogress': Users.resetmyprogress,
  'deletemyaccount': Users.deletemyaccount,

  // ── Content ────────────────────────────────────────────────────────
  'getfile': Content.getfile,
  'getfiles': Content.getfiles,

  // ── Weekly Tests ───────────────────────────────────────────────────
  'listweeklysets': Weekly.listweeklysets,
  'startweeklyattempt': Weekly.startweeklyattempt,
  'getweeklyattempt': Weekly.getweeklyattempt,
  'getmyweeklyattempts': Weekly.getmyweeklyattempts,
  'submitweeklyattempt': Weekly.submitweeklyattempt,
  'getweeklystanding': Weekly.getweeklystanding,
  'admincreateweeklyset': Weekly.admincreateweeklyset,
  'adminupdateweeklyset': Weekly.adminupdateweeklyset,
  'admindeleteweeklyset': Weekly.admindeleteweeklyset,
  'adminlistweeklysets': Weekly.adminlistweeklysets,
  'adminweeklysetresults': Weekly.adminweeklysetresults,
  'adminrescoreweeklyset': Weekly.adminrescoreweeklyset,
  // ── qid-centric (docs/QID-CONTRACT.md) ──
  'bootstrap': Bootstrap.bootstrap,
  'syncqstate': QState.syncqstate,
  'recordanswers': QState.recordanswers,
  'getqidpatches': QState.getqidpatches,
  'resolveqids': QState.resolveqids,
  'adminqidcoverage': QState.adminqidcoverage,
  'ingestquestionindex': QState.ingestquestionindex,
  'rebuildqidstats': QState.rebuildqidstats,

  // ── Reports & Corrections ──────────────────────────────────────────
  'reportquestion': Reports.reportquestion,
  'getmyreports': Reports.getmyreports,
  'myquestionreports': Reports.myquestionreports,
  'getcorrections': Reports.getcorrections,
  'gethardquestions': Reports.gethardquestions,
  'adminlistquestionreports': Reports.adminlistquestionreports,
  'listreports': Reports.adminlistquestionreports,               // alias
  'adminupdatequestionreportstatus': Reports.adminupdatequestionreportstatus,
  'resolvereport': Reports.adminupdatequestionreportstatus,      // alias
  'admindeletequestionreport': Reports.admindeletequestionreport,
  'getreport': Reports.getreport,
  'admingetquestion': Reports.admingetquestion,
  'adminupdatequestion': Reports.adminupdatequestion,
  'adminapplycorrections': Reports.adminapplycorrections,
  'adminlistcorrections': Reports.adminlistcorrections,
  'adminlistcorrectionevents': Reports.adminlistcorrectionevents,
  'adminbackfillreportqids': Reports.adminbackfillreportqids,
  'adminexportcorrections': Reports.adminexportcorrections,
  'adminmarkfilecorrected': Reports.adminmarkfilecorrected,
  'synccorrectionssince': Reports.synccorrectionssince,
  'syncreportssince': Pipeline.syncreportssince,
  'resolvereports': Pipeline.resolvereports,
  'admincorrect': Pipeline.admincorrect,
  'clearreports': Reports.clearreports,
  'adminmostmissedquestions': Reports.adminmostmissedquestions,
  'adminuploadweeklysetfile': Reports.adminuploadweeklysetfile,
  'adminuploadsubjectivefile': Reports.adminuploadsubjectivefile,
  'admincommitsubjectiveimport': Reports.admincommitsubjectiveimport,

  // ── Subjective & Study Docs ────────────────────────────────────────
  'adminlistsubjectivesubmissions': Subj.adminlistsubjectivesubmissions,
  'admingradesubjectivesubmission': Subj.admingradesubjectivesubmission,
  'admindownloadsubmissionpdf': Subj.admindownloadsubmissionpdf,
  'adminreplacesubmissionpdf': Subj.adminreplacesubmissionpdf,
  'getsubjectiveuploadurl': Subj.getsubjectiveuploadurl,
  'submitsubjectiveanswer': Subj.submitsubjectiveanswer,
  'getmysubjectivesubmissions': Subj.getmysubjectivesubmissions,
  'getmysubmissionpdf': Subj.getmysubmissionpdf,
  'getstudydocuploadurl': Subj.getstudydocuploadurl,
  'adminliststudydocs': Subj.adminliststudydocs,
  'adminaddstudydoc': Subj.adminaddstudydoc,
  'adminupdatestudydoc': Subj.adminupdatestudydoc,
  'admindeletestudydoc': Subj.admindeletestudydoc,
  'admindownloadstudydoc': Subj.admindownloadstudydoc,
  'liststudydocs': Subj.liststudydocs,
  'getstudydocpdf': Subj.getstudydocpdf,

  // ── Admin Core & Dashboard ─────────────────────────────────────────
  'adminstats': Admin.adminstats,
  'admintrends': Admin.admintrends,
  'adminexpiringtrials': Admin.adminexpiringtrials,
  'adminlistlogs': Admin.adminlistlogs,

  // ── Admin Users ────────────────────────────────────────────────────
  'adminlistusers': Admin.adminlistusers,
  'admingetstudentoverview': Admin.admingetstudentoverview,
  'adminupdateuser': Admin.adminupdateuser,
  'admingrantaccess': Admin.admingrantaccess,
  'admingrantaccessbatch': Admin.admingrantaccessbatch,
  'admindeleteuser': Admin.admindeleteuser,
  'admindeleteusersbatch': Admin.admindeleteusersbatch,

  // ── Admin Payments ─────────────────────────────────────────────────
  'adminlistpayments': Admin.adminlistpayments,
  'adminreviewpayment': Payments.adminreviewpayment,             // single-review
  'adminreviewpaymentsbatch': Admin.adminreviewpaymentsbatch,
  'admindeletepayment': Admin.admindeletepayment,
  'admindownloadscreenshot': Admin.admindownloadscreenshot,
  'adminrevokescreenshotsharing': Admin.adminrevokescreenshotsharing,
  'getpaymentuploadurl': Admin.getpaymentuploadurl,
  'getpaymentstatus': Admin.getpaymentstatus,
  'submitpayment': Payments.submitpayment,

  // ── Admin Maintenance & Settings ───────────────────────────────────
  'adminclearprogressbackups': Admin.adminclearprogressbackups,
  'adminpruneoldbackups': Admin.adminpruneoldbackups,
  'admintrimlogs': Admin.admintrimlogs,
  'admingetsettings': Admin.admingetsettings,
  'adminupdatesettings': Admin.adminupdatesettings,
  'adminupdatesettingsbatch': Admin.adminupdatesettingsbatch,

  // ── Admin Accounts ─────────────────────────────────────────────────
  'adminlistadmins': Admin.adminlistadmins,
  'admingetpermissions': Admin.admingetpermissions,
  'adminlistadminpermissions': Admin.adminlistadminpermissions,
  'adminsetadminpermissions': Admin.adminsetadminpermissions,
  'admincreateadmin': Admin.admincreateadmin,
  'admindeleteadmin': Admin.admindeleteadmin,
  'adminpromoteowner': Admin.adminpromoteowner,
  'admindemoteowner': Admin.admindemoteowner,
  'adminresetadminpassword': Admin.adminresetadminpassword,
  'adminpromoteusertoadmin': Admin.adminpromoteusertoadmin,
  'adminchangepassword': Admin.adminchangepassword,

  // ── Admin Imports & Push ───────────────────────────────────────────
  'adminimportprogress': Admin.adminimportprogress,
  'adminimportstatus': Admin.adminimportstatus,
  'savepushtoken': Admin.savepushtoken,

  // ── Stubs — still handled by Google Apps Script ────────────────────
  'resendverification': async () =>
    json({ success: false, migrationPending: true, error: "Route 'resendverification' to GAS." }),
  'verifyemail': async () =>
    json({ success: false, migrationPending: true, error: "Route 'verifyemail' to GAS." }),
  'requestpasswordreset': async () =>
    json({ success: false, migrationPending: true, error: "Route 'requestpasswordreset' to GAS." }),
  'resetpassword': async () =>
    json({ success: false, migrationPending: true, error: "Route 'resetpassword' to GAS." }),
};

// ── CORS wrapper ───────────────────────────────────────────────────────
function withCors(req: Request, res: Response): Response {
  const origin = req.headers.get('origin') || '';
  const headers = new Headers(res.headers);
  headers.delete('Access-Control-Allow-Origin');
  headers.delete('Access-Control-Allow-Methods');
  headers.delete('Access-Control-Allow-Headers');
  headers.set('Vary', 'Origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
  }
  headers.set('Access-Control-Max-Age', '86400');
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(res.body, { status: res.status, headers });
}

// ── Server ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  // Preflight — routed through withCors so the allow-list applies.
  if (req.method === 'OPTIONS') {
    return withCors(req, new Response('ok', { status: 200 }));
  }

  // Collect parameters from JSON body (POST) and query string (GET/any).
  // Body wins; query params fill any gaps.
  let params: Record<string, unknown> = {};
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      // Only a plain JSON object is a valid parameter bag (null/array/string would crash below).
      if (body && typeof body === 'object' && !Array.isArray(body)) params = body as Record<string, unknown>;
    } catch { /* empty body → {} */ }
  }
  const url = new URL(req.url);
  for (const [k, v] of url.searchParams.entries()) {
    if (!(k in params)) params[k] = v;
  }

  const action = String(params.action || '').toLowerCase();
  // Own-property lookup so inherited names such as 'constructor' are never treated as routes.
  const handler = Object.hasOwn(ROUTES, action) ? ROUTES[action] : undefined;

  if (!handler) {
    // HTTP 200 (not 404) with migrationPending so the client's fallback logic
    // retries the action on the Apps Script backend instead of treating it as
    // a hard network error.
    return withCors(
      req,
      json({ success: false, migrationPending: true, unknownAction: true, error: `Unknown action: '${action}'.` }),
    );
  }

  try {
    const response = await handler(params, req);
    return withCors(req, response);
  } catch (e) {
    console.error(`[Unhandled Error] Action: ${action}`, e);
    return withCors(req, json({ success: false, error: 'Server error. Please try again.' }, 500));
  }
});