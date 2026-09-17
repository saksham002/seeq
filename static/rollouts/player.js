"use strict";

const tasks = window.SEEQ_ROLLOUTS;
let activeRow = null;
const rows = [];
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function makeVideo(recording, label) {
  const video = document.createElement("video");
  video.src = recording.src;
  video.poster = recording.poster;
  video.preload = "none";
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("aria-label", label);
  return video;
}

function makeChart(container, recording) {
  const width = 720, height = 405;
  const left = 95, right = 696, top = 28, bottom = 340;
  const samples = recording.samples;
  const maximum = Math.max(1, ...samples.filter((s) => s.value !== null).map((s) => s.value));
  const ceiling = Math.ceil(maximum * 10) / 10;
  const x = (time) => left + Math.max(0, Math.min(recording.duration, time)) / recording.duration * (right - left);
  const y = (value) => bottom - value / ceiling * (bottom - top);
  let path = "", connected = false;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    if (sample.time < 0 && index + 1 < samples.length && samples[index + 1].time < 0) continue;
    if (sample.value === null) { connected = false; continue; }
    path += `${connected ? "L" : "M"}${x(sample.time).toFixed(2)},${y(sample.value).toFixed(2)} `;
    connected = true;
  }
  const horizontal = Array.from({ length: 5 }, (_, index) => {
    const value = index * ceiling / 4;
    return `<line class="grid-line" x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}" stroke="#e2e9e4"/>
      <text x="${left - 12}" y="${y(value) + 6}" text-anchor="end">${value.toFixed(2)}</text>`;
  }).join("");
  const ticks = Array.from({ length: 5 }, (_, index) => {
    const time = recording.duration * index / 4;
    return `<text x="${x(time)}" y="${bottom + 27}" text-anchor="middle">${Math.round(time)}</text>`;
  }).join("");
  container.innerHTML = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="SeeQ value over video time">
    ${horizontal}${ticks}
    <text class="axis-label" transform="translate(20 184) rotate(-90)" text-anchor="middle">Value</text>
    <text class="axis-label" x="383" y="391" text-anchor="middle">Video time (s)</text>
    <path class="value-path" d="${path}" fill="none" stroke="#6eb8a8" stroke-width="2.4" stroke-linejoin="round"/>
    <line class="cursor" x1="${left}" x2="${left}" y1="${top}" y2="${bottom}" stroke="#007f70" stroke-width="1.5" stroke-dasharray="5 5"/>
    <circle class="current-value" r="5" fill="#007f70" stroke="white" stroke-width="2" visibility="hidden"/>
  </svg><div class="value-readout">SeeQ value <strong>—</strong></div>`;
  const cursor = container.querySelector(".cursor");
  const point = container.querySelector(".current-value");
  const readout = container.querySelector("strong");
  return (time, sample) => {
    cursor.setAttribute("x1", x(time));
    cursor.setAttribute("x2", x(time));
    const hasValue = sample !== null && sample.value !== null;
    point.setAttribute("visibility", hasValue ? "visible" : "hidden");
    if (hasValue) {
      point.setAttribute("cx", x(sample.time));
      point.setAttribute("cy", y(sample.value));
    }
    readout.textContent = hasValue ? sample.value.toFixed(3) : "—";
  };
}

function makeRow(task, pair) {
  const element = document.createElement("article");
  element.className = "episode";
  element.dataset.episode = pair.episode;
  element.setAttribute("aria-label", `${task.title}, episode ${pair.episode}`);
  element.innerHTML = `<div class="episode-top"><span class="episode-number">Episode ${pair.episode}</span></div>
    <div class="episode-grid">
      <div class="bc-column"><div class="video-shell"></div></div>
      <div class="seeq-column"><div class="video-shell"></div><div class="subtask"><span class="subtask-label">Predicted subtask</span><span class="subtask-text">—</span></div></div>
      <div class="chart-column"></div>
    </div>
    <div class="controls"><button class="play" type="button">Play pair</button><input class="timeline" type="range" min="0" step="0.01" value="0" aria-label="Seek ${task.title}, episode ${pair.episode}"><span class="time"></span></div>
    <p class="playback-status" role="status"></p>`;
  const bc = makeVideo(pair.bc, `BC · ${task.title} · episode ${pair.episode}`);
  const seeq = makeVideo(pair.seeq, `SeeQ · ${task.title} · episode ${pair.episode}`);
  element.querySelector(".bc-column .video-shell").append(bc);
  element.querySelector(".seeq-column .video-shell").append(seeq);
  const videos = [bc, seeq];
  const durations = [pair.bc.duration, pair.seeq.duration];
  const duration = Math.max(...durations);
  const master = durations[0] >= durations[1] ? bc : seeq;
  const button = element.querySelector(".play");
  const timeline = element.querySelector(".timeline");
  const timeLabel = element.querySelector(".time");
  const prediction = element.querySelector(".subtask-text");
  const status = element.querySelector(".playback-status");
  const drawChart = makeChart(element.querySelector(".chart-column"), pair.seeq);
  timeline.max = duration;
  const readiness = [null, null];
  let frame = 0, playing = false, position = 0, generation = 0;

  function loadVideo(index) {
    const video = videos[index];
    if (video.readyState >= 2) return Promise.resolve();
    if (readiness[index] === null) {
      readiness[index] = new Promise((resolve, reject) => {
        video.addEventListener("loadeddata", resolve, { once: true });
        video.addEventListener("error", () => reject(new Error(`Could not load ${video.src}`)), { once: true });
        video.preload = "auto";
        video.load();
      });
    }
    return readiness[index];
  }

  function render(time) {
    position = time;
    timeline.value = time;
    timeLabel.textContent = `${clock(time)} / ${clock(duration)}`;
    const seeqTime = Math.min(time, pair.seeq.duration);
    let sample = null;
    for (const candidate of pair.seeq.samples) {
      if (candidate.time > seeqTime) break;
      sample = candidate;
    }
    prediction.textContent = sample === null || sample.subtask === "" ? "—" : sample.subtask;
    drawChart(seeqTime, sample);
  }

  function tick() {
    if (!playing) return;
    const time = master.currentTime;
    videos.forEach((video, index) => {
      if (!video.seeking && time < durations[index] && Math.abs(video.currentTime - time) > 0.18) {
        video.currentTime = time;
      }
    });
    render(time);
    frame = requestAnimationFrame(tick);
  }

  function pause() {
    generation++;
    playing = false;
    videos.forEach((video) => {
      video.pause();
      video.preload = "none";
    });
    cancelAnimationFrame(frame);
    button.textContent = position >= duration - 0.1 ? "Replay pair" : "Play pair";
    button.setAttribute("aria-pressed", "false");
  }

  function seek(time) {
    render(time);
    videos.forEach((video, index) => {
      if (video.readyState >= 2) {
        video.currentTime = Math.min(time, durations[index]);
      } else {
        loadVideo(index).then(() => {
          video.currentTime = Math.min(position, durations[index]);
        }).catch(() => { status.textContent = "The video could not load. Reload the page to try again."; });
      }
    });
  }

  async function play() {
    if (activeRow !== null && activeRow !== row) activeRow.pause();
    activeRow = row;
    if (position >= duration - 0.1) seek(0);
    status.textContent = "";
    playing = true;
    button.textContent = "Loading…";
    button.setAttribute("aria-pressed", "true");
    const attempt = ++generation;
    try {
      await Promise.all(videos.map((video, index) => position < durations[index] ? video.play() : loadVideo(index)));
      if (attempt !== generation || !playing) return;
      seek(position);
      button.textContent = "Pause pair";
      if (attempt === generation && playing) frame = requestAnimationFrame(tick);
    } catch (error) {
      if (attempt !== generation) return;
      pause();
      status.textContent = "The video could not play. Try playing the pair again.";
      console.error(error);
    }
  }

  button.addEventListener("click", () => playing ? pause() : play());
  timeline.addEventListener("input", () => {
    pause();
    seek(Number(timeline.value));
  });
  master.addEventListener("ended", () => { render(duration); pause(); });
  const row = { pause, element };
  rows.push(row);
  render(0);
  return element;
}

for (const task of tasks) {
  const section = document.getElementById(task.id);
  section.querySelector("h3").textContent = task.title;
  section.querySelector(".rollout-pairs").innerHTML = `<p class="task-meta">${task.pairs.length} episode pairs · ${task.speed}× speed</p>
    <p class="scroll-hint">Swipe across to compare both videos and the value chart.</p>
    <div class="comparison-scroll"><div class="comparison"><div class="columns"><span>BC</span><span>SeeQ</span><span>SeeQ value</span></div></div></div>`;
  for (const pair of task.pairs) section.querySelector(".comparison").append(makeRow(task, pair));
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) rows.forEach((row) => row.pause());
});
