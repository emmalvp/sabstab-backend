/**
 * SweetSwank — Motor de generación de rutinas
 * ---------------------------------------------
 * Este archivo contiene la lógica real (no pseudocódigo simbólico) que
 * transforma un perfil de usuario + una base de datos de ejercicios en una
 * rutina prescrita. Está pensado para copiarse a un proyecto real o pasarse
 * directamente a Claude Code para implementación.
 *
 * Flujo: Perfil → Motor de reglas (exclusión + ajuste) → Selección de
 * ejercicios → Prescripción de carga/volumen → Rutina → Retroalimentación.
 */

// ---------------------------------------------------------------------------
// 1. TIPOS
// ---------------------------------------------------------------------------

export type MovementPattern =
  | "empuje_horizontal"
  | "empuje_vertical"
  | "traccion_horizontal"
  | "traccion_vertical"
  | "sentadilla"
  | "bisagra_cadera"
  | "core";

export type MuscleGroup =
  | "pecho" | "espalda" | "hombro" | "biceps" | "triceps"
  | "cuadriceps" | "isquiotibiales" | "gluteo" | "core" | "pantorrilla";

export type Equipment =
  | "barra" | "mancuerna" | "polea" | "maquina" | "peso_corporal" | "banda";

export type InjuryZone = "hombro" | "rodilla" | "espalda_baja" | "codo" | "cadera";
export type InjuryStatus = "activa" | "en_rehabilitacion" | "resuelta_con_precaucion";

export interface Injury {
  zona: InjuryZone;
  lado: "izquierdo" | "derecho" | "ambos";
  estado: InjuryStatus;
  movimientoQueAgrava?: string;
}

export interface Anthropometry {
  alturaCm: number;
  femurCm: number;
  torsoCm: number;
  brazoCm: number;
  envergaduraCm?: number;
}

export type Goal = "hipertrofia" | "fuerza" | "ambos";
export type ExperienceLevel = "principiante" | "intermedio" | "avanzado";

export interface OneRM {
  sentadilla: number;
  pressBanca: number;
  pesoMuerto: number;
  pressMilitar: number;
}

export interface UserProfile {
  antropometria: Anthropometry;
  oneRM: OneRM;
  lesiones: Injury[];
  objetivo: Goal;
  nivel: ExperienceLevel;
  diasPorSemana: number;
  duracionSesionMin: number;
  equipoDisponible: Equipment[];
}

/** La "huella biomecánica" de un ejercicio — esto es lo que lo hace
 *  comparable/sustituible por otro ejercicio. */
export interface Exercise {
  id: string;
  nombre: string;
  patron: MovementPattern;
  musculoPrimario: MuscleGroup;
  musculosSecundarios: MuscleGroup[];
  anguloGrados: number; // ángulo de trabajo articular principal, para el motor de similitud
  equipoNecesario: Equipment[];
  unilateral: boolean;
  contraindicaciones: InjuryZone[]; // zonas que este ejercicio puede agravar
}

export interface PrescribedExercise {
  exercise: Exercise;
  series: number;
  repeticiones: string; // ej "8-10"
  porcentaje1RM: number | null; // null si no aplica (ej. peso corporal)
  cargaKg: number | null;
  nota: string; // nota biomecánica generada (para mostrar en la UI)
  advertenciaLesion?: string;
}

export interface RoutineDay {
  diaNumero: number;
  nombre: string; // ej "Empuje", "Tirón", "Piernas"
  ejercicios: PrescribedExercise[];
}

// ---------------------------------------------------------------------------
// 2. ESTIMACIÓN DE 1RM (cuando el usuario no lo conoce)
// ---------------------------------------------------------------------------

/** Fórmula de Epley: 1RM ≈ peso × (1 + reps / 30) */
export function estimate1RM(pesoKg: number, reps: number): number {
  if (reps === 1) return pesoKg;
  return Math.round(pesoKg * (1 + reps / 30));
}

// ---------------------------------------------------------------------------
// 3. MOTOR DE REGLAS — FILTRO DE EXCLUSIÓN (capa dura, binaria)
// ---------------------------------------------------------------------------

/**
 * Elimina ejercicios que contraindican una lesión activa o en rehabilitación.
 * Las lesiones "resueltas con precaución" NO excluyen — solo generan una nota
 * de advertencia (ver aplicarAjusteBiomecanico).
 */
export function filtrarPorLesiones(
  ejercicios: Exercise[],
  lesiones: Injury[]
): Exercise[] {
  const zonasExcluyentes = new Set(
    lesiones
      .filter((l) => l.estado === "activa" || l.estado === "en_rehabilitacion")
      .map((l) => l.zona)
  );

  if (zonasExcluyentes.size === 0) return ejercicios;

  return ejercicios.filter(
    (ej) => !ej.contraindicaciones.some((zona) => zonasExcluyentes.has(zona))
  );
}

