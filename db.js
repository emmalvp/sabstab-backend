/**
 * SabStab — acceso a datos sobre PostgreSQL real, usando exactamente
 * las tablas de sweetswank-schema.sql. Cada función mapea las columnas
 * snake_case del schema a los nombres camelCase que usan engine.js y
 * server.js. DATABASE_URL apunta al Postgres local por defecto (ver
 * README) — en producción, apunta a un Postgres real vía variable de
 * entorno.
 */
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://localhost:5432/sweetswank",
});

// Migraciones idempotentes que corren en cada arranque del servidor — así
// no dependemos de aplicar sweetswank-schema.sql a mano en producción cada
// vez que se agrega una columna (ver server.js `start()`).
async function migrar() {
  await pool.query(`ALTER TABLE rutinas_dia ADD COLUMN IF NOT EXISTS fecha_local DATE NOT NULL DEFAULT CURRENT_DATE`);
  await pool.query(`ALTER TABLE rutinas_dia ADD COLUMN IF NOT EXISTS perfil_id UUID REFERENCES perfiles(id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rutinas_dia_usuario_fecha ON rutinas_dia(user_id, nombre_dia, fecha_local)`);
  await pool.query(`ALTER TABLE perfiles ADD COLUMN IF NOT EXISTS dias_descanso_preferidos SMALLINT[]`);
  await pool.query(`ALTER TABLE ejercicios ADD COLUMN IF NOT EXISTS postura TEXT`);
  await pool.query(`ALTER TABLE ejercicios DROP CONSTRAINT IF EXISTS ejercicios_postura_check`);
  await pool.query(
    `ALTER TABLE ejercicios ADD CONSTRAINT ejercicios_postura_check CHECK (postura IN ('de_pie','sentado','acostado','colgado','de_rodillas'))`
  );
  await pool.query(`ALTER TABLE ejercicios DROP CONSTRAINT IF EXISTS ejercicios_patron_check`);
  await pool.query(`ALTER TABLE ejercicios ADD CONSTRAINT ejercicios_patron_check CHECK (patron IN (
    'empuje_horizontal', 'empuje_vertical',
    'traccion_horizontal', 'traccion_vertical',
    'sentadilla', 'bisagra_cadera', 'core',
    'extension_codo', 'abduccion_hombro', 'flexion_codo',
    'elevacion_posterior_hombro', 'flexion_plantar'
  ))`);
  await sembrarEjercicios();
}

// Sincroniza la tabla `ejercicios` con exercises-db.json en cada arranque
// (ON CONFLICT DO UPDATE, idempotente) — así agregar/editar ejercicios en
// el JSON y hacer deploy es suficiente, sin correr `node seed-exercises.js`
// a mano contra producción cada vez (antes era el único camino y era fácil
// de olvidar, dejando el catálogo real desincronizado del JSON del repo).
async function sembrarEjercicios() {
  const { ejercicios } = JSON.parse(fs.readFileSync(path.join(__dirname, "exercises-db.json"), "utf8"));
  for (const ej of ejercicios) {
    await pool.query(
      `INSERT INTO ejercicios (id, nombre, nombre_en, patron, musculo_primario, musculos_secundarios, angulo_grados, equipo_necesario, unilateral, agarre, contraindicaciones, postura)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
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
         contraindicaciones = EXCLUDED.contraindicaciones,
         postura = EXCLUDED.postura`,
      [
        ej.id, ej.nombre, ej.nombreEn || null, ej.patron, ej.musculoPrimario, ej.musculosSecundarios, ej.anguloGrados,
        ej.equipoNecesario, ej.unilateral, ej.agarre || null, ej.contraindicaciones, ej.postura || null,
      ]
    );
  }
}

class EmailEnUsoError extends Error {
  constructor() {
    super("Ese correo ya está registrado");
    this.name = "EmailEnUsoError";
  }
}

