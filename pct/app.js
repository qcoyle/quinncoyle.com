/* ===================== PCT 2021 ===================== */

mapboxgl.accessToken = 'pk.eyJ1IjoicWNveWxlIiwiYSI6ImNrdXBydnF0ZDBscm4yeHBnZmkwdm15MmEifQ.xhgKU0DtBHlzyuwygiseOA';

let trailData = null;
let trailDescriptions = null;
let storyMap = null;
let flyoverMap = null;
let currentDayIndex = 0;
let flyoverPlaying = false;
let flyoverSpeed = 1;
let flyoverProgress = 0; // 0-1
let flyoverAnimId = null;
let allCoords = []; // flattened route for flyover

/* ===================== INIT ===================== */

async function init() {
  const [trailResp, descResp] = await Promise.all([
    fetch('trail_data.json'),
    fetch('trail_descriptions.json'),
  ]);
  trailData = await trailResp.json();
  trailDescriptions = await descResp.json();

  // Build a lookup: day number -> description
  const descByDay = {};
  trailDescriptions.forEach(d => { descByDay[d.day] = d; });
  trailData._descByDay = descByDay;

  // Populate hero
  document.getElementById('hero-days').textContent = trailData.total_days;
  document.getElementById('hero-miles').textContent = trailData.total_miles.toLocaleString();
  document.getElementById('hero-elev').textContent = trailData.total_elev_ft.toLocaleString();
  document.getElementById('flyover-total-miles').textContent = trailData.total_miles.toLocaleString();

  buildDayCards();
  initStoryMap();
  initScrollObserver();
  initProgressBar();
  initViewToggle();
}

/* ===================== DAY CARDS ===================== */

function buildDayCards() {
  const container = document.getElementById('day-cards');
  trailData.days.forEach((day, i) => {
    const card = document.createElement('div');
    card.className = 'day-card';
    card.dataset.dayIndex = i;

    const dateFormatted = new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric'
    });

    let photoHTML = '';
    if (day.photos && day.photos.length > 0) {
      photoHTML = `<img class="day-card-photo" src="${day.photos[0].src}" alt="Day ${day.day}" loading="lazy">`;
    }

    const desc = trailData._descByDay[day.day];
    let descHTML = '';
    if (desc) {
      descHTML = `
        <div class="day-card-description">
          <div class="day-card-desc-title">${desc.title}</div>
          <p class="day-card-desc-text">${desc.text}</p>
        </div>`;
    }

    card.innerHTML = `
      ${photoHTML}
      <div class="day-card-label">Day ${day.day} &middot; ${dateFormatted} &middot; Mile ${day.cumulative_mi}</div>
      <div class="day-card-title">${day.name}</div>
      <div class="day-card-stats">
        <div class="stat">
          <span class="stat-value">${day.distance_mi} mi</span>
          <span class="stat-label">Distance</span>
        </div>
        <div class="stat">
          <span class="stat-value">${day.elev_gain_ft.toLocaleString()} ft</span>
          <span class="stat-label">Elevation</span>
        </div>
        ${day.pace_min_mi > 0 ? `
        <div class="stat">
          <span class="stat-value">${day.pace_min_mi} min/mi</span>
          <span class="stat-label">Pace</span>
        </div>` : ''}
        ${day.moving_time ? `
        <div class="stat">
          <span class="stat-value">${day.moving_time}</span>
          <span class="stat-label">Moving Time</span>
        </div>` : ''}
      </div>
      ${descHTML}
      <div class="day-card-divider"></div>
    `;
    container.appendChild(card);
  });
}

/* ===================== STORY MAP ===================== */

