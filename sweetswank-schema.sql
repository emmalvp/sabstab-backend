-- =====================================================================
-- SweetSwank — Esquema de base de datos (PostgreSQL)
-- ---------------------------------------------------------------------
-- Diseñado para persistir exactamente lo que usa sweetswank-algorithm.ts:
-- perfil (antropometría + 1RM + lesiones), la base de ejercicios, las
-- rutinas generadas, y el registro de sesiones que alimenta la
-- progresión automática.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. USUARIOS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT NOT NULL UNIQUE,
  password_hash     TEXT, -- NULL si la cuenta se creó vía Sign in with Apple
  apple_user_id     TEXT UNIQUE, -- 'sub' del identityToken de Apple
  nombre            TEXT NOT NULL,
  idioma            TEXT NOT NULL DEFAULT 'es' CHECK (idioma IN ('es', 'en')),
  unidad_peso       TEXT NOT NULL DEFAULT 'kg' CHECK (unidad_peso IN ('kg', 'lb')),
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_users_metodo_auth CHECK (password_hash IS NOT NULL OR apple_user_id IS NOT NULL)
);

-- ---------------------------------------------------------------------
-- 2. PERFIL BIOMECÁNICO (antropometría + objetivo + contexto)
--    Uno-a-uno con el usuario, pero versionado por fecha para poder
--    ver la evolución del cuerpo/objetivo a lo largo del tiempo.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS perfiles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  altura_cm         NUMERIC(5,1) NOT NULL,
  femur_cm          NUMERIC(5,1) NOT NULL,
  torso_cm          NUMERIC(5,1) NOT NULL,
  brazo_cm          NUMERIC(5,1) NOT NULL,
  envergadura_cm    NUMERIC(5,1),
  edad              SMALLINT CHECK (edad BETWEEN 13 AND 100),
  peso_corporal_kg  NUMERIC(5,1) CHECK (peso_corporal_kg > 0),
  objetivo          TEXT NOT NULL CHECK (objetivo IN ('hipertrofia', 'fuerza', 'ambos')),
  nivel             TEXT NOT NULL CHECK (nivel IN ('principiante', 'intermedio', 'avanzado')),
  dias_por_semana   SMALLINT NOT NULL CHECK (dias_por_semana BETWEEN 1 AND 7),
  duracion_sesion_min SMALLINT NOT NULL,
  equipo_disponible TEXT[] NOT NULL, -- ej. ARRAY['barra','mancuerna','peso_corporal']
  vigente_desde     TIMESTAMPTZ NOT NULL DEFAULT now(),
  vigente_hasta     TIMESTAMPTZ -- NULL = perfil actual
);
CREATE INDEX IF NOT EXISTS idx_perfiles_user_vigente ON perfiles(user_id) WHERE vigente_hasta IS NULL;

-- edad/peso_corporal_kg se agregaron después del primer despliegue — ALTER
-- explícito para que node migrate.js siga siendo seguro de correr contra
-- una base ya existente (CREATE TABLE IF NOT EXISTS no agrega columnas).
ALTER TABLE perfiles ADD COLUMN IF NOT EXISTS edad SMALLINT CHECK (edad BETWEEN 13 AND 100);
ALTER TABLE perfiles ADD COLUMN IF NOT EXISTS peso_corporal_kg NUMERIC(5,1) CHECK (peso_corporal_kg > 0);