// Ejecuta varias escrituras relacionadas de forma atómica (BEGIN/COMMIT,
// ROLLBACK si algo falla) — evita dejar filas a medio guardar cuando un
// flujo hace varios INSERT/UPDATE seguidos (ej. cerrar el perfil viejo +
// crear el nuevo + registrar lesiones y 1RM en PUT /profile).
async function transaccion(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const resultado = await fn(client);
    await client.query("COMMIT");
    return resultado;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------
// USUARIOS
// ---------------------------------------------------------------------
async function crearUsuario({ email, passwordHash, nombre, idioma = "en", unidadPeso = "lb" }) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, nombre, idioma, unidad_peso) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, nombre, idioma, unidad_peso AS "unidadPeso"`,
      [email, passwordHash, nombre, idioma, unidadPeso]
    );
    return rows[0];
  } catch (err) {
    if (err.code === "23505") throw new EmailEnUsoError();
    throw err;
  }
}

async function buscarUsuarioPorEmail(email) {
  const { rows } = await pool.query(
    `SELECT id, email, password_hash AS "passwordHash", apple_user_id AS "appleUserId", nombre, idioma, unidad_peso AS "unidadPeso"
     FROM users WHERE LOWER(email) = LOWER($1)`,
    [email]
  );
  return rows[0] || null;
}

async function buscarUsuarioPorId(id) {
  const { rows } = await pool.query(
    `SELECT id, email, password_hash AS "passwordHash", apple_user_id AS "appleUserId", nombre, idioma, unidad_peso AS "unidadPeso"
     FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function crearUsuarioApple({ email, appleUserId, nombre, idioma = "en", unidadPeso = "lb" }) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email, apple_user_id, nombre, idioma, unidad_peso) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, nombre, idioma, unidad_peso AS "unidadPeso"`,
      [email, appleUserId, nombre, idioma, unidadPeso]
    );
    return rows[0];
  } catch (err) {
    if (err.code === "23505") throw new EmailEnUsoError();
    throw err;
  }
}

async function buscarUsuarioPorAppleId(appleUserId) {
  const { rows } = await pool.query(
    `SELECT id, email, apple_user_id AS "appleUserId", nombre, idioma, unidad_peso AS "unidadPeso"
     FROM users WHERE apple_user_id = $1`,
    [appleUserId]
  );
  return rows[0] || null;
}

async function vincularAppleId(userId, appleUserId) {
  await pool.query(`UPDATE users SET apple_user_id = $1 WHERE id = $2`, [appleUserId, userId]);
}

async function actualizarPassword(userId, passwordHash) {
  await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, userId]);
}

// Borra al usuario; todas las tablas relacionadas (perfiles, lesiones,
// registros_1rm, rutinas_dia, registros_sesion, dispositivos_conectados,
// password_reset_tokens) tienen ON DELETE CASCADE, así que esto basta
// para cumplir con el requisito de Google Play de eliminar cuenta y datos.
async function eliminarUsuario(userId) {
  const { rowCount } = await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  return rowCount === 1;
}

async function actualizarAjustesUsuario(id, cambios) {
  const columnas = { idioma: "idioma", unidadPeso: "unidad_peso", nombre: "nombre" };
  const sets = [];
  const valores = [];
  let i = 1;
  for (const [clave, columna] of Object.entries(columnas)) {
    if (cambios[clave] !== undefined) {
      sets.push(`${columna} = $${i++}`);
      valores.push(cambios[clave]);
    }
  }
  if (sets.length === 0) return;
  valores.push(id);
  await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${i}`, valores);
}

// ---------------------------------------------------------------------
// PERFIL
// ---------------------------------------------------------------------
async function perfilVigente(userId) {
  const { rows } = await pool.query(
    `SELECT id, altura_cm AS "alturaCm", femur_cm AS "femurCm", torso_cm AS "torsoCm", brazo_cm AS "brazoCm",
            edad, peso_corporal_kg AS "pesoCorporalKg",
            objetivo, nivel, dias_por_semana AS "diasPorSemana", duracion_sesion_min AS "duracionSesionMin",
            dias_descanso_preferidos AS "diasDescansoPreferidos",
            equipo_disponible AS "equipoDisponible", vigente_desde AS "vigenteDesde"
     FROM perfiles WHERE user_id = $1 AND vigente_hasta IS NULL`,
    [userId]
  );
  return rows[0] || null;
}

