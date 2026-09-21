"use strict";

// Interactive explorer for one held-out shirt-hang demonstration: the base-camera video with the
// eight cached pi0.5 candidate chunks projected onto it, gripper magnifiers, the per-frame
// candidate ranking by SeeQ Q-value, and a scrubbable timeline of subtasks and values.
// Data comes from scripts/prepare_explorer.py (data.json + paths.bin).
(function () {
  const mount = document.getElementById("explorer-app");
  if (!mount || !("fetch" in window)) return;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ARM_LABELS = { left: "Left gripper", right: "Right gripper" };
  const SCALE_BAR_METRES = 0.02;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svgElement(tag, attributes) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes || {})) node.setAttribute(key, value);
    return node;
  }

  function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds - minutes * 60;
    return `${minutes}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
  }

  function pathData(points) {
    return points.map(([u, v], index) => `${index ? "L" : "M"}${u.toFixed(1)},${v.toFixed(1)}`).join(" ");
  }

  async function load() {
    const source = new URL(mount.dataset.src, location.href);
    const data = await (await fetch(source)).json();
    // The binary is versioned with the same query as data.json so both refresh together.
    const pathsUrl = new URL(data.paths.file, location.href);
    pathsUrl.search = source.search;
    const buffer = await (await fetch(pathsUrl)).arrayBuffer();
    return { data, paths: new Int16Array(buffer) };
  }

  load().then(build).catch((error) => {
    mount.replaceChildren(element("p", "explorer-loading", "The explorer could not load its data. Reload the page to try again."));
    console.error(error);
  });

  function build({ data, paths }) {
    const N = data.numFrames;
    const FPS = data.fps;
    const SAMPLES = data.paths.numSamples;
    const POINTS = data.paths.steps.length;
    const PER_ARM = data.paths.perArm;
    const ARMS = data.paths.arms;
    const WIDTH = data.video.width;
    const HEIGHT = data.video.height;
    if (paths.length !== N * ARMS.length * PER_ARM) throw new Error("paths.bin does not match data.json");

    const geometry = {
      base(frame, arm) { return (frame * ARMS.length + arm) * PER_ARM; },
      tcp(frame, arm) {
        const base = this.base(frame, arm);
        return { u: paths[base] / 10, v: paths[base + 1] / 10, depth: paths[base + 2] / 1000 };
      },
      candidate(frame, arm, sample) {
        const base = this.base(frame, arm) + 3 + sample * POINTS * 2;
        return Array.from({ length: POINTS }, (_, k) => [paths[base + k * 2] / 10, paths[base + k * 2 + 1] / 10]);
      },
    };

    function expandRuns(runs) {
      const labels = new Int8Array(N).fill(-1);
      for (const [label, start, end] of runs) labels.fill(label, start, end + 1);
      return labels;
    }
    const predictedAt = expandRuns(data.predicted);
    const annotatedAt = expandRuns(data.annotated);
    const bestValue = data.q.map((values) => Math.max(...values));

    function ranking(frame) {
      const values = data.q[frame];
      return Array.from(values.keys()).sort((a, b) => values[b] - values[a]);
    }

    // ------------------------------------------------------------------ layout
    mount.replaceChildren();
    mount.tabIndex = 0;
    mount.setAttribute("role", "region");
    mount.setAttribute("aria-label", "SeeQ explorer for a held-out shirt-hang demonstration");
    const grid = element("div", "explorer-grid");
    const view = element("div", "explorer-view");
    const panel = element("div", "explorer-panel");
    grid.append(view, panel);
    mount.append(grid);

    const stage = element("div", "stage");
    const video = document.createElement("video");
    video.src = data.video.src;
    video.poster = data.video.poster;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.loop = true;
    video.setAttribute("aria-label", "Base camera view of the held-out shirt-hang demonstration");
    const overlay = svgElement("svg", { class: "overlay", viewBox: `0 0 ${WIDTH} ${HEIGHT}`, preserveAspectRatio: "none", "aria-hidden": "true" });
    const badge = element("span", "badge mono");
    stage.append(video, overlay, badge);
    view.append(stage);

    const overlayArms = ARMS.map(() => {
      const group = svgElement("g");
      const layers = {
        crop: svgElement("rect", { class: "crop" }),
        candidates: Array.from({ length: SAMPLES }, () => svgElement("path", { class: "cand" })),
        bestHalo: svgElement("path", { class: "halo" }),
        best: svgElement("path", { class: "best" }),
        tcpOuter: svgElement("circle", { class: "tcp-outer", r: 5 }),
        tcp: svgElement("circle", { class: "tcp", r: 5 }),
      };
      group.append(layers.crop, ...layers.candidates, layers.bestHalo, layers.best, layers.tcpOuter, layers.tcp);
      overlay.append(group);
      return layers;
    });

    const magnifiers = element("div", "magnifiers");
    const magnifierArms = ARMS.map((arm) => {
      const box = element("div", "magnifier");
      const canvas = document.createElement("canvas");
      canvas.setAttribute("aria-label", `${ARM_LABELS[arm]} magnified, with the candidate paths`);
      box.append(canvas, element("span", "label", ARM_LABELS[arm]));
      magnifiers.append(box);
      return { canvas, context: canvas.getContext("2d"), half: null, frame: -1 };
    });
    view.append(magnifiers);

    const subtaskBlock = element("div", "subtask-block");
    const subtaskNow = element("div", "subtask-now", "—");
    const subtaskAnnotated = element("div", "subtask-annotated");
    const subtaskMark = element("span", "mark");
    const subtaskAnnotatedText = element("span");
    subtaskAnnotated.append(subtaskMark, subtaskAnnotatedText);
    subtaskBlock.append(element("div", "kicker", "Predicted subtask"), subtaskNow, subtaskAnnotated);
    panel.append(subtaskBlock);

    const rankingBlock = element("div", "ranking");
    rankingBlock.append(element("div", "kicker", "Candidate action chunks ranked by SeeQ"));
    const table = element("table");
    const head = element("tr");
    for (const [label, className] of [["#", ""], ["Q-value", ""], ["", "num"], ["Gripper motion over 1 s", "detail"]]) {
      const cell = element("th", className, label);
      cell.scope = "col";
      head.append(cell);
    }
    table.append(head);
    const rows = Array.from({ length: SAMPLES }, (_, rank) => {
      const row = element("tr", "candidate");
      const rankCell = element("td", "rank", String(rank + 1));
      const trackCell = element("td", "track-cell");
      const track = element("div", "track");
      const dot = element("span", "dot");
      track.append(dot);
      trackCell.append(track);
      const qCell = element("td", "q num");
      const detailCell = element("td", "detail");
      row.append(rankCell, trackCell, qCell, detailCell);
      table.append(row);
      return { row, dot, qCell, detailCell };
    });
    rankingBlock.append(table);
    const axis = element("div", "axis");
    const axisLow = element("span");
    const axisHigh = element("span");
    axis.append(axisLow, axisHigh);
    rankingBlock.append(axis);
    panel.append(rankingBlock);

    const hint = element("p", "hint");
    hint.append(
      keySwatch("var(--accent)"), "highest-valued candidate · ",
      keySwatch("rgba(120,120,120,0.9)"), "other candidates. ",
      "Each path is where that chunk would take the gripper over the next second.",
    );
    panel.append(hint);

    function keySwatch(color) {
      const key = element("span", "key");
      key.style.background = color;
      return key;
    }

    // Controls
    const controls = element("div", "controls");
    const playButton = element("button");
    playButton.type = "button";
    const stepBack = element("button");
    stepBack.type = "button";
    stepBack.title = "Previous frame";
    stepBack.setAttribute("aria-label", "Previous frame");
    stepBack.innerHTML = '<svg viewBox="0 0 16 16"><path d="M3 2h2v12H3zM13 2 6 8l7 6z"/></svg>';
    const stepForward = element("button");
    stepForward.type = "button";
    stepForward.title = "Next frame";
    stepForward.setAttribute("aria-label", "Next frame");
    stepForward.innerHTML = '<svg viewBox="0 0 16 16"><path d="M11 2h2v12h-2zM3 2l7 6-7 6z"/></svg>';
    const timeText = element("span", "time");
    const speed = element("select");
    speed.setAttribute("aria-label", "Playback speed");
    for (const rate of [0.5, 1, 2]) {
      const option = element("option", "", `${rate}×`);
      option.value = String(rate);
      if (rate === 1) option.selected = true;
      speed.append(option);
    }
    const keys = element("span", "keys", "Space plays or pauses · ← → step one frame");
    controls.append(playButton, stepBack, stepForward, timeText, speed, keys);
    view.append(controls);

    // Timeline
    const timeline = element("div", "timeline");
    const legend = element("div", "tl-legend");
    legend.append(legendItem("var(--accent)", "SeeQ value of the best candidate"), legendItem("var(--ink-2)", "Return-to-go of the annotated subtask"));
    const timelineSvg = svgElement("svg", { role: "img", "aria-label": "Predicted and annotated subtasks and the SeeQ value over the episode; drag to scrub" });
    const tooltip = element("div", "tooltip");
    tooltip.hidden = true;
    const scrubber = document.createElement("input");
    scrubber.type = "range";
    scrubber.className = "scrubber";
    scrubber.min = "0";
    scrubber.max = String(N - 1);
    scrubber.step = "1";
    scrubber.value = "0";
    scrubber.setAttribute("aria-label", "Frame");
    timeline.append(legend, timelineSvg, tooltip, scrubber);
    const subtaskKey = element("p", "subtask-key");
    data.subtasks.forEach((name, index) => {
      const item = element("span");
      item.append(element("b", "", String(index + 1)), name);
      subtaskKey.append(item);
      if (index + 1 < data.subtasks.length) subtaskKey.append(" · ");
    });
    timeline.append(subtaskKey);
    view.append(timeline);

    function legendItem(color, label) {
      const item = element("span");
      const key = element("span", "key");
      key.style.background = color;
      item.append(key, label);
      return item;
    }

    // ------------------------------------------------------------------ timeline geometry
    const TL = { left: 78, right: 18, top: 8, strip: 14, stripGap: 4, chartGap: 16, bottom: 26, height: 236 };
    // The scrubber's thumb is THUMB px wide (see explorer.css), so its centre travels from x0 to x1
    // when the input starts THUMB / 2 before the plot and is THUMB wider than it.
    const THUMB = 14;
    const plot = { x0: 0, x1: 0, y0: 0, y1: 0, width: 0 };
    let hoverLine, cursorLine, cursorDot, currentSpans;

    function x(frame) { return plot.x0 + (frame / (N - 1)) * plot.width; }
    function y(value) { return plot.y1 - Math.max(0, Math.min(1, value)) * (plot.y1 - plot.y0); }
    function frameAtX(px) { return Math.max(0, Math.min(N - 1, Math.round(((px - plot.x0) / plot.width) * (N - 1)))); }

    function layoutTimeline() {
      const width = timeline.clientWidth;
      if (!width) return;
      plot.x0 = TL.left;
      plot.x1 = width - TL.right;
      plot.width = plot.x1 - plot.x0;
      const stripY = [TL.top, TL.top + TL.strip + TL.stripGap];
      plot.y0 = stripY[1] + TL.strip + TL.chartGap + 6;
      plot.y1 = TL.height - TL.bottom;
      timelineSvg.setAttribute("viewBox", `0 0 ${width} ${TL.height}`);
      timelineSvg.setAttribute("width", width);
      timelineSvg.setAttribute("height", TL.height);
      timelineSvg.replaceChildren();
      const scrubberWidth = `${plot.width + THUMB}px`;
      if (scrubber.style.width !== scrubberWidth) {
        scrubber.style.marginLeft = `${plot.x0 - THUMB / 2}px`;
        scrubber.style.width = scrubberWidth;
      }

      const strips = [["Predicted", data.predicted, stripY[0]], ["Annotated", data.annotated, stripY[1]]];
      currentSpans = [];
      strips.forEach(([label, runs, top], stripIndex) => {
        const text = svgElement("text", { class: "strip-label", x: plot.x0 - 8, y: top + TL.strip - 3, "text-anchor": "end" });
        text.textContent = label;
        timelineSvg.append(text);
        runs.forEach(([subtask, start, end], index) => {
          const left = x(start), right = x(Math.min(N - 1, end + 1));
          timelineSvg.append(svgElement("rect", { class: `span${index % 2 ? " alt" : ""}`, x: left, y: top, width: Math.max(0, right - left - 1), height: TL.strip }));
          if (right - left > 16) {
            const number = svgElement("text", { class: "strip-number", x: (left + right) / 2, y: top + TL.strip - 3, "text-anchor": "middle" });
            number.textContent = String(subtask + 1);
            timelineSvg.append(number);
          }
        });
        const current = svgElement("rect", { class: "span-current", x: 0, y: top - 1, width: 0, height: TL.strip + 2, rx: 1 });
        currentSpans[stripIndex] = current;
        timelineSvg.append(current);
      });
      // Frames where the decoded subtask differs from the annotation.
      for (let frame = 0; frame < N; frame++) {
        if (predictedAt[frame] === annotatedAt[frame]) continue;
        let end = frame;
        while (end + 1 < N && predictedAt[end + 1] !== annotatedAt[end + 1]) end++;
        timelineSvg.append(svgElement("rect", { class: "disagree", x: x(frame), y: stripY[1] + TL.strip + 3, width: Math.max(1, x(end) - x(frame)), height: 2 }));
        frame = end;
      }

      for (const value of [0, 0.5, 1]) {
        timelineSvg.append(svgElement("line", { class: value === 0 ? "axis-line" : "grid", x1: plot.x0, x2: plot.x1, y1: y(value), y2: y(value) }));
        const tick = svgElement("text", { class: "tick", x: plot.x0 - 8, y: y(value) + 4, "text-anchor": "end" });
        tick.textContent = value.toFixed(1);
        timelineSvg.append(tick);
      }
      const seconds = (N - 1) / FPS;
      for (let t = 0; t <= seconds; t += 10) {
        const px = x(t * FPS);
        timelineSvg.append(svgElement("line", { class: "axis-line", x1: px, x2: px, y1: plot.y1, y2: plot.y1 + 4 }));
        const tick = svgElement("text", { class: "tick", x: px, y: plot.y1 + 18, "text-anchor": t === 0 ? "start" : "middle" });
        tick.textContent = `${t} s`;
        timelineSvg.append(tick);
      }
      const axisTitle = svgElement("text", { class: "tick", transform: `translate(14 ${(plot.y0 + plot.y1) / 2}) rotate(-90)`, "text-anchor": "middle" });
      axisTitle.textContent = "Value";
      timelineSvg.append(axisTitle);

      const returnPath = data.returnToGo.map((value, frame) => `${frame ? "L" : "M"}${x(frame).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
      const valuePath = bestValue.map((value, frame) => `${frame ? "L" : "M"}${x(frame).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
      timelineSvg.append(svgElement("path", { class: "series-return", d: returnPath }));
      timelineSvg.append(svgElement("path", { class: "series-value", d: valuePath }));

      hoverLine = svgElement("line", { class: "hover-line", x1: 0, x2: 0, y1: stripY[0], y2: plot.y1, visibility: "hidden" });
      cursorLine = svgElement("line", { class: "cursor", x1: 0, x2: 0, y1: stripY[0], y2: plot.y1 });
      cursorDot = svgElement("circle", { class: "cursor-dot", r: 5 });
      timelineSvg.append(hoverLine, cursorLine, cursorDot);
      if (currentFrame >= 0) draw(currentFrame);
    }

    // ------------------------------------------------------------------ state
    let currentFrame = -1;
    let playing = false;
    let userPaused = false;
    let inView = false;
    let animation = 0;

    function accentColor() {
      return getComputedStyle(mount).getPropertyValue("--accent").trim() || "#1f7a4d";
    }

    // ------------------------------------------------------------------ drawing
    function draw(frame) {
      currentFrame = frame;
      const order = ranking(frame);
      const values = data.q[frame];
      const best = order[0];
      const accent = accentColor();

      const predicted = predictedAt[frame];
      const annotated = annotatedAt[frame];
      subtaskNow.textContent = predicted >= 0 ? data.subtasks[predicted] : "—";
      const agrees = predicted === annotated;
      subtaskMark.textContent = agrees ? "✓" : "≠";
      subtaskMark.classList.toggle("differs", !agrees);
      subtaskAnnotatedText.textContent = agrees ? "Matches the annotated subtask" : `Annotated: ${data.subtasks[annotated]}`;

      const high = values[best];
      const low = values[order[SAMPLES - 1]];
      const pad = Math.max((high - low) * 0.25, 0.002);
      const axisLo = low - pad;
      const axisHi = high + pad;
      axisLow.textContent = axisLo.toFixed(3);
      axisHigh.textContent = axisHi.toFixed(3);
      rows.forEach((entry, rank) => {
        const sample = order[rank];
        entry.row.classList.toggle("best", rank === 0);
        entry.dot.style.left = `${(((values[sample] - axisLo) / (axisHi - axisLo)) * 100).toFixed(2)}%`;
        entry.qCell.textContent = values[sample].toFixed(3);
        entry.detailCell.replaceChildren();
        const motion = data.moveCm[frame][sample];
        entry.detailCell.append(`L ${motion[0].toFixed(1)} · R ${motion[1].toFixed(1)} cm`);
        ARMS.forEach((arm, armIndex) => {
          const change = data.gripperTarget[frame][sample][armIndex] - data.gripperCurrent[frame][armIndex];
          if (Math.abs(change) < 0.3) return;
          entry.detailCell.append(element("span", "tag", `${change < 0 ? "closes" : "opens"} ${arm[0].toUpperCase()}`));
        });
      });

      ARMS.forEach((arm, armIndex) => {
        const layers = overlayArms[armIndex];
        const tcp = geometry.tcp(frame, armIndex);
        const candidates = order.map((sample) => geometry.candidate(frame, armIndex, sample));
        order.forEach((sample, rank) => {
          const path = layers.candidates[sample];
          path.setAttribute("d", rank === 0 ? "" : pathData(candidates[rank]));
        });
        const bestData = pathData(candidates[0]);
        layers.bestHalo.setAttribute("d", bestData);
        layers.best.setAttribute("d", bestData);
        layers.tcpOuter.setAttribute("cx", tcp.u);
        layers.tcpOuter.setAttribute("cy", tcp.v);
        layers.tcp.setAttribute("cx", tcp.u);
        layers.tcp.setAttribute("cy", tcp.v);
        const crop = drawMagnifier(magnifierArms[armIndex], frame, candidates, tcp, accent);
        if (crop) {
          layers.crop.setAttribute("x", crop.sx);
          layers.crop.setAttribute("y", crop.sy);
          layers.crop.setAttribute("width", crop.sw);
          layers.crop.setAttribute("height", crop.sh);
        }
      });

      badge.textContent = `Frame ${frame + 1} / ${N}`;
      timeText.textContent = `${formatTime(frame / FPS)} / ${formatTime((N - 1) / FPS)}`;
      if (document.activeElement !== scrubber) scrubber.value = String(frame);
      if (cursorLine) {
        const px = x(frame);
        cursorLine.setAttribute("x1", px);
        cursorLine.setAttribute("x2", px);
        cursorDot.setAttribute("cx", px);
        cursorDot.setAttribute("cy", y(bestValue[frame]));
        [data.predicted, data.annotated].forEach((runs, stripIndex) => {
          const run = runs.find(([, start, end]) => frame >= start && frame <= end);
          const rect = currentSpans[stripIndex];
          if (!run) { rect.setAttribute("width", 0); return; }
          const left = x(run[1]), right = x(Math.min(N - 1, run[2] + 1));
          rect.setAttribute("x", left);
          rect.setAttribute("width", Math.max(0, right - left - 1));
        });
      }
    }

    function drawMagnifier(state, frame, candidates, tcp, accent) {
      const canvas = state.canvas;
      const context = state.context;
      const ratio = window.devicePixelRatio || 1;
      const cssWidth = canvas.clientWidth;
      const cssHeight = canvas.clientHeight;
      if (!cssWidth || !cssHeight) return null;
      const pixelWidth = Math.round(cssWidth * ratio);
      const pixelHeight = Math.round(cssHeight * ratio);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      let extent = 0;
      for (const points of candidates) {
        for (const [u, v] of points) extent = Math.max(extent, Math.abs(u - tcp.u), (Math.abs(v - tcp.v) * cssWidth) / cssHeight);
      }
      let half = Math.min(Math.max(extent * 1.3 + 12, 32), 150);
      if (state.half !== null && Math.abs(frame - state.frame) <= 3) half = state.half + (half - state.half) * 0.12;
      state.half = half;
      state.frame = frame;
      const sw = half * 2;
      const sh = (sw * cssHeight) / cssWidth;
      const sx = tcp.u - half;
      const sy = tcp.v - sh / 2;
      const scale = pixelWidth / sw;
      const toX = (u) => (u - sx) * scale;
      const toY = (v) => (v - sy) * scale;

      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = "#1e1e1e";
      context.fillRect(0, 0, pixelWidth, pixelHeight);
      if (video.readyState >= 2) {
        const cx0 = Math.max(0, sx), cy0 = Math.max(0, sy);
        const cx1 = Math.min(WIDTH, sx + sw), cy1 = Math.min(HEIGHT, sy + sh);
        if (cx1 > cx0 && cy1 > cy0) {
          context.drawImage(video, cx0, cy0, cx1 - cx0, cy1 - cy0, toX(cx0), toY(cy0), (cx1 - cx0) * scale, (cy1 - cy0) * scale);
        }
      }
      context.lineJoin = "round";
      context.lineCap = "round";
      const stroke = (points, style, width, dash) => {
        if (!points.length) return;
        context.beginPath();
        points.forEach(([u, v], index) => (index ? context.lineTo(toX(u), toY(v)) : context.moveTo(toX(u), toY(v))));
        context.setLineDash(dash || []);
        context.strokeStyle = style;
        context.lineWidth = width * ratio;
        context.stroke();
      };
      for (let rank = SAMPLES - 1; rank >= 1; rank--) stroke(candidates[rank], "rgba(255,255,255,0.72)", 1.5);
      stroke(candidates[0], "rgba(255,255,255,0.95)", 5);
      stroke(candidates[0], accent, 2.5);
      context.setLineDash([]);
      context.beginPath();
      context.arc(toX(tcp.u), toY(tcp.v), 5 * ratio, 0, Math.PI * 2);
      context.strokeStyle = "rgba(17,17,17,0.75)";
      context.lineWidth = 4 * ratio;
      context.stroke();
      context.strokeStyle = "#ffffff";
      context.lineWidth = 2 * ratio;
      context.stroke();

      // Scale bar: SCALE_BAR_METRES at the gripper's depth, using the camera's focal length.
      const bar = ((SCALE_BAR_METRES * data.camera.fx) / tcp.depth) * scale;
      const margin = 10 * ratio;
      const baseline = pixelHeight - margin;
      context.strokeStyle = "rgba(17,17,17,0.75)";
      context.lineWidth = 5 * ratio;
      context.beginPath();
      context.moveTo(pixelWidth - margin - bar, baseline);
      context.lineTo(pixelWidth - margin, baseline);
      context.stroke();
      context.strokeStyle = "#ffffff";
      context.lineWidth = 2 * ratio;
      context.stroke();
      context.font = `${11 * ratio}px Geist, system-ui, sans-serif`;
      context.textAlign = "right";
      context.textBaseline = "bottom";
      context.fillStyle = "rgba(17,17,17,0.75)";
      context.fillText(`${Math.round(SCALE_BAR_METRES * 100)} cm`, pixelWidth - margin + ratio, baseline - 4 * ratio + ratio);
      context.fillStyle = "#ffffff";
      context.fillText(`${Math.round(SCALE_BAR_METRES * 100)} cm`, pixelWidth - margin, baseline - 4 * ratio);
      return { sx, sy, sw, sh };
    }

    // ------------------------------------------------------------------ playback
    const PLAY_ICON = '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>';
    const PAUSE_ICON = '<svg viewBox="0 0 16 16"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>';

    function frameFromVideo() {
      return Math.max(0, Math.min(N - 1, Math.floor(video.currentTime * FPS + 1e-4)));
    }

    function renderPlayButton() {
      playButton.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
      playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
      playButton.title = playing ? "Pause" : "Play";
    }

    function tick() {
      if (!playing) return;
      const frame = frameFromVideo();
      if (frame !== currentFrame) draw(frame);
      animation = requestAnimationFrame(tick);
    }

    function play() {
      if (playing) return;
      playing = true;
      renderPlayButton();
      video.play().catch((error) => {
        if (error.name === "AbortError") return;
        playing = false;
        renderPlayButton();
        console.error(error);
      });
      animation = requestAnimationFrame(tick);
    }

    function pause() {
      playing = false;
      cancelAnimationFrame(animation);
      video.pause();
      renderPlayButton();
      draw(frameFromVideo());
    }

    function seek(frame) {
      frame = Math.max(0, Math.min(N - 1, frame));
      video.currentTime = (frame + 0.5) / FPS;
      draw(frame);
    }

    function togglePlayback() {
      if (playing) { userPaused = true; pause(); } else { userPaused = false; play(); }
    }

    playButton.addEventListener("click", togglePlayback);
    stage.addEventListener("click", togglePlayback);
    stepBack.addEventListener("click", () => { userPaused = true; pause(); seek(currentFrame - 1); });
    stepForward.addEventListener("click", () => { userPaused = true; pause(); seek(currentFrame + 1); });
    speed.addEventListener("change", () => { video.playbackRate = Number(speed.value); });
    scrubber.addEventListener("input", () => seek(Number(scrubber.value)));
    video.addEventListener("seeked", () => { if (!playing) draw(frameFromVideo()); });
    video.addEventListener("loadeddata", () => draw(Math.max(0, currentFrame)));
    mount.addEventListener("keydown", (event) => {
      if (event.target.tagName === "SELECT" || event.target.tagName === "INPUT") return;
      if (event.key === " ") { event.preventDefault(); togglePlayback(); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); userPaused = true; pause(); seek(currentFrame - 1); }
      else if (event.key === "ArrowRight") { event.preventDefault(); userPaused = true; pause(); seek(currentFrame + 1); }
      else if (event.key === "Home") { event.preventDefault(); seek(0); }
      else if (event.key === "End") { event.preventDefault(); seek(N - 1); }
    });

    // Timeline pointer handling: hover shows the crosshair and tooltip, dragging scrubs.
    let dragging = false;
    let resumeAfterDrag = false;
    function frameAtEvent(event) {
      const rect = timelineSvg.getBoundingClientRect();
      return frameAtX(event.clientX - rect.left);
    }
    function showHover(frame, event) {
      const px = x(frame);
      hoverLine.setAttribute("x1", px);
      hoverLine.setAttribute("x2", px);
      hoverLine.setAttribute("visibility", "visible");
      tooltip.replaceChildren();
      const timeLine = element("div");
      timeLine.append(element("strong", "", formatTime(frame / FPS)), ` · frame ${frame + 1}`);
      const valueLine = element("div");
      const valueKey = element("span", "key");
      valueKey.style.background = "var(--accent)";
      valueLine.append(valueKey, element("strong", "", bestValue[frame].toFixed(3)), " SeeQ value");
      const returnLine = element("div");
      const returnKey = element("span", "key");
      returnKey.style.background = "var(--ink-2)";
      returnLine.append(returnKey, element("strong", "", data.returnToGo[frame].toFixed(3)), " return-to-go");
      const predictedLine = element("div", "", `Predicted: ${data.subtasks[predictedAt[frame]]}`);
      const annotatedLine = element("div", "", `Annotated: ${data.subtasks[annotatedAt[frame]]}`);
      tooltip.append(timeLine, valueLine, returnLine, predictedLine, annotatedLine);
      tooltip.hidden = false;
      const rect = timeline.getBoundingClientRect();
      const relative = event.clientX - rect.left;
      const flip = relative > rect.width * 0.62;
      tooltip.style.left = `${relative + (flip ? -14 : 14)}px`;
      tooltip.style.transform = flip ? "translateX(-100%)" : "none";
      tooltip.style.top = `${plot.y0 - 6}px`;
    }
    function hideHover() {
      hoverLine.setAttribute("visibility", "hidden");
      tooltip.hidden = true;
    }
    timelineSvg.addEventListener("pointerdown", (event) => {
      dragging = true;
      timelineSvg.setPointerCapture(event.pointerId);
      resumeAfterDrag = playing;
      if (playing) pause();
      seek(frameAtEvent(event));
      event.preventDefault();
    });
    timelineSvg.addEventListener("pointermove", (event) => {
      const frame = frameAtEvent(event);
      if (dragging) seek(frame);
      if (event.pointerType !== "touch") showHover(frame, event);
    });
    const endDrag = (event) => {
      if (!dragging) return;
      dragging = false;
      timelineSvg.releasePointerCapture(event.pointerId);
      if (resumeAfterDrag && !userPaused) play();
      if (event.pointerType === "touch") hideHover();
    };
    timelineSvg.addEventListener("pointerup", endDrag);
    timelineSvg.addEventListener("pointercancel", endDrag);
    timelineSvg.addEventListener("pointerleave", () => { if (!dragging) hideHover(); });

    // Deep links: "#explorer-frame-<n>" (1-based, as the badge counts) pauses on that frame and
    // scrolls the explorer into view, both on load and when such a link is clicked.
    function frameFromHash(hash) {
      const match = /^#explorer-frame-(\d+)$/.exec(hash);
      return match ? Number(match[1]) - 1 : null;
    }
    function jumpToFrame(frame) {
      userPaused = true;
      pause();
      seek(frame);
      mount.scrollIntoView({ block: "start" });
    }
    document.addEventListener("click", (event) => {
      const link = event.target.closest("a[href^='#explorer-frame-']");
      if (!link) return;
      const frame = frameFromHash(link.getAttribute("href"));
      if (frame === null) return;
      event.preventDefault();
      history.replaceState(null, "", link.getAttribute("href"));
      jumpToFrame(frame);
    });
    window.addEventListener("hashchange", () => {
      const frame = frameFromHash(location.hash);
      if (frame !== null) jumpToFrame(frame);
    });

    // Autoplay while the stage is on screen, unless the viewer paused it.
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        inView = entry.isIntersecting;
        if (inView && !userPaused && !document.hidden) play();
        else if (!inView && playing) pause();
      }
    }, { threshold: 0.35 });
    observer.observe(stage);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && playing) pause();
      else if (!document.hidden && inView && !userPaused) play();
    });

    // Relayout on the next frame so the observer never sees sizes it changed itself.
    const resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => { layoutTimeline(); if (currentFrame >= 0) draw(currentFrame); }));
    resizeObserver.observe(timeline);
    resizeObserver.observe(magnifiers);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => draw(Math.max(0, currentFrame)));

    renderPlayButton();
    layoutTimeline();
    draw(0);
    const linkedFrame = frameFromHash(location.hash);
    if (linkedFrame !== null) jumpToFrame(linkedFrame);
  }
})();
