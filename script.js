// ---------------------
// Global Variables & DOM Elements
// ---------------------
const canvas = document.getElementById('mapCanvas');
const ctx = canvas.getContext('2d');
const timeSlider = document.getElementById('timeSlider');
const timeValue = document.getElementById('timeValue');
const setFireButton = document.getElementById('setFireButton');
const clearFireButton = document.getElementById('clearFireButton');
const clearPredictionsButton = document.getElementById('clearPredictionsButton');

let fireStartLatLng = null; // Store as a Leaflet latlng (geographic coordinate)
let currentCenter = null;   // For meter-to-pixel conversions
let animationFrameId;
let simulationRunning = false; // Flag to indicate if simulation is active

// Global variable for the dynamic spread rate computed from weather and terrain data.
let effectiveSpreadRate = 1.0; // In meters per time step (updated via API calls)

// Global variables for wind direction (in degrees) and a directional factor
let globalWindDegree = 0;         // (0° = East, 90° = South, etc.)
let globalDirectionalFactor = 1.0;  // Determines elongation of the fire front

// Define scenario multipliers (applied to effectiveSpreadRate)
const bestMultiplier = 0.8;
const neutralMultiplier = 1.0;
const worstMultiplier = 1.2;

// A constant to boost the visible spread (if needed)
// Changed displayScaleFactor from 10 to 5 for a more moderate appearance.
const displayScaleFactor = 5;

// ----- Simulation Time Scale Settings -----
// totalSimTimeMin defines the total simulated time (e.g. fire evolution time in minutes)
const totalSimTimeMin = 30; // For example, the simulation represents 30 minutes of fire evolution.
// simTimeStepMinutes defines the simulated time per step.
const simTimeStepMinutes = 1.0;
// The number of simulation steps is computed from totalSimTimeMin and simTimeStepMinutes.
const simulationSteps = totalSimTimeMin / simTimeStepMinutes;

// Update slider attributes to reflect these steps.
timeSlider.min = 0;
timeSlider.max = simulationSteps;
timeSlider.step = 1;

// ---------------------
// Array for firefighting resource markers
// ---------------------
let fireResourceMarkers = [];

// ============================================
// Custom Icons for Firefighting Resources
// ============================================
const fireStationIcon = L.divIcon({
  html: '<span style="font-size:24px; color: blue;">&#9733;</span>',
  iconSize: [24, 24],
  className: ''
});

const hydrantIcon = L.divIcon({
  html: '<span style="font-size:24px; color: blue;">&bull;</span>',
  iconSize: [24, 24],
  className: ''
});