async function cerrarPerfilVigente(userId, client = pool) {
  await client.query(`UPDATE perfiles SET vigente_hasta = now() WHERE user_id = $1 AND vigente_hasta IS NULL`, [userId]);
}

async function crearPerfil(userId, p, client = pool) {
  const { rows } = await client.query(
    `INSERT INTO perfiles (user_id, altura_cm, femur_cm, torso_cm, brazo_cm, edad, peso_corporal_kg, objetivo, nivel, dias_por_semana, dias_descanso_preferidos, duracion_sesion_min, equipo_disponible)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id, vigente_desde AS "vigenteDesde"`,
    [
      userId, p.alturaCm, p.femurCm, p.torsoCm, p.brazoCm, p.edad, p.pesoCorporalKg, p.objetivo, p.nivel,
      p.diasPorSemana, p.diasDescansoPreferidos || null, p.duracionSesionMin, p.equipoDisponible,
    ]
  );
  return rows[0];
}

// ---------------------------------------------------------------------
// LESIONES
// ---------------------------------------------------------------------
// Cierra (resuelta_en = now()) todas las lesiones activas del usuario —
// se llama antes de insertar la lista nueva en cada PUT /profile, porque
// el cliente manda la lista COMPLETA de lesiones vigentes (agregar,
// editar o quitar una desde el wizard son todos "guardar esta lista
// completa"). Sin esto, quitar una lesión en el formulario no la
// desactivaba nunca (agregarLesiones solo inserta, nunca cierra), y
// editar/re-guardar la misma lesión duplicaba la fila en vez de
// reemplazarla — ambos aparecían como "no hace nada" o "se acumulan".
async function cerrarLesionesActivas(userId, client = pool) {
  await client.query(`UPDATE lesiones SET resuelta_en = now() WHERE user_id = $1 AND resuelta_en IS NULL`, [userId]);
}

async function agregarLesiones(userId, lesiones, client = pool) {
  for (const l of lesiones) {
    await client.query(
      `INSERT INTO lesiones (user_id, zona, lado, estado, movimiento_que_agrava) VALUES ($1,$2,$3,$4,$5)`,
      [userId, l.zona, l.lado, l.estado, l.movimientoQueAgrava || null]
    );
  }
}

async function lesionesActivasDeUsuario(userId) {
  const { rows } = await pool.query(
    `SELECT zona, lado, estado FROM lesiones WHERE user_id = $1 AND resuelta_en IS NULL`,
    [userId]
  );
  return rows;
}

// ---------------------------------------------------------------------
// 1RM
// ---------------------------------------------------------------------
async function agregarRegistro1RM(userId, levantamiento, valorKg, origen = "reportado", client = pool) {
  await client.query(
    `INSERT INTO registros_1rm (user_id, levantamiento, valor_kg, origen) VALUES ($1,$2,$3,$4)`,
    [userId, levantamiento, valorKg, origen]
  );
}

async function ultimoRegistro1RM(userId, levantamiento) {
  const { rows } = await pool.query(
    `SELECT valor_kg AS "valorKg" FROM registros_1rm
     WHERE user_id = $1 AND levantamiento = $2
     ORDER BY registrado_en DESC LIMIT 1`,
    [userId, levantamiento]
  );
  return rows[0]?.valorKg ? Number(rows[0].valorKg) : 0;
}

async function historial1RM(userId, levantamiento) {
  const { rows } = await pool.query(
    `SELECT registrado_en AS "fecha", valor_kg AS "valor" FROM registros_1rm
     WHERE user_id = $1 AND levantamiento = $2
     ORDER BY registrado_en ASC`,
    [userId, levantamiento]
  );
  return rows.map((r) => ({ fecha: r.fecha, valor: Number(r.valor) }));
}

// ---------------------------------------------------------------------
// EJERCICIOS (catálogo — poblado por seed-exercises.js desde exercises-db.json)
// ---------------------------------------------------------------------
async function todosLosEjercicios() {
  const { rows } = await pool.query(
    `SELECT id, nombre, nombre_en AS "nombreEn", patron, musculo_primario AS "musculoPrimario",
            musculos_secundarios AS "musculosSecundarios", angulo_grados AS "anguloGrados",
            equipo_necesario AS "equipoNecesario", unilateral, agarre, contraindicaciones, postura
     FROM ejercicios ORDER BY id`
  );
  return rows;
}

