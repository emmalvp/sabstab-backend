const assert = require("node:assert/strict");
const test = require("node:test");

const { EXERCISE_DB, generarDia, generarPlanCardio, generarProgramaSemanal, oneRMRelevante, normalizarCargaGuardada, parametrosDeEjecucion } = require("./engine");

function ejercicio(id) {
  const encontrado = EXERCISE_DB.find((item) => item.id === id);
  assert.ok(encontrado, `Falta el ejercicio ${id}`);
  return encontrado;
}

const oneRM = { sentadilla: 180, pesoMuerto: 140, pressBanca: 100, pressMilitar: 60 };

test("good mornings never inherit the deadlift 1RM", () => {
  assert.equal(oneRMRelevante(ejercicio("buenos_dias_barra"), oneRM), null);
});

test("only the exact measured lift receives its direct 1RM", () => {
  assert.equal(oneRMRelevante(ejercicio("peso_muerto_convencional"), oneRM), 140);
  assert.equal(oneRMRelevante(ejercicio("peso_muerto_rumano_barra"), oneRM), null);
});

test("legacy percentage-based accessory loads are hidden", () => {
  assert.deepEqual(normalizarCargaGuardada(ejercicio("buenos_dias_barra"), 73, 102.5), {
    porcentaje1RM: null,
    cargaKg: null,
  });
});

test("a direct lift keeps its valid percentage-based load", () => {
  assert.deepEqual(normalizarCargaGuardada(ejercicio("peso_muerto_convencional"), 73, 102.5), {
    porcentaje1RM: 73,
    cargaKg: 102.5,
  });
});

test("core exercise selection is stable for the same date and rotates across dates", () => {
  const profile = {
    antropometria: {},
    lesiones: [],
    objetivo: "hipertrofia",
    nivel: "intermedio",
    duracionSesionMin: 60,
    equipoDisponible: ["barra", "mancuerna", "polea", "maquina", "peso_corporal", "banda"],
    oneRM,
  };
  const coreId = (fecha) => generarDia("Empuje", EXERCISE_DB, profile, "es", fecha)
    .find((item) => item.exercise.patron === "core").exercise.id;

  assert.equal(coreId("2026-09-05"), coreId("2026-09-05"));
  const seleccionados = new Set(Array.from({ length: 14 }, (_, i) => coreId(`2026-09-${String(i + 1).padStart(2, "0")}`)));
  assert.ok(seleccionados.size > 1, "el core debe variar entre sesiones");
});

test("effort targets distinguish experience levels without prescribing failure", () => {
  const press = ejercicio("press_banca_plano_barra");
  assert.equal(parametrosDeEjecucion(press, "hipertrofia", "principiante").rirObjetivo, "3");
  assert.equal(parametrosDeEjecucion(press, "hipertrofia", "intermedio").rirObjetivo, "2");
  assert.equal(parametrosDeEjecucion(press, "hipertrofia", "avanzado").rirObjetivo, "1-2");
  assert.ok(parametrosDeEjecucion(press, "fuerza", "avanzado").descansoSeg >= 180);
});

test("fat-loss goal preserves strength work and adds progressive cardio", () => {
  const profile = {
    antropometria: {}, lesiones: [], objetivo: "perdida_grasa", nivel: "principiante",
    duracionSesionMin: 60, equipoDisponible: ["barra", "mancuerna", "peso_corporal"], oneRM,
  };
  const routine = generarDia("Empuje", EXERCISE_DB, profile, "es", "2026-09-06");
  assert.ok(routine.length >= 4);
  assert.equal(routine[0].series, 2);
  assert.match(routine[0].repeticiones, /^8-12$/);
  assert.deepEqual(generarPlanCardio(profile, "Piernas").colocacion, "piernas_suave_o_separado");
  assert.equal(generarPlanCardio(profile, null).hoyMin, 30);
});

test("cardio plan is only prescribed for the fat-loss goal and scales by level", () => {
  assert.equal(generarPlanCardio({ objetivo: "fuerza", nivel: "avanzado" }, "Empuje"), null);
  const intermediate = generarPlanCardio({ objetivo: "perdida_grasa", nivel: "intermedio" }, "Empuje");
  const advanced = generarPlanCardio({ objetivo: "perdida_grasa", nivel: "avanzado" }, "Empuje");
  assert.ok(advanced.semanalMin > intermediate.semanalMin);
  assert.equal(intermediate.colocacion, "despues_o_separado");
});

test("hypertrophy and fat-loss leg days add knee extension and flexion when machines are available", () => {
  const profile = {
    antropometria: {}, lesiones: [], objetivo: "perdida_grasa", nivel: "intermedio",
    duracionSesionMin: 60, equipoDisponible: ["barra", "mancuerna", "maquina", "peso_corporal"], oneRM,
  };
  const patterns = generarDia("Piernas", EXERCISE_DB, profile, "es", "2026-09-06").map((item) => item.exercise.patron);
  assert.ok(patterns.includes("sentadilla"));
  assert.ok(patterns.includes("bisagra_cadera"));
  assert.ok(patterns.includes("extension_rodilla"));
  assert.ok(patterns.includes("flexion_rodilla"));
});

