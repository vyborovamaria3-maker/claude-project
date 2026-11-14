import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const required = ["APP_DATABASE_URL", "MIGRATOR_DATABASE_URL", "READONLY_DATABASE_URL"];
for (const key of required) {
  if (!process.env[key]) throw new Error(key + " is required");
}

const createClient = (url) => new PrismaClient({ datasources: { db: { url } } });
const app = createClient(process.env.APP_DATABASE_URL);
const migrator = createClient(process.env.MIGRATOR_DATABASE_URL);
const readonly = createClient(process.env.READONLY_DATABASE_URL);

async function roleState(client) {
  const rows = await client.$queryRawUnsafe(`
    SELECT current_user AS role,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
           has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
           has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
           current_setting('default_transaction_read_only') AS default_read_only
  `);
  return rows[0];
}

try {
  const migratorState = await roleState(migrator);
  assert.equal(migratorState.role, "solsub_migrator");
  assert.equal(migratorState.is_superuser, false);
  assert.equal(migratorState.database_create, false);
  assert.equal(migratorState.schema_create, true);

  const appState = await roleState(app);
  assert.equal(appState.role, "solsub_app");
  assert.equal(appState.is_superuser, false);
  assert.equal(appState.database_create, false);
  assert.equal(appState.schema_create, false);
  assert.equal(appState.default_read_only, "off");

  const readonlyState = await roleState(readonly);
  assert.equal(readonlyState.role, "solsub_readonly");
  assert.equal(readonlyState.is_superuser, false);
  assert.equal(readonlyState.database_create, false);
  assert.equal(readonlyState.schema_create, false);
  assert.equal(readonlyState.default_read_only, "on");

  const plan = await app.subscriptionPlan.findUnique({ where: { id: "BASIC" } });
  assert.ok(plan, "migration seed must create the BASIC plan");

  // Runtime can perform ordinary DML.
  const smokeTelegramId = "role-smoke-" + Date.now();
  const user = await app.user.create({
    data: { telegramId: smokeTelegramId, firstName: "Database role smoke test" }
  });
  await app.user.delete({ where: { id: user.id } });
  await app.subscriptionPlan.update({
    where: { id: "BASIC" },
    data: { description: plan.description }
  });

  // Read-only access works, but a write must be rejected.
  const visiblePlans = await readonly.subscriptionPlan.findMany();
  assert.ok(visiblePlans.length > 0);
  let readonlyWriteRejected = false;
  try {
    await readonly.subscriptionPlan.update({
      where: { id: "BASIC" },
      data: { description: plan.description + " must-not-write" }
    });
  } catch {
    readonlyWriteRejected = true;
  }
  assert.equal(readonlyWriteRejected, true, "read-only role unexpectedly updated a plan");

  // Runtime DML must not imply schema ownership or DDL rights.
  let runtimeDdlRejected = false;
  try {
    await app.$executeRawUnsafe("CREATE TABLE public.role_smoke_runtime_ddl (id integer)");
  } catch {
    runtimeDdlRejected = true;
  }
  assert.equal(runtimeDdlRejected, true, "runtime role unexpectedly created a table");

  console.log("SolSub migrations, app DML, read-only SELECT and schema privilege boundaries verified.");
} finally {
  await Promise.all([app.$disconnect(), migrator.$disconnect(), readonly.$disconnect()]);
}