// ---------------------------------------------------------------------
// RUTINAS
// ---------------------------------------------------------------------
async function crearRutinaDia(userId, nombreDia, fechaLocal, perfilId = null, client = pool) {
  const { rows } = await client.query(
    `INSERT INTO rutinas_dia (user_id, nombre_dia, fecha_local, perfil_id) VALUES ($1,$2,COALESCE($3, CURRENT_DATE),$4) RETURNING id`,
    [userId, nombreDia, fechaLocal || null, perfilId]
  );
  return rows[0].id;
}

// Busca una rutina ya generada hoy para este usuario+día — evita que abrir
// la pestaña Rutina genere una rutina nueva cada vez (lo que descartaría
// sustituciones de ejercicio ya hechas). Ver comentario en el schema.
async function rutinaDiaDeHoy(userId, nombreDia, fechaLocal) {
  const { rows } = await pool.query(
    `SELECT id, perfil_id AS "perfilId" FROM rutinas_dia
     WHERE user_id = $1 AND nombre_dia = $2 AND fecha_local = COALESCE($3, CURRENT_DATE)
     ORDER BY generada_en DESC LIMIT 1`,
    [userId, nombreDia, fechaLocal || null]
  );
  return rows[0] || null;
}

async function limpiarEjerciciosNoIniciados(rutinaDiaId, userId, client = pool) {
  await client.query(
    `DELETE FROM rutina_ejercicios re
     USING rutinas_dia rd
     WHERE re.rutina_dia_id = $1 AND rd.id = re.rutina_dia_id AND rd.user_id = $2
       AND NOT EXISTS (SELECT 1 FROM registros_sesion rs WHERE rs.rutina_ejercicio_id = re.id)`,
    [rutinaDiaId, userId]
  );
}

async function marcarPerfilDeRutina(rutinaDiaId, userId, perfilId, client = pool) {
  await client.query(`UPDATE rutinas_dia SET perfil_id = $3 WHERE id = $1 AND user_id = $2`, [rutinaDiaId, userId, perfilId]);
}

async function agregarRutinaEjercicio(rutinaDiaId, re, client = pool) {
  const { rows } = await client.query(
    `INSERT INTO rutina_ejercicios (rutina_dia_id, ejercicio_id, orden, series, repeticiones, porcentaje_1rm, carga_kg, nota_biomecanica, advertencia_lesion)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [rutinaDiaId, re.ejercicioId, re.orden, re.series, re.repeticiones, re.porcentaje1RM, re.cargaKg, re.notaBiomecanica || null, re.advertenciaLesion || null]
  );
  return rows[0].id;
}

// Series ya registradas hoy para cada ejercicio de esta rutina del día —
// permite al cliente saber qué ejercicios (y qué tan de completa) ya se
// hicieron, para marcar el ejercicio/rutina como completado.
async function registrosDeRutinaDia(rutinaDiaId) {
  const { rows } = await pool.query(
    `SELECT rs.rutina_ejercicio_id AS "rutinaEjercicioId", rs.carga_usada_kg AS "cargaUsadaKg",
            rs.repeticiones_completadas AS "repeticionesCompletadas", rs.rpe, rs.completada_en AS "completadaEn"
     FROM registros_sesion rs
     JOIN rutina_ejercicios re ON re.id = rs.rutina_ejercicio_id
     WHERE re.rutina_dia_id = $1
     ORDER BY rs.completada_en ASC`,
    [rutinaDiaId]
  );
  return rows.map((r) => ({
    ...r,
    cargaUsadaKg: r.cargaUsadaKg != null ? Number(r.cargaUsadaKg) : null,
    rpe: r.rpe != null ? Number(r.rpe) : null,
  }));
}

async function rutinaDiaDeUsuario(rutinaDiaId, userId) {
  const { rows } = await pool.query(
    `SELECT id, nombre_dia AS "nombreDia" FROM rutinas_dia WHERE id = $1 AND user_id = $2`,
    [rutinaDiaId, userId]
  );
  return rows[0] || null;
}

async function ejerciciosDeRutinaDia(rutinaDiaId) {
  const { rows } = await pool.query(
    `SELECT id AS "rutinaEjercicioId", ejercicio_id AS "ejercicioId", orden, series, repeticiones,
            porcentaje_1rm AS "porcentaje1RM", carga_kg AS "cargaKg",
            nota_biomecanica AS "nota", advertencia_lesion AS "advertenciaLesion"
     FROM rutina_ejercicios WHERE rutina_dia_id = $1 ORDER BY orden ASC`,
    [rutinaDiaId]
  );
  return rows.map((r) => ({
    ...r,
    porcentaje1RM: r.porcentaje1RM != null ? Number(r.porcentaje1RM) : null,
    cargaKg: r.cargaKg != null ? Number(r.cargaKg) : null,
  }));
}

// ---------------------------------------------------------------------
// SESIONES / PROGRESO
// ---------------------------------------------------------------------
async function crearRegistroSesion(userId, s) {
  const { rows } = await pool.query(
    `INSERT INTO registros_sesion (user_id, rutina_ejercicio_id, carga_usada_kg, repeticiones_completadas, rpe, fuente)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [userId, s.rutinaEjercicioId, s.cargaUsadaKg, s.repeticionesCompletadas, s.rpe, s.fuente || "manual"]
  );
  return rows[0].id;
}