function initStoryMap() {
  storyMap = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/outdoors-v12',
    center: trailData.full_route[0],
    zoom: 6,
    pitch: 30,
  });

  storyMap.addControl(new mapboxgl.NavigationControl(), 'top-right');

  storyMap.on('load', () => {
    // Add terrain
    storyMap.addSource('mapbox-dem', {
      type: 'raster-dem',
      url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
      tileSize: 512,
    });
    storyMap.setTerrain({ source: 'mapbox-dem', exaggeration: 1.3 });

    // Full route (gray background)
    storyMap.addSource('full-route', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: trailData.full_route }
      }
    });

    storyMap.addLayer({
      id: 'full-route-line',
      type: 'line',
      source: 'full-route',
      paint: {
        'line-color': '#ccc',
        'line-width': 2,
        'line-opacity': 0.6,
      }
    });

    // Past route (blue)
    storyMap.addSource('past-route', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }
    });

    storyMap.addLayer({
      id: 'past-route-line',
      type: 'line',
      source: 'past-route',
      paint: {
        'line-color': '#5A7AFF',
        'line-width': 3,
        'line-opacity': 0.9,
      }
    });

    // Current day route (highlighted)
    storyMap.addSource('current-route', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }
    });

    storyMap.addLayer({
      id: 'current-route-line',
      type: 'line',
      source: 'current-route',
      paint: {
        'line-color': '#5A7AFF',
        'line-width': 5,
      }
    });

    // Current position marker
    storyMap.addSource('current-pos', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'Point', coordinates: trailData.full_route[0] } }
    });

    storyMap.addLayer({
      id: 'current-pos-dot',
      type: 'circle',
      source: 'current-pos',
      paint: {
        'circle-radius': 7,
        'circle-color': '#5A7AFF',
        'circle-stroke-width': 3,
        'circle-stroke-color': '#fff',
      }
    });

    // Photo markers
    const photoFeatures = [];
    trailData.days.forEach(day => {
      if (day.photos) {
        day.photos.forEach(p => {
          if (p.lon && p.lat) {
            photoFeatures.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
              properties: { src: p.src }
            });
          }
        });
      }
    });

    storyMap.addSource('photos', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: photoFeatures }
    });

    storyMap.addLayer({
      id: 'photo-markers',
      type: 'circle',
      source: 'photos',
      paint: {
        'circle-radius': 4,
        'circle-color': '#ff6b35',
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#fff',
        'circle-opacity': 0.8,
      }
    });

    // Photo popup on click
    storyMap.on('click', 'photo-markers', (e) => {
      const coords = e.features[0].geometry.coordinates;
      const src = e.features[0].properties.src;
      new mapboxgl.Popup({ maxWidth: '300px' })
        .setLngLat(coords)
        .setHTML(`<img src="${src}" style="width:100%;border-radius:4px;">`)
        .addTo(storyMap);
    });

    storyMap.on('mouseenter', 'photo-markers', () => {
      storyMap.getCanvas().style.cursor = 'pointer';
    });
    storyMap.on('mouseleave', 'photo-markers', () => {
      storyMap.getCanvas().style.cursor = '';
    });

    updateStoryMap(0);
    drawMiniMap('mini-map', 0);
  });
}

function updateStoryMap(dayIndex) {
  if (!storyMap || !storyMap.getSource('past-route')) return;

  const day = trailData.days[dayIndex];
  if (!day) return;

  currentDayIndex = dayIndex;

  // Build past route (all coords up to this day)
  let pastCoords = [];
  for (let i = 0; i < dayIndex; i++) {
    pastCoords = pastCoords.concat(trailData.days[i].coords);
  }

  storyMap.getSource('past-route').setData({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: pastCoords.length > 1 ? pastCoords : [[0,0],[0,0]] }
  });

  // Current day route
  storyMap.getSource('current-route').setData({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: day.coords.length > 1 ? day.coords : [[0,0],[0,0]] }
  });

  // Current position
  const pos = day.end || day.start || trailData.full_route[0];
  storyMap.getSource('current-pos').setData({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: pos }
  });

  // Fly to current day
  if (day.coords.length > 0) {
    const bounds = new mapboxgl.LngLatBounds();
    day.coords.forEach(c => bounds.extend(c));
    storyMap.fitBounds(bounds, {
      padding: { top: 80, bottom: 80, left: 40, right: 40 },
      maxZoom: 12,
      duration: 1200,
    });
  }

  // Update day counter
  document.getElementById('day-counter-day').textContent = `Day ${day.day}`;
  document.getElementById('day-counter-miles').textContent = `${day.cumulative_mi} mi`;

  drawMiniMap('mini-map', dayIndex);
}

/* ===================== MINI MAP ===================== */

