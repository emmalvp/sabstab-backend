/**
 * Carga exercises-db.json en la tabla `ejercicios` de Postgres a mano.
 * Idempotente (ON CONFLICT DO UPDATE, ver db.js sembrarEjercicios) — el
 * servidor ya hace esto mismo en cada arranque (ver db.js migrar()), así
 * que este script es solo para sincronizar sin reiniciar el servidor.
 *   node seed-exercises.js
 */
const db = require("./db");

db.sembrarEjercicios()
  .then(() => {
    console.log("Ejercicios sembrados.");
    return db.pool.end();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