async function rutinaEjercicioPorId(id) {
  const { rows } = await pool.query(`SELECT repeticiones FROM rutina_ejercicios WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function rutinaEjercicioRegistrable(id, userId, fechaLocal) {
  const { rows } = await pool.query(
    `SELECT re.repeticiones, rd.fecha_local AS "fechaLocal",
            rd.fecha_local <= COALESCE($3::date, CURRENT_DATE) AS registrable
     FROM rutina_ejercicios re
     JOIN rutinas_dia rd ON rd.id = re.rutina_dia_id
     WHERE re.id = $1 AND rd.user_id = $2`,
    [id, userId, fechaLocal || null]
  );
  return rows[0] || null;
}

async function ultimoRegistroPorEjercicio(userId, ejercicioId) {
  const { rows } = await pool.query(
    `SELECT rs.carga_usada_kg AS "cargaUsadaKg",
            rs.repeticiones_completadas AS "repeticionesCompletadas",
            rs.rpe
     FROM registros_sesion rs
     JOIN rutina_ejercicios re ON re.id = rs.rutina_ejercicio_id
     WHERE rs.user_id = $1 AND re.ejercicio_id = $2
     ORDER BY rs.completada_en DESC LIMIT 1`,
    [userId, ejercicioId]
  );
  const r = rows[0];
  return r
    ? {
        cargaUsadaKg: r.cargaUsadaKg != null ? Number(r.cargaUsadaKg) : null,
        repeticionesCompletadas: Number(r.repeticionesCompletadas),
        rpe: r.rpe != null ? Number(r.rpe) : null,
      }
    : null;
}

// Rendimiento comparable por ejercicio y día. Usamos el mejor e1RM de
// cada sesión (Epley) para detectar una tendencia sin pedirle al usuario
// que vuelva a probar un 1RM máximo. Se limita a ocho semanas y cuatro
// exposiciones por ejercicio; es suficiente para detectar una meseta sin
// convertir una sesión aislada en una decisión de programa.
async function rendimientoRecientePorEjercicio(userId) {
  const { rows } = await pool.query(
    `WITH sesiones AS (
       SELECT re.ejercicio_id AS "ejercicioId",
              rd.fecha_local AS fecha,
              MAX(rs.carga_usada_kg * (1 + rs.repeticiones_completadas / 30.0)) AS valor,
              ROW_NUMBER() OVER (
                PARTITION BY re.ejercicio_id
                ORDER BY rd.fecha_local DESC
              ) AS posicion
       FROM registros_sesion rs
       JOIN rutina_ejercicios re ON re.id = rs.rutina_ejercicio_id
       JOIN rutinas_dia rd ON rd.id = re.rutina_dia_id
       WHERE rs.user_id = $1
         AND rs.carga_usada_kg > 0
         AND rs.repeticiones_completadas BETWEEN 1 AND 15
         AND rd.fecha_local >= CURRENT_DATE - INTERVAL '56 days'
       GROUP BY re.ejercicio_id, rd.fecha_local
     )
     SELECT "ejercicioId", fecha, valor
     FROM sesiones WHERE posicion <= 4
     ORDER BY "ejercicioId", fecha ASC`,
    [userId]
  );
  const porEjercicio = new Map();
  for (const row of rows) {
    if (!porEjercicio.has(row.ejercicioId)) porEjercicio.set(row.ejercicioId, []);
    porEjercicio.get(row.ejercicioId).push({ fecha: row.fecha, valor: Number(row.valor) });
  }
  return [...porEjercicio.values()];
}

// Sustituye el ejercicio de una fila de rutina_ejercicios por otro (ej.
// una alternativa elegida en la app porque el original estaba ocupado).
// Verifica dueño vía el join a rutinas_dia — nunca confiar en el id solo.
async function sustituirEjercicioDeRutina(rutinaEjercicioId, userId, nuevoEjercicioId) {
  const { rows } = await pool.query(
    `UPDATE rutina_ejercicios re
     SET ejercicio_id = $3
     FROM rutinas_dia rd
     WHERE re.id = $1 AND re.rutina_dia_id = rd.id AND rd.user_id = $2
     RETURNING re.id, re.ejercicio_id AS "ejercicioId"`,
    [rutinaEjercicioId, userId, nuevoEjercicioId]
  );
  return rows[0] || null;
}

// Reemplaza una prescripción que todavía no fue iniciada cuando el perfil
// cambia (equipo, objetivo, nivel o duración). Actualizar sólo ejercicio_id
// dejaría series/carga de la prescripción anterior, por eso se reemplaza la
// fila completa conservando su id y su posición visual.
async function actualizarPrescripcionRutina(rutinaEjercicioId, userId, p) {
  const { rows } = await pool.query(
    `UPDATE rutina_ejercicios re
     SET ejercicio_id = $3, series = $4, repeticiones = $5,
         porcentaje_1rm = $6, carga_kg = $7,
         nota_biomecanica = $8, advertencia_lesion = $9
     FROM rutinas_dia rd
     WHERE re.id = $1 AND re.rutina_dia_id = rd.id AND rd.user_id = $2
       AND NOT EXISTS (SELECT 1 FROM registros_sesion rs WHERE rs.rutina_ejercicio_id = re.id)
     RETURNING re.id`,
    [rutinaEjercicioId, userId, p.ejercicioId, p.series, p.repeticiones,
      p.porcentaje1RM, p.cargaKg, p.notaBiomecanica || null, p.advertenciaLesion || null]
  );
  return rows[0] || null;
}

// Una "sesión" es un día calendario con al menos una serie registrada —
// no hay botón de "terminar sesión" en la app, así que no existe un
// límite explícito entre una sesión y otra más que el propio día. Antes
// esto contaba filas de registros_sesion (series individuales), lo cual
// inflaba muchísimo el número real de sesiones entrenadas.
async function contarSesionesDeUsuario(userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT dia)::int AS n
     FROM (
       SELECT date_trunc('day', completada_en) AS dia FROM registros_sesion WHERE user_id = $1
       UNION
       SELECT date_trunc('day', iniciada_en) AS dia FROM sesiones_wearable WHERE user_id = $1
     ) sesiones`,
    [userId]
  );
  return rows[0].n;
}

