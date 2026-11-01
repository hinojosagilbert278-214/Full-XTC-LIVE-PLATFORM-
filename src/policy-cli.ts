// Two-person accounting policy administration. Each administrator connects with THEIR OWN database login
// (POLICY_DATABASE_URL), which must be a direct member of xtc_policy_admin. The database derives identity from the
// authenticated session (session_user); nothing here supplies an actor name.
//   npm run policy -- list
//   npm run policy -- propose <key> <value>
//   npm run policy -- approve <proposalId>
//   npm run policy -- reject <proposalId>
import pg from "pg";

const url = process.env.POLICY_DATABASE_URL;
if (!url) { console.error("POLICY_DATABASE_URL (your personal policy-admin login) is required"); process.exit(2); }
const [cmd, a, b] = process.argv.slice(2);
const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const who = (await c.query("SELECT session_user AS u")).rows[0].u;
  if (cmd === "list") {
    console.table((await c.query("SELECT key, value, approved_by, version FROM accounting_policy ORDER BY key")).rows);
    console.table((await c.query("SELECT id, key, value, proposed_by, status, decided_by FROM policy_proposals ORDER BY id DESC LIMIT 20")).rows);
  } else if (cmd === "propose" && a && b) {
    console.log(`${who} proposed #${(await c.query("SELECT propose_policy($1,$2) AS id", [a, b])).rows[0].id}`);
  } else if (cmd === "approve" && a) {
    await c.query("SELECT approve_policy_proposal($1)", [Number(a)]); console.log(`${who} approved #${a}`);
  } else if (cmd === "reject" && a) {
    await c.query("SELECT reject_policy_proposal($1)", [Number(a)]); console.log(`${who} rejected #${a}`);
  } else { console.error("usage: policy list | propose <key> <value> | approve <id> | reject <id>"); process.exitCode = 2; }
} catch (e) { console.error(`refused by database: ${(e as Error).message}`); process.exitCode = 1; }
finally { await c.end(); }
