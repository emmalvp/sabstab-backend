/**
 * Carga exercises-db.json en la tabla `ejercicios` de Postgres.
 * Idempotente: ON CONFLICT (id) DO UPDATE, así se puede correr de nuevo
 * cada vez que se edite el catálogo en el JSON.
 *   node seed-exercises.js
 */
const fs = require("fs");
const path = require("path");
const db = require("./db");

async function main() {
  const { ejercicios } = JSON.parse(fs.readFileSync(path.join(__dirname, "exercises-db.json"), "utf8"));
  for (const ej of ejercicios) {
    await db.pool.query(
      `INSERT INTO ejercicios (id, nombre, nombre_en, patron, musculo_primario, musculos_secundarios, angulo_grados, equipo_necesario, unilateral, agarre, contraindicaciones)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         nombre = EXCLUDED.nombre,
         nombre_en = EXCLUDED.nombre_en,
         patron = EXCLUDED.patron,
         musculo_primario = EXCLUDED.musculo_primario,
         musculos_secundarios = EXCLUDED.musculos_secundarios,
         angulo_grados = EXCLUDED.angulo_grados,
         equipo_necesario = EXCLUDED.equipo_necesario,
         unilateral = EXCLUDED.unilateral,
         agarre = EXCLUDED.agarre,
         contraindicaciones = EXCLUDED.contraindicaciones`,
      [ej.id, ej.nombre, ej.nombreEn || null, ej.patron, ej.musculoPrimario, ej.musculosSecundarios, ej.anguloGrados, ej.equipoNecesario, ej.unilateral, ej.agarre || null, ej.contraindicaciones]
    );
  }
  console.log(`Sembrados ${ejercicios.length} ejercicios.`);
  await db.pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