// Volumen de entrenamiento (tonelaje: carga × repeticiones) de las
// últimas `semanas` semanas móviles (semana 0 = hace 0-7 días, la más
// reciente al final del array). Es la métrica estándar de volumen en
// entrenamiento de fuerza/hipertrofia — series×reps×carga.
async function volumenSemanal(userId, semanas = 8) {
  const { rows } = await pool.query(
    `SELECT floor(extract(epoch FROM (now() - completada_en)) / (7*86400))::int AS semanas_atras,
            SUM(COALESCE(carga_usada_kg, 0) * repeticiones_completadas) AS volumen
     FROM registros_sesion
     WHERE user_id = $1 AND completada_en >= now() - ($2 || ' weeks')::interval
     GROUP BY semanas_atras`,
    [userId, semanas]
  );
  const porSemana = new Array(semanas).fill(0);
  for (const r of rows) {
    const idx = semanas - 1 - r.semanas_atras;
    if (idx >= 0 && idx < semanas) porSemana[idx] = Math.round(Number(r.volumen));
  }
  return porSemana;
}

// Flags 1/0 de constancia de los últimos `dias` días (posición 0 = hace
// `dias-1` días, la más reciente al final) — 1 si hubo al menos una
// serie/sesión registrada ese día calendario (UTC).
async function constancia28dias(userId, dias = 28) {
  const { rows } = await pool.query(
    `SELECT DISTINCT dia FROM (
       SELECT date_trunc('day', completada_en) AS dia
       FROM registros_sesion
       WHERE user_id = $1 AND completada_en >= now() - ($2 || ' days')::interval
       UNION
       SELECT date_trunc('day', iniciada_en) AS dia
       FROM sesiones_wearable
       WHERE user_id = $1 AND iniciada_en >= now() - ($2 || ' days')::interval
     ) sesiones`,
    [userId, dias]
  );
  const diasConSesion = new Set(rows.map((r) => r.dia.toISOString().slice(0, 10)));
  const resultado = [];
  for (let i = dias - 1; i >= 0; i--) {
    const fecha = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    resultado.push(diasConSesion.has(fecha) ? 1 : 0);
  }
  return resultado;
}

