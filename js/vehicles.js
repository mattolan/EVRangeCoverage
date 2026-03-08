// Vehicle database loading and cascading dropdown logic

let vehicleDB = [];
let onVehicleChange = null;

export async function loadVehicles() {
  const resp = await fetch('data/vehicles.json');
  if (!resp.ok) throw new Error(`Failed to load vehicles: ${resp.status}`);
  vehicleDB = await resp.json();
  return vehicleDB;
}

export function setupDropdowns(callback) {
  onVehicleChange = callback;

  const makeEl = document.getElementById('make-select');
  const yearEl = document.getElementById('year-select');
  const modelEl = document.getElementById('model-select');

  // Populate makes
  const makes = [...new Set(vehicleDB.map(v => v.make))].sort();
  makes.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    makeEl.appendChild(opt);
  });

  makeEl.addEventListener('change', () => {
    const selectedMake = makeEl.value;
    yearEl.innerHTML = '<option value="">— Select Year —</option>';
    modelEl.innerHTML = '<option value="">— Select Model —</option>';
    modelEl.disabled = true;
    hideVehicleInfo();

    if (!selectedMake) {
      yearEl.disabled = true;
      fireChange(null);
      return;
    }

    const years = [...new Set(vehicleDB.filter(v => v.make === selectedMake).map(v => v.year))].sort((a, b) => b - a);
    years.forEach(y => {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y;
      yearEl.appendChild(opt);
    });
    yearEl.disabled = false;

    // Auto-select if only one year
    if (years.length === 1) {
      yearEl.value = years[0];
      yearEl.dispatchEvent(new Event('change'));
    }
  });

  yearEl.addEventListener('change', () => {
    const selectedMake = makeEl.value;
    const selectedYear = parseInt(yearEl.value);
    modelEl.innerHTML = '<option value="">— Select Model —</option>';
    hideVehicleInfo();

    if (!yearEl.value) {
      modelEl.disabled = true;
      fireChange(null);
      return;
    }

    const models = vehicleDB.filter(v => v.make === selectedMake && v.year === selectedYear);
    models.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.model;
      opt.textContent = v.model;
      modelEl.appendChild(opt);
    });
    modelEl.disabled = false;

    // Auto-select if only one model
    if (models.length === 1) {
      modelEl.value = models[0].model;
      modelEl.dispatchEvent(new Event('change'));
    }
  });

  modelEl.addEventListener('change', () => {
    const selectedMake = makeEl.value;
    const selectedYear = parseInt(yearEl.value);
    const selectedModel = modelEl.value;

    if (!selectedModel) {
      hideVehicleInfo();
      fireChange(null);
      return;
    }

    const vehicle = vehicleDB.find(v => v.make === selectedMake && v.year === selectedYear && v.model === selectedModel);
    if (vehicle) {
      showVehicleInfo(vehicle);
      fireChange(vehicle);
    }
  });
}

function showVehicleInfo(vehicle) {
  const el = document.getElementById('vehicle-info');
  const display = document.getElementById('vehicle-range-display');
  display.textContent = `Rated range: ${vehicle.rangeKm} km | Battery: ${vehicle.batteryKwh} kWh`;
  el.classList.remove('hidden');
}

function hideVehicleInfo() {
  document.getElementById('vehicle-info').classList.add('hidden');
}

function fireChange(vehicle) {
  if (onVehicleChange) onVehicleChange(vehicle);
}
