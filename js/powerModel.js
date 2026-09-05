// Device power-model: data structures + event-driven simulator.
// Port of embedded_power_model.py minus solar harvesting. Single-rail model:
// system -> battery -> regulator -> threads -> stages -> components.

export const LI_ION = {
  id: 'li-ion', label: 'Li-Ion',
  soc:    [0.0, 10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 95.0, 100.0],
  volt:   [2.25, 3.5, 3.65, 3.72, 3.73, 3.75, 3.76, 3.77, 3.78, 3.85, 4.1, 4.25],
};

export const COIN_CELL = {
  id: 'coin-cell', label: 'Coin Cell',
  soc:  [0.0, 5.0, 25.0, 50.0, 95.0, 100.0],
  volt: [2.0, 2.5, 2.7, 2.8, 3.0, 3.2],
};

export function freshComponent(name = 'Component') {
  return { name, mode_name: 'Active', current_ma: 1.0 };
}

export function freshStage() {
  return { name: 'Stage', delta_t_sec: 1.0, components: [freshComponent()] };
}

export function freshThread(name = 'Thread') {
  return { name, stages: [freshStage()] };
}

export function freshModel() {
  return {
    name: 'Device Model',
    sim_time_sec: 60,
    battery: {
      name: 'Battery',
      type: 'li-ion',
      number_cells: 1,
      capacity_mAh: 1000,
      initial_charge_mAh: 800,
      internal_resistance_ohm: 0.1,
      regulator: {
        name: '3.3 V Rail',
        output_voltage: 3.3,
        is_switching: true,
        efficiency: 0.9,
        quiescent_current_ma: 0.01,
        threads: [freshThread('Thread 1')]
      }
    }
  };
}

function num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }
function numGt0(v) { const n = num(v); return (n !== null && n > 0) ? n : null; }
function numGe0(v) { const n = num(v); return (n !== null && n >= 0) ? n : null; }

function cleanComponent(c) {
  if (!c || typeof c !== 'object') return null;
  const current_ma = numGe0(c.current_ma);
  if (current_ma === null) return null;
  return {
    name: (typeof c.name === 'string' && c.name.trim()) ? c.name.trim() : 'Component',
    mode_name: (typeof c.mode_name === 'string' && c.mode_name.trim()) ? c.mode_name.trim() : 'Active',
    current_ma
  };
}

function cleanStage(s) {
  if (!s || typeof s !== 'object') return null;
  const delta_t_sec = numGt0(s.delta_t_sec);
  if (delta_t_sec === null) return null;
  if (!Array.isArray(s.components) || !s.components.length) return null;
  const components = s.components.map(cleanComponent).filter(Boolean);
  if (!components.length) return null;
  return {
    name: (typeof s.name === 'string' && s.name.trim()) ? s.name.trim() : 'Stage',
    delta_t_sec,
    components
  };
}

function cleanThread(t) {
  if (!t || typeof t !== 'object') return null;
  if (!Array.isArray(t.stages) || !t.stages.length) return null;
  const stages = t.stages.map(cleanStage).filter(Boolean);
  if (!stages.length) return null;
  return {
    name: (typeof t.name === 'string' && t.name.trim()) ? t.name.trim() : 'Thread',
    stages
  };
}

function cleanRegulator(r) {
  if (!r || typeof r !== 'object') return null;
  const output_voltage = numGt0(r.output_voltage);
  // Efficiency only matters for switching regulators; linear regulators may be 0.
  const efficiency = (r.is_switching ? numGt0(r.efficiency) : numGe0(r.efficiency));
  const quiescent_current_ma = numGe0(r.quiescent_current_ma);
  const threads = (Array.isArray(r.threads) ? r.threads : []).map(cleanThread).filter(Boolean);
  if (output_voltage === null || efficiency === null || quiescent_current_ma === null) return null;
  if (!threads.length) return null;
  return {
    name: (typeof r.name === 'string' && r.name.trim()) ? r.name.trim() : 'Regulator',
    output_voltage,
    is_switching: !!r.is_switching,
    efficiency,
    quiescent_current_ma,
    threads
  };
}

function cleanBattery(b) {
  if (!b || typeof b !== 'object') return null;
  const regulator = cleanRegulator(b.regulator);
  const capacity_mAh = numGt0(b.capacity_mAh);
  const initial_charge_mAh = numGe0(b.initial_charge_mAh);
  const internal_resistance_ohm = numGe0(b.internal_resistance_ohm);
  const number_cells = numGt0(b.number_cells);
  if (!regulator || capacity_mAh === null || initial_charge_mAh === null ||
      internal_resistance_ohm === null || number_cells === null) return null;
  if (initial_charge_mAh > capacity_mAh) return null;
  const type = b.type === 'coin-cell' ? 'coin-cell' : 'li-ion';
  return {
    name: (typeof b.name === 'string' && b.name.trim()) ? b.name.trim() : 'Battery',
    type,
    number_cells,
    capacity_mAh,
    initial_charge_mAh,
    internal_resistance_ohm,
    regulator
  };
}

