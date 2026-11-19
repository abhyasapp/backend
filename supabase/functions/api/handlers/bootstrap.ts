// handlers/bootstrap.ts — one request for everything the app needs at start-up.
//
// The app used to open with a chain of separate calls (session check, settings,
// corrections, weekly sets, …), each its own HTTPS round trip with its own auth
// read. `bootstrap` does them in one request.
//
// ORDER MATTERS: checksession may ROTATE the session token (when fewer than 7 days
// remain). Anything run in parallel with it would present the old token and be
// rejected, so the session check runs first and the rest run in parallel with the
// token it returns.

import { json } from '../_shared/http.ts';
import * as Auth from './auth.ts';
import * as Reports from './reports.ts';
import * as Weekly from './weekly.ts';
import * as QState from './qstate.ts';

export const CAPABILITIES = [
  'bootstrap', 'qid-weekly', 'qstate', 'recordanswers', 'qidpatches', 'resolveqids', 'rev-concurrency',
];

async function part(p: Promise<Response>): Promise<unknown> {
  try { return await (await p).json(); } catch { return { success: false, error: 'unavailable' }; }
}

export async function bootstrap(params: Record<string, unknown>) {
  const session: any = await part(Auth.checksession(params));
  if (!session || !session.success) return json(session || { success: false, error: 'Session expired. Please log in again.', sessionInvalid: true });

  const p2 = { ...params, token: session.token };
  const wantQstate = params.qstateSince !== undefined;
  const [settings, corrections, weekly, qstate] = await Promise.all([
    part(Auth.getsettings()),
    part(Reports.getcorrections({ ...p2, since: params.correctionsSince })),
    part(Weekly.listweeklysets(p2)),
    wantQstate ? part(QState.syncqstate({ ...p2, since: params.qstateSince, limit: params.qstateLimit })) : Promise.resolve(null),
  ]);
  return json({
    success: true, serverNow: new Date().toISOString(), capabilities: CAPABILITIES,
    session, settings, corrections, weekly, qstate,
  });
}