function drawMiniMap(canvasId, dayIndex) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  const route = trailData.full_route;
  if (!route || route.length < 2) return;

  // Find bounds
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  route.forEach(([lon, lat]) => {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  });

  const pad = 6;
  const scaleX = (w - pad * 2) / (maxLon - minLon);
  const scaleY = (h - pad * 2) / (maxLat - minLat);

  function project(coord) {
    return [
      pad + (coord[0] - minLon) * scaleX,
      h - pad - (coord[1] - minLat) * scaleY,
    ];
  }

  // Approximate the coordinate index for the current day
  let totalCoords = 0;
  let currentCoordIndex = 0;
  for (let i = 0; i < trailData.days.length; i++) {
    if (i <= dayIndex) currentCoordIndex = totalCoords;
    totalCoords += trailData.days[i].coords.length;
  }
  const routeFraction = currentCoordIndex / Math.max(1, totalCoords);
  const splitIndex = Math.floor(routeFraction * route.length);

  // Draw future (gray)
  ctx.beginPath();
  ctx.strokeStyle = '#ccc';
  ctx.lineWidth = 1.5;
  for (let i = splitIndex; i < route.length; i++) {
    const [x, y] = project(route[i]);
    if (i === splitIndex) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Draw past (blue)
  ctx.beginPath();
  ctx.strokeStyle = '#5A7AFF';
  ctx.lineWidth = 2;
  for (let i = 0; i <= splitIndex && i < route.length; i++) {
    const [x, y] = project(route[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Current position dot
  if (splitIndex < route.length) {
    const [x, y] = project(route[splitIndex]);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#5A7AFF';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/* ===================== SCROLL OBSERVER ===================== */

function initScrollObserver() {
  const panel = document.getElementById('story-panel');
  const cards = document.querySelectorAll('.day-card');

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const idx = parseInt(entry.target.dataset.dayIndex);
        if (idx !== currentDayIndex) {
          updateStoryMap(idx);
          updateProgressBar(idx);
        }
      }
    });
  }, {
    root: panel,
    rootMargin: '-30% 0px -60% 0px',
    threshold: 0,
  });

  cards.forEach(card => observer.observe(card));

  // Also update progress on scroll
  panel.addEventListener('scroll', () => {
    const scrollTop = panel.scrollTop;
    const scrollHeight = panel.scrollHeight - panel.clientHeight;
    const fraction = scrollTop / scrollHeight;
    document.getElementById('progress-fill').style.width = `${fraction * 100}%`;
    document.getElementById('progress-cursor').style.left = `${fraction * 100}%`;
  });
}

function updateProgressBar(dayIndex) {
  const fraction = dayIndex / Math.max(1, trailData.days.length - 1);
  document.getElementById('progress-fill').style.width = `${fraction * 100}%`;
  document.getElementById('progress-cursor').style.left = `${fraction * 100}%`;
}

/* ===================== PROGRESS BAR ===================== */