/** Filtra por equipo disponible del usuario. */
export function filtrarPorEquipo(
  ejercicios: Exercise[],
  equipoDisponible: Equipment[]
): Exercise[] {
  return ejercicios.filter((ej) =>
    ej.equipoNecesario.every((eq) => equipoDisponible.includes(eq))
  );
}

// ---------------------------------------------------------------------------
// 4. MOTOR DE REGLAS — AJUSTE BIOMECÁNICO (capa suave, informativa)
// ---------------------------------------------------------------------------

/**
 * No elimina ejercicios: genera notas de contexto según la antropometría y
 * lesiones "resueltas con precaución". Estas notas son las que se muestran
 * en la tarjeta de cada ejercicio en la UI.
 */
export function generarNotasBiomecanicas(
  ejercicio: Exercise,
  profile: UserProfile
): string | null {
  const { antropometria, lesiones } = profile;

  // Ratio fémur/torso: fémur relativamente largo → más inclinación de tronco en sentadilla
  if (ejercicio.patron === "sentadilla") {
    const ratio = antropometria.femurCm / antropometria.torsoCm;
    if (ratio > 1.05) {
      return "Vas a inclinar más el torso al bajar — es normal con tu proporción de piernas.";
    }
  }

  // Lesión resuelta con precaución en la zona que trabaja este ejercicio
  const lesionRelevante = lesiones.find(
    (l) =>
      l.estado === "resuelta_con_precaucion" &&
      ejercicio.contraindicaciones.includes(l.zona)
  );
  if (lesionRelevante) {
    return `Movimiento controlado: cuida el rango final por tu historial en ${lesionRelevante.zona}.`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// 5. SELECCIÓN DE EJERCICIOS
// ---------------------------------------------------------------------------

const PATRONES_POR_DIA: Record<string, MovementPattern[]> = {
  Empuje: ["empuje_horizontal", "empuje_vertical", "core"],
  Tiron: ["traccion_horizontal", "traccion_vertical", "core"],
  Piernas: ["sentadilla", "bisagra_cadera", "core"],
};

/**
 * Elige un ejercicio por patrón de movimiento requerido para el día,
 * priorizando por: 1) ya pasó el filtro de exclusión, 2) coincide con el
 * equipo disponible, 3) el nivel de experiencia (ejercicios más técnicos
 * solo para intermedio/avanzado — se puede añadir un campo `dificultad` al
 * tipo Exercise si se quiere afinar esto).
 */
export function seleccionarEjerciciosDelDia(
  nombreDia: keyof typeof PATRONES_POR_DIA,
  exerciseDB: Exercise[],
  profile: UserProfile
): Exercise[] {
  const patrones = PATRONES_POR_DIA[nombreDia];
  const disponibles = filtrarPorEquipo(
    filtrarPorLesiones(exerciseDB, profile.lesiones),
    profile.equipoDisponible
  );

  return patrones.map((patron) => {
    const candidatos = disponibles.filter((ej) => ej.patron === patron);
    // Selección simple: el primero disponible. En producción, ordenar por
    // relevancia (ej. compuestos antes que aislamiento) o rotar semanalmente.
    if (candidatos.length === 0) {
      throw new Error(`Sin ejercicios disponibles para el patrón ${patron}`);
    }
    return candidatos[0];
  });
}

// ---------------------------------------------------------------------------
// 6. PRESCRIPCIÓN DE CARGA Y VOLUMEN
// ---------------------------------------------------------------------------

interface RangoPrescripcion {
  pctMin: number;
  pctMax: number;
  series: number;
  repMin: number;
  repMax: number;
}

const RANGOS_POR_OBJETIVO: Record<Goal, RangoPrescripcion> = {
  fuerza: { pctMin: 0.85, pctMax: 0.95, series: 4, repMin: 3, repMax: 6 },
  hipertrofia: { pctMin: 0.65, pctMax: 0.8, series: 3, repMin: 8, repMax: 12 },
  ambos: { pctMin: 0.75, pctMax: 0.85, series: 4, repMin: 6, repMax: 10 },
};

/** Redondea la carga al incremento de disco más cercano (2.5 kg por defecto). */
function redondearCarga(kg: number, incremento = 2.5): number {
  return Math.round(kg / incremento) * incremento;
}

/**
 * Calcula series/reps/carga para un ejercicio dado el 1RM del levantamiento
 * base más cercano. Para ejercicios que no tienen 1RM directo (ej. aperturas,
 * fondos), se usa un porcentaje relativo estimado o se prescribe por RPE.
 */
export function prescribirCarga(
  ejercicio: Exercise,
  oneRMBase: number | null,
  objetivo: Goal
): { series: number; repeticiones: string; porcentaje1RM: number | null; cargaKg: number | null } {
  const rango = RANGOS_POR_OBJETIVO[objetivo];
  const pctPromedio = (rango.pctMin + rango.pctMax) / 2;

  if (oneRMBase === null) {
    return {
      series: rango.series,
      repeticiones: `${rango.repMin}-${rango.repMax}`,
      porcentaje1RM: null,
      cargaKg: null, // se prescribe por RPE/sensación en vez de peso fijo
    };
  }

  return {
    series: rango.series,
    repeticiones: `${rango.repMin}-${rango.repMax}`,
    porcentaje1RM: Math.round(pctPromedio * 100),
    cargaKg: redondearCarga(oneRMBase * pctPromedio),
  };
}

// ---------------------------------------------------------------------------
// 7. GENERACIÓN DE LA RUTINA COMPLETA DEL DÍA
// ---------------------------------------------------------------------------

/** Mapea el patrón del ejercicio al 1RM base relevante del perfil. */
function oneRMRelevante(ejercicio: Exercise, oneRM: OneRM): number | null {
  switch (ejercicio.patron) {
    case "sentadilla":
      return oneRM.sentadilla;
    case "bisagra_cadera":
      return oneRM.pesoMuerto;
    case "empuje_horizontal":
      return oneRM.pressBanca;
    case "empuje_vertical":
      return oneRM.pressMilitar;
    default:
      return null; // tracción y core no tienen 1RM estándar en este set base
  }
}

export function generarDia(
  nombreDia: keyof typeof PATRONES_POR_DIA,
  numeroDia: number,
  exerciseDB: Exercise[],
  profile: UserProfile
): RoutineDay {
  const ejercicios = seleccionarEjerciciosDelDia(nombreDia, exerciseDB, profile);

  const prescritos: PrescribedExercise[] = ejercicios.map((ej) => {
    const rm = oneRMRelevante(ej, profile.oneRM);
    const carga = prescribirCarga(ej, rm, profile.objetivo);
    const nota = generarNotasBiomecanicas(ej, profile);

    const lesionActivaRelacionada = profile.lesiones.find(
      (l) =>
        (l.estado === "activa" || l.estado === "en_rehabilitacion") &&
        ej.contraindicaciones.includes(l.zona)
    );

    return {
      exercise: ej,
      series: carga.series,
      repeticiones: carga.repeticiones,
      porcentaje1RM: carga.porcentaje1RM,
      cargaKg: carga.cargaKg,
      nota: nota ?? "",
      advertenciaLesion: lesionActivaRelacionada
        ? `Ajustado por tu historial en ${lesionActivaRelacionada.zona}`
        : undefined,
    };
  });

  return { diaNumero: numeroDia, nombre: nombreDia, ejercicios: prescritos };
}

// ---------------------------------------------------------------------------
// 8. MOTOR DE ALTERNATIVAS (pantalla "¿Está ocupado?")
// ---------------------------------------------------------------------------

/**
 * Puntúa qué tan similar es un ejercicio candidato al ejercicio ocupado,
 * usando la huella biomecánica. Menor puntaje = más similar.
 */
function distanciaBiomecanica(a: Exercise, b: Exercise): number {
  let distancia = 0;
  if (a.patron !== b.patron) distancia += 100; // el patrón de movimiento pesa más que todo lo demás
  if (a.musculoPrimario !== b.musculoPrimario) distancia += 40;
  distancia += Math.abs(a.anguloGrados - b.anguloGrados) * 0.5;
  if (a.unilateral !== b.unilateral) distancia += 10;
  return distancia;
}

export function buscarAlternativas(
  ejercicioOcupado: Exercise,
  exerciseDB: Exercise[],
  profile: UserProfile,
  topN = 3
): Exercise[] {
  const candidatos = filtrarPorEquipo(
    filtrarPorLesiones(exerciseDB, profile.lesiones),
    profile.equipoDisponible
  ).filter((ej) => ej.id !== ejercicioOcupado.id);

  return candidatos
    .map((ej) => ({ ej, score: distanciaBiomecanica(ejercicioOcupado, ej) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, topN)
    .map((r) => r.ej);
}

// ---------------------------------------------------------------------------
// 9. RETROALIMENTACIÓN — AJUSTE SEMANAL (progresión automática)
// ---------------------------------------------------------------------------

export interface RegistroSesion {
  exerciseId: string;
  cargaUsadaKg: number;
  repeticionesCompletadas: number;
  rpe: number; // percepción de esfuerzo, 1-10
}

/**
 * Regla de progresión simple (doble progresión):
 * - Si completó todas las reps objetivo con RPE ≤ 8 → sube la carga.
 * - Si no completó las reps objetivo o RPE > 9 → mantiene o baja.
 */
export function ajustarProximaCarga(
  cargaActual: number,
  repsObjetivoMax: number,
  registro: RegistroSesion,
  incrementoKg = 2.5
): number {
  const completoRepsObjetivo = registro.repeticionesCompletadas >= repsObjetivoMax;
  if (completoRepsObjetivo && registro.rpe <= 8) {
    return redondearCarga(cargaActual + incrementoKg);
  }
  if (registro.rpe >= 9.5) {
    return redondearCarga(cargaActual - incrementoKg);
  }
  return cargaActual; // mantener y volver a intentar
}