async function resumenWearable28dias(userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS sesiones,
            COALESCE(SUM(duracion_seg), 0)::bigint AS segundos,
            MAX(sincronizada_en) AS "ultimaSincronizacion"
     FROM sesiones_wearable
     WHERE user_id = $1 AND iniciada_en >= now() - interval '28 days'`,
    [userId]
  );
  return {
    sesiones: Number(rows[0]?.sesiones || 0),
    minutos: Math.round(Number(rows[0]?.segundos || 0) / 60),
    ultimaSincronizacion: rows[0]?.ultimaSincronizacion || null,
  };
}

// ---------------------------------------------------------------------
// DISPOSITIVOS
// ---------------------------------------------------------------------
async function crearDispositivo(userId, tipo) {
  const { rows } = await pool.query(
    `INSERT INTO dispositivos_conectados (user_id, tipo) VALUES ($1,$2) RETURNING id`,
    [userId, tipo]
  );
  return rows[0].id;
}

async function desactivarDispositivo(id, userId) {
  const { rows } = await pool.query(
    `UPDATE dispositivos_conectados SET activo = false WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId]
  );
  return rows[0] || null;
}

async function dispositivosActivosDeUsuario(userId) {
  const { rows } = await pool.query(
    `SELECT id, tipo, conectado_en AS "conectadoEn" FROM dispositivos_conectados
     WHERE user_id = $1 AND activo = true ORDER BY conectado_en DESC`,
    [userId]
  );
  return rows;
}