// Validate and normalize an imported model. Returns { ok, model?, error? }.
export function parseModel(json) {
  try {
    const m = (typeof json === 'string') ? JSON.parse(json) : json;
    if (!m || typeof m !== 'object') return { ok: false, error: 'Not a JSON object.' };
    const sim_time_sec = numGt0(m.sim_time_sec);
    const battery = cleanBattery(m.battery);
    if (sim_time_sec === null) return { ok: false, error: 'Model is missing a valid "sim_time_sec".' };
    if (!battery) return { ok: false, error: 'Model is missing a valid "battery" with a regulator and at least one thread.' };
    return {
      ok: true,
      model: {
        name: (typeof m.name === 'string' && m.name.trim()) ? m.name.trim() : 'Device Model',
        sim_time_sec,
        battery
      }
    };
  } catch (e) {
    return { ok: false, error: `Could not parse model file: ${e.message}` };
  }
}

// Cell voltage from SOC look-up table (port of Source.get_current_voltage).
function cellVoltageV(chem, socPct, loadMa, internalResistanceOhm) {
  let v = chem.volt[chem.volt.length - 1];
  for (let i = 0; i < chem.soc.length - 1; i++) {
    if (socPct >= chem.soc[i] && socPct < chem.soc[i + 1]) {
      const span = chem.soc[i + 1] - chem.soc[i];
      v = chem.volt[i] + ((chem.volt[i + 1] - chem.volt[i]) / span) * (socPct - chem.soc[i]);
    }
  }
  v = v - internalResistanceOhm * (loadMa * 0.001);
  return v;
}

// Current from a regulator given its threads' active stages.
function regulatorOutputCurrentMa(threads) {
  let total = 0;
  for (const thread of threads) {
    const stage = thread.stages[thread._stageIndex % thread.stages.length];
    for (const c of stage.components) total += c.current_ma;
  }
  return total;
}

// Simulate the model. Returns { time[], current_uA[], charge_uAh[] } square pulses.
export function simulateModel(model) {
  const battery = model.battery;
  const regulator = battery.regulator;
  const chem = battery.type === 'coin-cell' ? COIN_CELL : LI_ION;

  // Threads advance with their own stage cycle.
  const threads = regulator.threads.map(t => ({
    stages: t.stages,
    _stageIndex: 0,
    _nextChange: t.stages[0].delta_t_sec
  }));

  const times = [], curUa = [], chgUAh = [];
  let t = 0;
  let chargeMah = battery.initial_charge_mAh;
  let cumUAh = 0;
  const tEnd = model.sim_time_sec;

  while (t < tEnd) {
    // Next event = next thread stage change.
    let dt = Infinity;
    for (const th of threads) {
      const d = th._nextChange - t;
      if (d < dt) dt = d;
    }
    if (!Number.isFinite(dt) || dt <= 0) dt = 1e-6;
    if (dt > tEnd - t) dt = tEnd - t;

    const outCurMa = regulatorOutputCurrentMa(threads);
    // Battery voltage depends on SOC and internal resistance (uses output current).
    const v = cellVoltageV(chem, (chargeMah / battery.capacity_mAh) * 100.0, outCurMa, battery.internal_resistance_ohm) * battery.number_cells;
    let srcMa;
    // Quiescent current is drawn by the regulator itself, before per-rail math.
    if (regulator.is_switching) srcMa = regulator.quiescent_current_ma + (regulator.output_voltage / (v * regulator.efficiency)) * outCurMa;
    else srcMa = regulator.quiescent_current_ma + outCurMa;

    times.push(t); curUa.push(srcMa * 1000.0); chgUAh.push(cumUAh);

    t += dt;

    // Deplete battery charge and integrate charge used.
    const jDish = dt * v * (srcMa * 0.001);
    chargeMah -= 0.277778 * jDish / v;
    if (chargeMah <= 0) { chargeMah = 0; }
    cumUAh += (srcMa * 1000.0) * dt / 3600.0;

    times.push(t); curUa.push(srcMa * 1000.0); chgUAh.push(cumUAh);

    if (chargeMah <= 0) break;

    // Advance thread stages that crossed their boundary.
    for (const th of threads) {
      if (t >= th._nextChange - 1e-7) {
        th._stageIndex += 1;
        th._nextChange = t + th.stages[th._stageIndex % th.stages.length].delta_t_sec;
      }
    }
  }

  return { time: times, current_uA: curUa, charge_uAh: chgUAh };
}