// ---------------------
// Canvas Resize
// ---------------------
function resizeCanvas() {
  const mapDiv = document.getElementById('map');
  canvas.width = mapDiv.offsetWidth;
  canvas.height = mapDiv.offsetHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// ---------------------
// Helper: Convert Meters to Pixels at the Current Map Zoom
// ---------------------
function metersToPixels(meters) {
  const center = currentCenter || fireStartLatLng;
  if (!center) return meters;
  const lat = center.lat;
  const lng = center.lng;
  const meterPerDegree = (40075000 * Math.cos(lat * Math.PI / 180)) / 360;
  const offsetLng = lng + (meters / meterPerDegree);
  const offsetLatLng = L.latLng(lat, offsetLng);
  const p1 = map.latLngToContainerPoint(center);
  const p2 = map.latLngToContainerPoint(offsetLatLng);
  return Math.abs(p2.x - p1.x);
}

// ---------------------
// Helper: Compute Distance Between Two Lat/Lng Points (in meters)
// ---------------------
function computeDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ---------------------
// Drawing Functions
// ---------------------
function drawMap() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawFire() {
  if (!fireStartLatLng) return;
  const containerPoint = map.latLngToContainerPoint(fireStartLatLng);
  ctx.fillStyle = 'red';
  ctx.beginPath();
  ctx.arc(containerPoint.x, containerPoint.y, 5, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------------
// API Helper Functions for Terrain & Vegetation Data
// ---------------------

// getElevation uses a CORS proxy to bypass restrictions.
// NOTE: If you receive a 403 error, try requesting temporary access or use a different proxy.
function getElevation(lat, lng) {
  const proxyUrl = 'https://thingproxy.freeboard.io/fetch/';
  const url = `https://api.open-elevation.com/api/v1/lookup?locations=${lat},${lng}`;
  return fetch(proxyUrl + url)
    .then(response => {
      if (!response.ok) {
        throw new Error("CORS proxy error: " + response.status);
      }
      return response.json();
    })
    .then(data => {
      if (data.results && data.results.length > 0) {
        return data.results[0].elevation;
      }
      throw new Error("No elevation data found");
    });
}

function getSlope(lat, lng) {
  const deltaLng = 0.001;
  return Promise.all([
    getElevation(lat, lng),
    getElevation(lat, lng + deltaLng)
  ]).then(([elev1, elev2]) => {
    const metersPerDegree = (40075000 * Math.cos(lat * Math.PI / 180)) / 360;
    const horizontalMeters = deltaLng * metersPerDegree;
    const slope = ((elev2 - elev1) / horizontalMeters) * 100;
    return Math.abs(slope);
  });
}

function getLandCover(lat, lng, radius = 100) {
  const overpassUrl = 'https://overpass-api.de/api/interpreter';
  const query = `[out:json];(node(around:${radius},${lat},${lng})[landuse];
                  way(around:${radius},${lat},${lng})[landuse];
                  relation(around:${radius},${lat},${lng})[landuse];);out center;`;
  return fetch(overpassUrl, { method: 'POST', body: query })
    .then(response => response.json())
    .then(data => {
      if (data.elements && data.elements.length > 0) {
        const tags = data.elements[0].tags;
        if (tags && tags.landuse) {
          return tags.landuse;
        }
      }
      return "unknown";
    });
}

function updateEnvironmentalData(latlng) {
  const apiKey = 'c45fb7ca63774b0e83a232501250802';
  const weatherUrl = `http://api.weatherapi.com/v1/current.json?key=${apiKey}&q=${latlng.lat},${latlng.lng}&aqi=no`;
  
  fetch(weatherUrl)
    .then(response => response.json())
    .then(data => {
      if (data.current) {
        const temperature = data.current.temp_c;
        const windSpeedKph = data.current.wind_kph;
        const windSpeedMs = windSpeedKph / 3.6;
        const windDegree = data.current.wind_degree;
        const humidity = data.current.humidity;
        const precip_mm = data.current.precip_mm || 0;
        
        globalWindDegree = windDegree;
        globalDirectionalFactor = Math.exp(0.1 * windSpeedMs);
        const windModifier = Math.exp(0.05 * windSpeedMs);
        
        Promise.all([
          getSlope(latlng.lat, latlng.lng),
          getLandCover(latlng.lat, latlng.lng)
        ]).then(([slope, landCover]) => {
          const fuelType = (landCover === 'forest' || landCover === 'wood') ? 'sparse' : 'sparse';
          const baseSpreadRate = 1.0;
          const temperatureModifier = 1 + ((temperature - 20) * 0.05);
          const humidityModifier = 1 - ((humidity / 100) * 0.5);
          const precipitationModifier = 1 - Math.min(0.5, precip_mm * 0.2);
          const slopeModifier = Math.exp(1.0 * (slope / 100));
          const fuelModifier = fuelType === 'dense' ? 1.2 : 1.0;
          const landCoverModifier = (landCover === 'forest') ? 1.2 :
                                    (landCover === 'urban' || landCover === 'residential') ? 0.8 : 1.0;
          
          effectiveSpreadRate = baseSpreadRate * windModifier * temperatureModifier *
                                slopeModifier * fuelModifier * humidityModifier *
                                precipitationModifier * landCoverModifier;
          console.log("Effective Spread Rate (meters per time step):", effectiveSpreadRate);
          
          const reasoningElem = document.getElementById('gptReasoning');
          if (reasoningElem) {
            reasoningElem.textContent =
              `Temp ${temperature}°C, Wind ${windSpeedMs.toFixed(2)} m/s (Dir: ${windDegree}°), ` +
              `Humidity ${humidity}%, Precip ${precip_mm} mm, Slope ${slope.toFixed(2)}%, ` +
              `Fuel: ${fuelType}, Land Cover: ${landCover}.`;
          }
        });
      } else {
        console.error("No weather data available from WeatherAPI.com");
      }
    })
    .catch(error => {
      console.error("Error fetching environmental data:", error);
    });
}

// ---------------------
// Info Box Update (Using OpenCage for Reverse Geocoding)
// ---------------------
function updateInfoBox(latlng) {
  const coordsElem = document.getElementById('coords');
  if (coordsElem) {
    coordsElem.textContent = `Coordinates: ${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;
  }
  
  const addressElem = document.getElementById('address');
  const url = `https://api.opencagedata.com/geocode/v1/json?q=${latlng.lat},${latlng.lng}&key=20cdeedce57f454c8e848b23e897e4ca`;
  
  fetch(url)
    .then(response => response.json())
    .then(data => {
      if (addressElem) {
        if (data && data.results && data.results.length > 0) {
          addressElem.textContent = `Address: ${data.results[0].formatted}`;
        } else {
          addressElem.textContent = "Address: Not found";
        }
      }
    })
    .catch(error => {
      console.error("Error fetching address:", error);
      if (addressElem) {
        addressElem.textContent = "Address: Error fetching";
      }
    });
  
  updateEnvironmentalData(latlng);
}

// ---------------------
// Function to Display Nearby Firefighting Resources
// ---------------------
function displayNearbyFireResources(latlng) {
  fireResourceMarkers.forEach(marker => map.removeLayer(marker));
  fireResourceMarkers = [];
  
  const radius = 5000; // 5 km search radius.
  const overpassUrl = 'https://overpass-api.de/api/interpreter';
  const query = `
    [out:json];
    (
      node(around:${radius},${latlng.lat},${latlng.lng})[amenity=fire_station];
      node(around:${radius},${latlng.lat},${latlng.lng})[emergency=fire_hydrant];
    );
    out;
  `;
  
  fetch(overpassUrl, { method: 'POST', body: query })
    .then(response => response.json())
    .then(data => {
      if (data.elements && data.elements.length > 0) {
        let nearestStation = null;
        let nearestDistance = Infinity;
        
        data.elements.forEach(element => {
          if (!element.lat || !element.lon) return;
          const position = L.latLng(element.lat, element.lon);
          let marker;
          if (element.tags && element.tags.amenity === 'fire_station') {
            marker = L.marker(position, { icon: fireStationIcon });
            const distance = computeDistance(fireStartLatLng.lat, fireStartLatLng.lng, element.lat, element.lon);
            if (distance < nearestDistance) {
              nearestDistance = distance;
              nearestStation = element;
            }
          } else if (element.tags && element.tags.emergency === 'fire_hydrant') {
            marker = L.marker(position, { icon: hydrantIcon });
          }
          if (marker) {
            marker.addTo(map);
            fireResourceMarkers.push(marker);
          }
        });
        
        if (nearestStation) {
          const stationName = nearestStation.tags.name || "Unnamed Station";
          const nearestElem = document.getElementById('nearestFireStation');
          nearestElem.textContent = `Nearest fire station: ${stationName}`;
        }
      } else {
        console.log("No nearby firefighting resources found.");
      }
    })
    .catch(error => {
      console.error("Error fetching nearby firefighting resources:", error);
    });
}

// ---------------------
// Map Click Event: Set the Fire Starting Point and Display Resources
// ---------------------
map.on('click', (e) => {
  if (fireStartLatLng !== null) return;
  fireStartLatLng = e.latlng;
  currentCenter = e.latlng;
  drawMap();
  drawFire();
  updateInfoBox(e.latlng);
  displayNearbyFireResources(e.latlng);
  document.getElementById('emergencyCall').style.display = 'block';
});

// ---------------------
// Recursive Boundary Sampling Functions
// ---------------------
function computeBoundaryPointsRecursively(theta, baseRadiusPx, windAngleRad, k, points, stepIncrement, minDistance) {
  if (theta > 2 * Math.PI) {
    return points;
  }
  const r = baseRadiusPx * (1 + k * Math.cos(theta - windAngleRad));
  const x = r * Math.cos(theta);
  const y = r * Math.sin(theta);
  const newPoint = { x: x, y: y };
  
  if (points.length === 0) {
    points.push(newPoint);
  } else {
    const lastPoint = points[points.length - 1];
    const dx = newPoint.x - lastPoint.x;
    const dy = newPoint.y - lastPoint.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist >= minDistance) {
      points.push(newPoint);
    }
  }
  return computeBoundaryPointsRecursively(theta + stepIncrement, baseRadiusPx, windAngleRad, k, points, stepIncrement, minDistance);
}

function getCustomFireFrontPoints(baseRadiusPx, windAngleDeg, directionalFactor, minDistance = 3) {
  const windAngleRad = windAngleDeg * Math.PI / 180;
  const weightMultiplier = 1.5;
  const k = (directionalFactor - 1) * weightMultiplier;
  const stepIncrement = 0.01;
  return computeBoundaryPointsRecursively(0, baseRadiusPx, windAngleRad, k, [], stepIncrement, minDistance);
}

// ---------------------
// Simulation & Animation Functions (Iterative Model)
// ---------------------
function simulateFireSpread() {
  if (!fireStartLatLng) {
    alert('Please click on the map to set the starting point of the fire first.');
    return;
  }
  const simRunTimeSecElem = document.getElementById('simRunTimeSec');
  const simRunTimeSec = simRunTimeSecElem ? parseFloat(simRunTimeSecElem.value) || 10 : 10;
  const totalRealTime = simRunTimeSec * 1000;
  
  simulationRunning = true;
  animateFireSpread(0, totalRealTime);
}

function animateFireSpread(timeIndex, totalRealTime) {
  if (timeIndex >= simulationSteps) {
    simulationRunning = false;
    return;
  }
  drawMap();
  
  const cp = map.latLngToContainerPoint(fireStartLatLng);
  drawFire();
  
  const bestRadius = timeIndex * effectiveSpreadRate * bestMultiplier;
  const neutralRadius = timeIndex * effectiveSpreadRate * neutralMultiplier;
  const worstRadius = timeIndex * effectiveSpreadRate * worstMultiplier;
  
  const bestRadiusPx = metersToPixels(bestRadius) * displayScaleFactor;
  const neutralRadiusPx = metersToPixels(neutralRadius) * displayScaleFactor;
  const worstRadiusPx = metersToPixels(worstRadius) * displayScaleFactor;
  
  const bestPoints = getCustomFireFrontPoints(bestRadiusPx, globalWindDegree, globalDirectionalFactor);
  const neutralPoints = getCustomFireFrontPoints(neutralRadiusPx, globalWindDegree, globalDirectionalFactor);
  const worstPoints = getCustomFireFrontPoints(worstRadiusPx, globalWindDegree, globalDirectionalFactor);
  
  function drawScenario(pointsArray, color) {
    ctx.beginPath();
    pointsArray.forEach((pt, idx) => {
      const x = cp.x + pt.x;
      const y = cp.y + pt.y;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    let fillColor;
    if (color === 'green') fillColor = 'rgba(0,255,0,0.3)';
    else if (color === 'yellow') fillColor = 'rgba(255,255,0,0.3)';
    else if (color === 'orange') fillColor = 'rgba(255,165,0,0.3)';
    else fillColor = 'rgba(0,0,0,0.3)';
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  
  drawScenario(bestPoints, 'green');
  drawScenario(neutralPoints, 'yellow');
  drawScenario(worstPoints, 'orange');
  
  timeSlider.value = timeIndex;
  const simulatedMinutes = timeIndex * simTimeStepMinutes;
  timeValue.textContent = `Time: ${simulatedMinutes} minutes`;
  
  const delay = totalRealTime / simulationSteps;
  setTimeout(() => {
    animateFireSpread(timeIndex + 1, totalRealTime);
  }, delay);
}

function redrawAll() {
  drawMap();
  drawFire();
}

function clearPredictions() {
  drawMap();
  if (fireStartLatLng) drawFire();
  timeSlider.value = 0;
  timeValue.textContent = "Time: 0 minutes";
}

function clearFire() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  fireStartLatLng = null;
  document.getElementById('coords').textContent = "Coordinates: Not set";
  document.getElementById('address').textContent = "Address: Not set";
  document.getElementById('gptReasoning').textContent = "Reasoning: Not set";
  document.getElementById('nearestFireStation').textContent = "Nearest fire station: Not set";
  timeSlider.value = 0;
  timeValue.textContent = "Time: 0 minutes";
  
  document.getElementById('emergencyCall').style.display = 'none';
  
  fireResourceMarkers.forEach(marker => map.removeLayer(marker));
  fireResourceMarkers = [];
}

// ---------------------
// Recursive Environmental Data Update Function
// ---------------------
function recursiveUpdateEnvData(iteration) {
  if (!simulationRunning) return;
  if (fireStartLatLng) {
    updateEnvironmentalData(fireStartLatLng);
    console.log(`Environmental update iteration: ${iteration}`);
  }
  setTimeout(() => {
    recursiveUpdateEnvData(iteration + 1);
  }, 1000);
}

// ---------------------
// Event Listeners
// ---------------------
setFireButton.addEventListener('click', () => {
  if (fireStartLatLng) {
    simulateFireSpread();
    recursiveUpdateEnvData(1);
  } else {
    alert('Please click on the map to set the starting point of the fire first.');
  }
});

clearPredictionsButton.addEventListener('click', clearPredictions);
clearFireButton.addEventListener('click', clearFire);

timeSlider.addEventListener('input', (event) => {
  const timeIndex = parseInt(event.target.value, 10);
  drawMap();
  drawFire();
  const simulatedMinutes = timeIndex * simTimeStepMinutes;
  timeValue.textContent = `Time: ${simulatedMinutes} minutes`;
});

map.on('move zoom', redrawAll);

// ---------------------
// Custom Locate Button Added to the Controls Div (at the bottom)
// ---------------------
const controlsDiv = document.getElementById('controls');
const locateButton = document.createElement('button');
locateButton.innerHTML = '<a href="#" style="color: blue; text-decoration: underline; font-size:16px;">Locate Me</a>';
locateButton.title = 'Go to my current location';
locateButton.style.marginTop = '10px';
locateButton.style.width = '100px';
locateButton.style.height = '30px';
locateButton.style.border = 'none';
locateButton.style.backgroundColor = '#fff';
locateButton.style.cursor = 'pointer';

locateButton.onclick = function() {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const latlng = L.latLng(position.coords.latitude, position.coords.longitude);
        map.setView(latlng, 14);
      },
      (error) => {
        alert("Unable to retrieve your location.");
        console.error(error);
      }
    );
  } else {
    alert("Geolocation is not supported by your browser.");
  }
};

controlsDiv.appendChild(locateButton);