// ---------------------------------------------------------------------
// SESIONES DE WEARABLE (HealthKit / Health Connect)
// ---------------------------------------------------------------------
// Upsert por (user_id, fuente, external_id): re-sincronizar la misma
// sesión (el reloj puede reportar el mismo entrenamiento más de una vez,
// o llegar con datos actualizados) actualiza la fila en vez de duplicarla.
async function upsertSesionesWearable(userId, fuente, sesiones) {
  let sincronizadas = 0;
  for (const s of sesiones) {
    const duracionSeg = Math.round((new Date(s.finalizadaEn) - new Date(s.iniciadaEn)) / 1000);
    const { rowCount } = await pool.query(
      `INSERT INTO sesiones_wearable
         (user_id, fuente, external_id, tipo_actividad, iniciada_en, finalizada_en, duracion_seg, calorias_activas, fc_promedio, fc_maxima, fc_minima)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (user_id, fuente, external_id) DO UPDATE SET
         tipo_actividad = EXCLUDED.tipo_actividad,
         iniciada_en = EXCLUDED.iniciada_en,
         finalizada_en = EXCLUDED.finalizada_en,
         duracion_seg = EXCLUDED.duracion_seg,
         calorias_activas = EXCLUDED.calorias_activas,
         fc_promedio = EXCLUDED.fc_promedio,
         fc_maxima = EXCLUDED.fc_maxima,
         fc_minima = EXCLUDED.fc_minima,
         sincronizada_en = now()`,
      [
        userId, fuente, s.externalId, s.tipoActividad || null, s.iniciadaEn, s.finalizadaEn,
        duracionSeg, s.caloriasActivas ?? null, s.fcPromedio ?? null, s.fcMaxima ?? null, s.fcMinima ?? null,
      ]
    );
    sincronizadas += rowCount;
  }
  return sincronizadas;
}

async function sesionesWearableDeUsuario(userId, limite = 20) {
  const { rows } = await pool.query(
    `SELECT id, fuente, tipo_actividad AS "tipoActividad", iniciada_en AS "iniciadaEn", finalizada_en AS "finalizadaEn",
            duracion_seg AS "duracionSeg", calorias_activas AS "caloriasActivas",
            fc_promedio AS "fcPromedio", fc_maxima AS "fcMaxima", fc_minima AS "fcMinima"
     FROM sesiones_wearable WHERE user_id = $1 ORDER BY iniciada_en DESC LIMIT $2`,
    [userId, limite]
  );
  return rows.map((r) => ({ ...r, caloriasActivas: r.caloriasActivas != null ? Number(r.caloriasActivas) : null }));
}

// ---------------------------------------------------------------------
// RECUPERACIÓN DE CONTRASEÑA
// ---------------------------------------------------------------------
async function crearTokenReset(userId, tokenHash, expiraEn) {
  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expira_en) VALUES ($1,$2,$3)`,
    [userId, tokenHash, expiraEn]
  );
}

async function buscarTokenReset(tokenHash) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", expira_en AS "expiraEn", usado_en AS "usadoEn"
     FROM password_reset_tokens WHERE token_hash = $1`,
    [tokenHash]
  );
  return rows[0] || null;
}

async function marcarTokenResetUsado(id) {
  await pool.query(`UPDATE password_reset_tokens SET usado_en = now() WHERE id = $1`, [id]);
}

module.exports = {
  pool,
  migrar,
  sembrarEjercicios,
  EmailEnUsoError,
  transaccion,
  crearUsuario,
  crearUsuarioApple,
  buscarUsuarioPorAppleId,
  vincularAppleId,
  buscarUsuarioPorEmail,
  buscarUsuarioPorId,
  actualizarAjustesUsuario,
  actualizarPassword,
  ultimoRegistroPorEjercicio,
  rendimientoRecientePorEjercicio,
  eliminarUsuario,
  perfilVigente,
  cerrarPerfilVigente,
  crearPerfil,
  agregarLesiones,
  cerrarLesionesActivas,
  lesionesActivasDeUsuario,
  agregarRegistro1RM,
  ultimoRegistro1RM,
  historial1RM,
  todosLosEjercicios,
  crearRutinaDia,
  agregarRutinaEjercicio,
  rutinaDiaDeUsuario,
  rutinaDiaDeHoy,
  limpiarEjerciciosNoIniciados,
  marcarPerfilDeRutina,
  ejerciciosDeRutinaDia,
  registrosDeRutinaDia,
  crearRegistroSesion,
  rutinaEjercicioPorId,
  rutinaEjercicioRegistrable,
  sustituirEjercicioDeRutina,
  actualizarPrescripcionRutina,
  contarSesionesDeUsuario,
  volumenSemanal,
  constancia28dias,
  resumenWearable28dias,
  crearDispositivo,
  desactivarDispositivo,
  dispositivosActivosDeUsuario,
  upsertSesionesWearable,
  sesionesWearableDeUsuario,
  crearTokenReset,
  buscarTokenReset,
  marcarTokenResetUsado,
};
