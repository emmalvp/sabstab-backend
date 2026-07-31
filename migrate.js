/**
 * Aplica sweetswank-schema.sql contra DATABASE_URL. Todas las sentencias
 * usan IF NOT EXISTS, así que correr esto de nuevo en cada deploy es
 * seguro — no falla si las tablas ya existen.
 *   node migrate.js
 */
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sql = fs.readFileSync(path.join(__dirname, "sweetswank-schema.sql"), "utf8");
  await pool.query(sql);
  console.log("Schema aplicado.");
  await pool.end();
}

main().catch((err) => {
  console.error("Falló la migración:", err.message);
  process.exit(1);
});