function initProgressBar() {
  const bar = document.getElementById('progress-bar');

  bar.addEventListener('click', (e) => {
    const rect = bar.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    const dayIndex = Math.round(fraction * (trailData.days.length - 1));

    if (document.getElementById('story-view').classList.contains('active')) {
      // Scroll to the day card
      const card = document.querySelector(`.day-card[data-day-index="${dayIndex}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      // Jump flyover
      flyoverProgress = fraction;
      updateFlyover();
    }
  });
}

/* ===================== VIEW TOGGLE ===================== */

function initViewToggle() {
  const btnStory = document.getElementById('btn-story');
  const btnFlyover = document.getElementById('btn-flyover');

  btnStory.addEventListener('click', () => {
    document.getElementById('story-view').classList.add('active');
    document.getElementById('flyover-view').classList.remove('active');
    btnStory.classList.add('active');
    btnFlyover.classList.remove('active');
    stopFlyover();
    storyMap?.resize();
  });

  btnFlyover.addEventListener('click', () => {
    document.getElementById('story-view').classList.remove('active');
    document.getElementById('flyover-view').classList.add('active');
    btnStory.classList.remove('active');
    btnFlyover.classList.add('active');
    initFlyoverMap();
  });
}

/* ===================== FLYOVER ===================== */

function initFlyoverMap() {
  if (flyoverMap) {
    flyoverMap.resize();
    return;
  }

  // Build flattened coordinate array for smooth flyover
  allCoords = [];
  trailData.days.forEach(day => {
    day.coords.forEach(c => allCoords.push(c));
  });

  flyoverMap = new mapboxgl.Map({
    container: 'flyover-map',
    style: 'mapbox://styles/mapbox/satellite-streets-v12',
    center: allCoords[0],
    zoom: 13,
    pitch: 70,
    bearing: getBearing(allCoords[0], allCoords[Math.min(10, allCoords.length - 1)]),
  });

  flyoverMap.on('load', () => {
    // Add terrain
    flyoverMap.addSource('mapbox-dem', {
      type: 'raster-dem',
      url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
      tileSize: 512,
    });
    flyoverMap.setTerrain({ source: 'mapbox-dem', exaggeration: 1.5 });

    // Trail line
    flyoverMap.addSource('trail-line', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: allCoords }
      }
    });

    flyoverMap.addLayer({
      id: 'trail-line-bg',
      type: 'line',
      source: 'trail-line',
      paint: {
        'line-color': '#fff',
        'line-width': 4,
        'line-opacity': 0.4,
      }
    });

    flyoverMap.addLayer({
      id: 'trail-line-fg',
      type: 'line',
      source: 'trail-line',
      paint: {
        'line-color': '#5A7AFF',
        'line-width': 2,
        'line-opacity': 0.9,
      }
    });

    updateFlyover();
  });

  // Controls
  document.getElementById('flyover-play').addEventListener('click', toggleFlyover);

  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      flyoverSpeed = parseFloat(btn.dataset.speed);
    });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (!document.getElementById('flyover-view').classList.contains('active')) return;
    if (e.code === 'Space') { e.preventDefault(); toggleFlyover(); }
    if (e.code === 'ArrowRight') { flyoverProgress = Math.min(1, flyoverProgress + 0.005); updateFlyover(); }
    if (e.code === 'ArrowLeft') { flyoverProgress = Math.max(0, flyoverProgress - 0.005); updateFlyover(); }
  });
}

function toggleFlyover() {
  flyoverPlaying = !flyoverPlaying;
  document.getElementById('flyover-play').innerHTML = flyoverPlaying ? '&#9646;&#9646;' : '&#9654;';
  if (flyoverPlaying) animateFlyover();
  else cancelAnimationFrame(flyoverAnimId);
}

function stopFlyover() {
  flyoverPlaying = false;
  document.getElementById('flyover-play').innerHTML = '&#9654;';
  cancelAnimationFrame(flyoverAnimId);
}

let lastFlyoverTime = 0;

function animateFlyover(timestamp) {
  if (!flyoverPlaying) return;

  if (!lastFlyoverTime) lastFlyoverTime = timestamp;
  const delta = (timestamp - lastFlyoverTime) / 1000;
  lastFlyoverTime = timestamp;

  // Base speed: traverse entire trail in ~300 seconds at 1x
  const increment = (delta * flyoverSpeed) / 300;
  flyoverProgress = Math.min(1, flyoverProgress + increment);

  updateFlyover();

  if (flyoverProgress >= 1) {
    stopFlyover();
    return;
  }

  flyoverAnimId = requestAnimationFrame(animateFlyover);
}

function updateFlyover() {
  if (!flyoverMap || !allCoords.length) return;

  const idx = Math.floor(flyoverProgress * (allCoords.length - 1));
  const coord = allCoords[idx];
  const nextIdx = Math.min(idx + 20, allCoords.length - 1);
  const bearing = getBearing(coord, allCoords[nextIdx]);

  flyoverMap.easeTo({
    center: coord,
    bearing: bearing,
    duration: 0,
  });

  // Update compass
  const needle = document.getElementById('compass-needle');
  if (needle) needle.style.transform = `rotate(${-bearing}deg)`;

  // Update mile counter
  const currentMile = Math.round(flyoverProgress * trailData.total_miles);
  document.getElementById('flyover-current-mile').textContent = currentMile;

  // Find which day we're on
  let coordCount = 0;
  let dayIdx = 0;
  for (let i = 0; i < trailData.days.length; i++) {
    coordCount += trailData.days[i].coords.length;
    if (coordCount > idx) {
      dayIdx = i;
      break;
    }
  }

  updateFlyoverInfo(dayIdx);
  drawMiniMap('flyover-minimap', dayIdx);

  // Update progress bar
  document.getElementById('progress-fill').style.width = `${flyoverProgress * 100}%`;
  document.getElementById('progress-cursor').style.left = `${flyoverProgress * 100}%`;
}

function updateFlyoverInfo(dayIndex) {
  const day = trailData.days[dayIndex];
  if (!day) return;

  const dateFormatted = new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric'
  });

  document.getElementById('flyover-day-label').textContent = `Day ${day.day} · ${dateFormatted}`;
  document.getElementById('flyover-day-name').textContent = day.name;
  document.getElementById('flyover-stats').innerHTML = `
    <div class="stat"><span class="stat-value">${day.distance_mi}</span><span class="stat-label">Miles</span></div>
    <div class="stat"><span class="stat-value">${day.elev_gain_ft.toLocaleString()}</span><span class="stat-label">Elev (ft)</span></div>
    <div class="stat"><span class="stat-value">${day.moving_time || '—'}</span><span class="stat-label">Time</span></div>
  `;

  // Photo
  const photoEl = document.getElementById('flyover-photo');
  if (day.photos && day.photos.length > 0) {
    photoEl.innerHTML = `<img src="${day.photos[0].src}" alt="Day ${day.day}">`;
    photoEl.style.height = '180px';
  } else {
    photoEl.innerHTML = '';
    photoEl.style.height = '0';
  }
}

/* ===================== UTILS ===================== */

function getBearing(start, end) {
  const startLat = start[1] * Math.PI / 180;
  const startLng = start[0] * Math.PI / 180;
  const endLat = end[1] * Math.PI / 180;
  const endLng = end[0] * Math.PI / 180;

  const dLng = endLng - startLng;
  const x = Math.sin(dLng) * Math.cos(endLat);
  const y = Math.cos(startLat) * Math.sin(endLat) -
            Math.sin(startLat) * Math.cos(endLat) * Math.cos(dLng);

  return ((Math.atan2(x, y) * 180 / Math.PI) + 360) % 360;
}

/* ===================== START ===================== */

document.addEventListener('DOMContentLoaded', init);