-- ---------------------------------------------------------------------
-- 3. LESIONES (una fila por lesión, un usuario puede tener varias)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lesiones (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  zona              TEXT NOT NULL CHECK (zona IN ('hombro', 'rodilla', 'espalda_baja', 'codo', 'cadera')),
  lado              TEXT NOT NULL CHECK (lado IN ('izquierdo', 'derecho', 'ambos')),
  estado            TEXT NOT NULL CHECK (estado IN ('activa', 'en_rehabilitacion', 'resuelta_con_precaucion')),
  movimiento_que_agrava TEXT,
  registrada_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resuelta_en       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_lesiones_user ON lesiones(user_id);

-- ---------------------------------------------------------------------
-- 4. 1RM (histórico — cada actualización es una fila nueva, así
--    "Progreso" puede graficar la evolución real sin recalcular nada)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS registros_1rm (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  levantamiento     TEXT NOT NULL CHECK (levantamiento IN ('sentadilla', 'press_banca', 'peso_muerto', 'press_militar')),
  valor_kg          NUMERIC(6,2) NOT NULL,
  origen            TEXT NOT NULL CHECK (origen IN ('reportado', 'estimado_epley', 'calculado_por_progresion')),
  registrado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_1rm_user_lift_fecha ON registros_1rm(user_id, levantamiento, registrado_en DESC);

-- ---------------------------------------------------------------------
-- 5. EJERCICIOS (la "huella biomecánica" — corresponde 1:1 al JSON)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ejercicios (
  id                    TEXT PRIMARY KEY, -- ej. 'press_banca_plano'
  nombre                TEXT NOT NULL,
  patron                TEXT NOT NULL CHECK (patron IN (
                            'empuje_horizontal', 'empuje_vertical',
                            'traccion_horizontal', 'traccion_vertical',
                            'sentadilla', 'bisagra_cadera', 'core')),
  musculo_primario      TEXT NOT NULL,
  musculos_secundarios  TEXT[] NOT NULL DEFAULT '{}',
  angulo_grados         SMALLINT NOT NULL,
  equipo_necesario      TEXT[] NOT NULL,
  unilateral            BOOLEAN NOT NULL DEFAULT false,
  contraindicaciones    TEXT[] NOT NULL DEFAULT '{}' -- zonas de lesión, mismo enum que `lesiones.zona`
);

-- ---------------------------------------------------------------------
-- 6. RUTINAS GENERADAS (snapshot de lo que el motor calculó ese día,
--    para que "Rutina de hoy" no tenga que recalcular cada vez que
--    abres la app, y para poder auditar qué se prescribió y cuándo)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rutinas_dia (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nombre_dia        TEXT NOT NULL, -- 'Empuje', 'Tirón', 'Piernas'
  generada_en       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rutina_ejercicios (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rutina_dia_id     UUID NOT NULL REFERENCES rutinas_dia(id) ON DELETE CASCADE,
  ejercicio_id      TEXT NOT NULL REFERENCES ejercicios(id),
  orden             SMALLINT NOT NULL,
  series            SMALLINT NOT NULL,
  repeticiones      TEXT NOT NULL, -- ej. '8-12'
  porcentaje_1rm    SMALLINT,
  carga_kg          NUMERIC(6,2),
  nota_biomecanica  TEXT,
  advertencia_lesion TEXT
);
CREATE INDEX IF NOT EXISTS idx_rutina_ejercicios_dia ON rutina_ejercicios(rutina_dia_id);

-- ---------------------------------------------------------------------
-- 7. REGISTRO DE SESIONES (lo que el usuario realmente hizo —
--    alimenta la progresión automática y la pantalla de Progreso)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS registros_sesion (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rutina_ejercicio_id   UUID NOT NULL REFERENCES rutina_ejercicios(id),
  carga_usada_kg        NUMERIC(6,2),
  repeticiones_completadas SMALLINT NOT NULL,
  rpe                   NUMERIC(3,1) CHECK (rpe BETWEEN 1 AND 10),
  completada_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  fuente                TEXT NOT NULL DEFAULT 'manual' CHECK (fuente IN ('manual', 'apple_watch', 'otro_wearable'))
);
CREATE INDEX IF NOT EXISTS idx_registros_sesion_user_fecha ON registros_sesion(user_id, completada_en DESC);

-- ---------------------------------------------------------------------
-- 8. DISPOSITIVOS CONECTADOS (Apple Watch / otros wearables)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dispositivos_conectados (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tipo              TEXT NOT NULL CHECK (tipo IN ('apple_watch', 'garmin', 'whoop', 'otro')),
  conectado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  activo            BOOLEAN NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------
-- 9. TOKENS DE RECUPERACIÓN DE CONTRASEÑA
--    Se guarda el hash (sha256) del token, nunca el token en claro — si
--    la base se filtra, los links de recuperación ya mandados no sirven
--    para nada. Expiran a la hora; un solo uso (usado_en se marca al
--    canjearlo).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash        TEXT NOT NULL,
  expira_en         TIMESTAMPTZ NOT NULL,
  usado_en          TIMESTAMPTZ,
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);

-- =====================================================================
-- Notas para el desarrollador:
-- - `perfiles` está versionado (vigente_desde/vigente_hasta) en vez de
--   sobrescribirse, para poder responder "¿cómo era mi perfil cuando
--   generé esta rutina?" sin perder historia.
-- - `registros_1rm` es histórico por el mismo motivo — así el gráfico
--   de progreso en la app (barras "antes → ahora") sale de una query,
--   no de un cálculo especial.
-- - Los CHECK constraints reflejan los mismos enums que ya existen en
--   sweetswank-algorithm.ts — mantenerlos sincronizados si cambia el tipo.
-- =====================================================================
