import pg from "pg";

const { Client } = pg;
const connectionString = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("MIGRATION_DATABASE_URL is required");

const rolePattern = /^[a-z_][a-z0-9_]{0,62}$/;
const roles = {
  public: process.env.POSTGRES_PUBLIC_ROLE || "nara_public",
  admin: process.env.POSTGRES_ADMIN_ROLE || "nara_admin",
  worker: process.env.POSTGRES_WORKER_ROLE || "nara_worker",
};
const passwords = {
  public: process.env.POSTGRES_PUBLIC_PASSWORD,
  admin: process.env.POSTGRES_ADMIN_PASSWORD,
  worker: process.env.POSTGRES_WORKER_PASSWORD,
};
const workerTables = [
  "admin_account_login_failures",
  "admin_ip_login_failures",
  "event_activity_rollups",
  "event_reward_payouts",
  "event_rollup_cleanup_queue",
  "member_account_login_failures",
  "member_activity_stats",
  "member_ip_login_failures",
  "nara_schema_migrations",
  "outbox_jobs",
  "point_ledger",
  "post_comments",
  "post_poll_options",
  "post_poll_votes",
  "post_polls",
  "post_recommendations",
  "post_reports",
  "post_stats",
  "posts",
  "site_settings",
  "support_stats",
  "uploaded_media",
  "uploaded_media_references",
  "users",
];

const identifier = (value) => {
  if (!rolePattern.test(value)) throw new Error(`Invalid PostgreSQL role name: ${value}`);
  return `"${value}"`;
};
const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

for (const [surface, role] of Object.entries(roles)) {
  if (!passwords[surface] || passwords[surface].length < 24) {
    throw new Error(`POSTGRES_${surface.toUpperCase()}_PASSWORD must contain at least 24 characters`);
  }
  identifier(role);
}

const client = new Client({
  connectionString,
  ssl: process.env.POSTGRES_SSL === "disable" ? false : { rejectUnauthorized: false },
  application_name: "nara001-role-provisioner",
});
await client.connect();
try {
  await client.query("BEGIN");
  const databaseResult = await client.query("SELECT current_database() AS name");
  const databaseName = databaseResult.rows[0]?.name;
  if (!databaseName) throw new Error("Unable to resolve the target PostgreSQL database");
  for (const [surface, role] of Object.entries(roles)) {
    const name = identifier(role);
    const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]);
    if (!exists.rowCount) await client.query(`CREATE ROLE ${name} LOGIN PASSWORD ${literal(passwords[surface])}`);
    else await client.query(`ALTER ROLE ${name} LOGIN PASSWORD ${literal(passwords[surface])}`);
    await client.query(`ALTER ROLE ${name} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
    await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${name}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${name}`);
    await client.query(`REVOKE CREATE ON SCHEMA public FROM ${name}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${name}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${name}`);
  }
  await client.query(`
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public
    TO ${identifier(roles.admin)}
  `);
  await client.query(`
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public
    TO ${identifier(roles.admin)}
  `);
  await client.query(`
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public
    TO ${identifier(roles.public)}
  `);
  await client.query(`
    REVOKE ALL ON TABLE
      admin_owners,admin_account_login_failures,admin_ip_login_failures,
      migration_audit,nara_schema_migrations
    FROM ${identifier(roles.public)}
  `);
  await client.query(`GRANT SELECT ON TABLE nara_schema_migrations TO ${identifier(roles.public)}`);
  await client.query(`
    GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE
      ${workerTables.map(quoteIdentifier).join(",")}
    TO ${identifier(roles.worker)}
  `);
  await client.query(`
    REVOKE INSERT,UPDATE,DELETE ON TABLE nara_schema_migrations
    FROM ${identifier(roles.worker)}
  `);
  await client.query(`
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public
    TO ${identifier(roles.public)},${identifier(roles.worker)}
  `);
  await client.query("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC");
  await client.query(`
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public
    TO ${identifier(roles.public)},${identifier(roles.admin)},${identifier(roles.worker)}
  `);
  await client.query(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL ON TABLES FROM PUBLIC
  `);
  await client.query(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL ON SEQUENCES FROM PUBLIC
  `);
  await client.query(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${identifier(roles.admin)}
  `);
  await client.query(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE,SELECT ON SEQUENCES TO ${identifier(roles.admin)}
  `);
  await client.query(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC
  `);
  await client.query(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO ${identifier(roles.admin)}
  `);
  await client.query("COMMIT");
  console.log(JSON.stringify({ provisioned: roles }));
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