test("weekly split stays balanced at every supported training frequency", () => {
  assert.deepEqual(generarProgramaSemanal(3).filter((d) => !d.descanso).map((d) => d.tipo), ["Empuje", "Tiron", "Piernas"]);
  assert.deepEqual(generarProgramaSemanal(4).filter((d) => !d.descanso).map((d) => d.tipo), ["Torso", "Piernas", "Torso", "Piernas"]);
  assert.deepEqual(generarProgramaSemanal(5).filter((d) => !d.descanso).map((d) => d.tipo), ["Empuje", "Tiron", "Piernas", "Torso", "Piernas"]);
  assert.deepEqual(generarProgramaSemanal(6).filter((d) => !d.descanso).map((d) => d.tipo), ["Empuje", "Tiron", "Piernas", "Empuje", "Tiron", "Piernas"]);
});

test("complete gym uses stable gym resistance while home never leaks machines or cables", () => {
  const base = { antropometria: {}, lesiones: [], objetivo: "hipertrofia", nivel: "intermedio", duracionSesionMin: 60, oneRM };
  const full = generarDia("Torso", EXERCISE_DB, { ...base, equipoDisponible: ["barra", "mancuerna", "polea", "maquina", "peso_corporal", "banda"] }, "es", "2026-09-06");
  assert.ok(full.slice(0, 4).every((item) => item.exercise.equipoNecesario.every((eq) => ["maquina", "polea"].includes(eq))));
  const homeAllowed = new Set(["barra", "mancuerna", "banda", "peso_corporal"]);
  const home = generarDia("Torso", EXERCISE_DB, { ...base, equipoDisponible: [...homeAllowed] }, "es", "2026-09-06");
  assert.ok(home.every((item) => item.exercise.equipoNecesario.every((eq) => homeAllowed.has(eq))));
  for (let day = 1; day <= 14; day++) {
    const routine = generarDia("Torso", EXERCISE_DB, { ...base, equipoDisponible: ["barra", "mancuerna", "polea", "maquina", "peso_corporal", "banda"] }, "es", `2026-09-${String(day).padStart(2, "0")}`);
    assert.ok(routine.every((item) => !item.exercise.equipoNecesario.includes("banda")), "full gym should not fall back to bands when machines and cables exist");
  }
});

test("long-limbed hypertrophy profiles receive stable variants when equipment permits", () => {
  const profile = { antropometria: { femurCm: 55, torsoCm: 45, brazoCm: 60 }, lesiones: [], objetivo: "hipertrofia", nivel: "intermedio", duracionSesionMin: 60, equipoDisponible: ["barra", "mancuerna", "polea", "maquina", "peso_corporal", "banda"], oneRM };
  const legs = generarDia("Piernas", EXERCISE_DB, profile, "es", "2026-09-06");
  assert.ok(["sentadilla_hack_maquina", "prensa_piernas_45"].includes(legs[0].exercise.id));
  const upper = generarDia("Torso", EXERCISE_DB, profile, "es", "2026-09-06");
  assert.equal(upper[0].exercise.id, "press_maquina_pecho_convergente");
});

test("muscle-building days include enough distinct chest work without duplicating an exercise", () => {
  const profile = { antropometria: {}, lesiones: [], objetivo: "hipertrofia", nivel: "intermedio", duracionSesionMin: 60, equipoDisponible: ["barra", "mancuerna", "polea", "maquina", "peso_corporal", "banda"], oneRM };
  for (const day of ["Empuje", "Torso"]) {
    const routine = generarDia(day, EXERCISE_DB, profile, "es", "2026-09-06");
    const chestSets = routine.filter((item) => item.exercise.musculoPrimario === "pecho").reduce((sum, item) => sum + item.series, 0);
    assert.ok(chestSets >= 6);
    assert.equal(new Set(routine.map((item) => item.exercise.id)).size, routine.length);
  }
});

test("short sessions keep major patterns and cap accessories to fit the promised time", () => {
  const profile = { antropometria: {}, lesiones: [], objetivo: "hipertrofia", nivel: "intermedio", duracionSesionMin: 30, equipoDisponible: ["barra", "mancuerna", "polea", "maquina", "peso_corporal", "banda"], oneRM };
  const upper = generarDia("Torso", EXERCISE_DB, profile, "es", "2026-09-06");
  assert.equal(upper.length, 5);
  assert.deepEqual(upper.slice(0, 4).map((item) => item.exercise.patron), ["empuje_horizontal", "traccion_horizontal", "empuje_vertical", "traccion_vertical"]);
  assert.ok(upper.every((item) => item.series === 2));
});
