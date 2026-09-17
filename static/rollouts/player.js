"use strict";

const tasks = window.SEEQ_ROLLOUTS;
const rows = [];

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
  const left = 118, right = 696, top = 28, bottom = 340;
  const samples = recording.samples;
  const clipId = `value-plot-${recording.src.replace(/\W/g, "_")}`;
  const x = (time) => left + Math.max(0, Math.min(recording.duration, time)) / recording.duration * (right - left);
  const y = (value) => bottom - value * (bottom - top);
  let path = "", connected = false;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    if (sample.time < 0 && index + 1 < samples.length && samples[index + 1].time < 0) continue;
    if (sample.value === null) { connected = false; continue; }
    path += `${connected ? "L" : "M"}${x(sample.time).toFixed(2)},${y(sample.value).toFixed(2)} `;
    connected = true;
  }
  const horizontal = Array.from({ length: 5 }, (_, index) => {
    const value = index / 4;
    return `<line class="grid-line" x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}" stroke="#e2e9e4"/>
      <text x="${left - 12}" y="${y(value) + 6}" text-anchor="end">${value}</text>`;
  }).join("");
  const startSeconds = recording.trimStart;
  const endSeconds = startSeconds + recording.duration * recording.speed;
  const rawInterval = (endSeconds - startSeconds) / 6;
  const magnitude = 10 ** Math.floor(Math.log10(rawInterval));
  const interval = [1, 2, 2.5, 5, 10].find((factor) => factor * magnitude >= rawInterval) * magnitude;
  const firstTick = Math.ceil(startSeconds / interval) * interval;
  const ticks = Array.from({ length: Math.floor((endSeconds - firstTick) / interval) + 1 }, (_, index) => {
    const seconds = firstTick + index * interval;
    return `<text x="${x((seconds - startSeconds) / recording.speed)}" y="${bottom + 27}" text-anchor="middle">${seconds}</text>`;
  }).join("");
  container.innerHTML = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="SeeQ value over elapsed seconds before video speedup">
    <defs><clipPath id="${clipId}"><rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}"/></clipPath></defs>
    ${horizontal}${ticks}
    <text class="axis-label" transform="translate(20 184) rotate(-90)" text-anchor="middle">Value</text>
    <text class="axis-label" x="407" y="391" text-anchor="middle">Time (s)</text>
    <g clip-path="url(#${clipId})">
    <path class="value-path" d="${path}" fill="none" stroke="#6eb8a8" stroke-width="2.4" stroke-linejoin="round"/>
    <line class="cursor" x1="${left}" x2="${left}" y1="${top}" y2="${bottom}" stroke="#007f70" stroke-width="1.5" stroke-dasharray="5 5"/>
    <circle class="current-value" r="5" fill="#007f70" stroke="white" stroke-width="2" visibility="hidden"/>
    </g>
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
      <div class="seeq-column"><div class="video-shell"></div><div class="subtask"><span class="subtask-label">Predicted Subtask</span><span class="subtask-text">—</span></div></div>
      <div class="chart-column"></div>
    </div>
    <p class="playback-status" role="status"></p>`;
  const bc = makeVideo(pair.bc, `BC · ${task.title} · episode ${pair.episode}`);
  const seeq = makeVideo(pair.seeq, `SeeQ · ${task.title} · episode ${pair.episode}`);
  element.querySelector(".bc-column .video-shell").append(bc);
  element.querySelector(".seeq-column .video-shell").append(seeq);
  const videos = [bc, seeq];
  const durations = [pair.bc.duration, pair.seeq.duration];
  const master = durations[0] >= durations[1] ? bc : seeq;
  const prediction = element.querySelector(".subtask-text");
  const status = element.querySelector(".playback-status");
  const drawChart = makeChart(element.querySelector(".chart-column"), pair.seeq);
  let frame = 0, playing = false, generation = 0;

  function render() {
    const seeqTime = seeq.currentTime;
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
    if (videos.some((video) => video.error)) {
      pause();
      status.textContent = "The video could not load. Reload the page to try again.";
      return;
    }
    const time = master.currentTime;
    const activeVideos = videos.filter((video) => !video.ended);
    const buffering = activeVideos.some((video) => video.readyState < 3 || video.seeking);
    activeVideos.forEach((video) => {
      // Keep the buffering video loading while holding its partner at the current frame.
      if (buffering && video.readyState >= 3 && !video.seeking) {
        video.pause();
      } else {
        // Correct drift gradually: seeking a playing video can trap it in a rewind loop.
        video.playbackRate = Math.max(0.9, Math.min(1.1, 1 + (time - video.currentTime) * 0.5));
        if (video.paused) {
          const attempt = generation;
          video.play().catch((error) => {
            if (attempt !== generation || error.name === "AbortError") return;
            pause();
            status.textContent = "The video could not play. Reload the page to try again.";
            console.error(error);
          });
        }
      }
    });
    render();
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
    render();
  }

  function play() {
    if (playing) return;
    if (master.ended) videos.forEach((video) => { video.currentTime = 0; });
    status.textContent = "";
    playing = true;
    generation++;
    videos.forEach((video) => { video.preload = "auto"; });
    tick();
  }

  master.addEventListener("ended", () => {
    pause();
    if (row.visible && !document.hidden) play();
  });
  const row = { play, pause, element, visible: false };
  rows.push(row);
  render();
  return element;
}

for (const task of tasks) {
  const section = document.getElementById(task.id);
  section.querySelector("h3").textContent = task.title;
  section.querySelector(".rollout-pairs").innerHTML = `<p class="task-meta">${task.speed}× speed</p>
    <p class="scroll-hint">Swipe across to compare both videos and the value chart.</p>
    <div class="comparison-scroll"><div class="comparison"><div class="columns"><span>BC</span><span>SeeQ</span><span>SeeQ Value</span></div></div></div>`;
  for (const pair of task.pairs) section.querySelector(".comparison").append(makeRow(task, pair));
}

const rowByElement = new Map(rows.map((row) => [row.element, row]));
let observer;

function observeRows() {
  if (observer) observer.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const row = rowByElement.get(entry.target);
      row.visible = entry.isIntersecting;
      if (row.visible && !document.hidden) row.play();
      else row.pause();
    }
  }, { rootMargin: `0px 0px -${window.innerHeight / 3}px 0px`, threshold: 0 });
  rows.forEach((row) => observer.observe(row.element));
}

observeRows();
window.addEventListener("resize", observeRows);
document.addEventListener("visibilitychange", () => {
  rows.forEach((row) => {
    if (row.visible && !document.hidden) row.play();
    else row.pause();
  });
});
