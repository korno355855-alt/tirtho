(function () {
  "use strict";

  const model = new window.CircuitModel();
  const svg = document.getElementById("circuit-canvas");
  const wireLayer = document.getElementById("wire-layer");
  const componentLayer = document.getElementById("component-layer");
  const previewLayer = document.getElementById("preview-layer");
  const inspector = document.getElementById("inspector-content");
  const toolButtons = Array.from(document.querySelectorAll("[data-tool]"));
  const toast = document.getElementById("toast");
  const toolNames = { select: "SELECT TOOL", battery: "BATTERY TOOL", currentSource: "CURRENT SOURCE TOOL", resistor: "RESISTOR TOOL", capacitor: "CAPACITOR TOOL", led: "LED TOOL", switch: "SWITCH TOOL", wire: "WIRE TOOL", probe: "PROBE TOOL", delete: "DELETE TOOL" };
  const NS = "http://www.w3.org/2000/svg";
  let activeTool = "select";
  let wireStart = null;
  let wirePointerId = null;
  let wirePointerStartedFromTap = false;
  let pointerPosition = { x: 600, y: 400 };
  let dragState = null;
  let paletteDrag = null;
  let suppressPaletteClick = false;
  let panState = null;
  let spacePressed = false;
  let suppressClick = false;
  const viewBox = { x: 0, y: 0, width: 1200, height: 800 };
  let toastTimer = null;
  let hasUnsavedChanges = false;
  let currentCircuitId = null;
  let currentCircuitName = "Untitled circuit";
  let savedCircuits = readSavedCircuits();
  let preferences = readPreferences();
  const componentTools = ["battery", "currentSource", "resistor", "capacitor", "led", "switch"];
  let analysisResult = window.CircuitAnalysis.calculate(model.snapshot());
  let circuit3DVisualizer = null;
  let circuit3DModulePromise = null;
  let currentFlow3DMode = false;
  let circuit3DLauncher = document.getElementById("view-3d-button");
  const circuit3DOverlay = document.getElementById("circuit-3d-overlay");
  const circuit3DContainer = document.getElementById("circuit-3d-container");
  const circuit3DMessage = document.getElementById("circuit-3d-message");
  const circuit3DStatus = document.getElementById("circuit-3d-status");
  const oscilloscopePanel = document.getElementById("oscilloscope-panel");
  const oscilloscope = new window.CircuitOscilloscope(
    document.getElementById("oscilloscope-canvas"),
    document.getElementById("oscilloscope-legend"),
    document.getElementById("oscilloscope-empty")
  );

  function readSavedCircuits() {
    try {
      const parsed = JSON.parse(localStorage.getItem("bench-saved-circuits") || "[]");
      if (!Array.isArray(parsed)) throw new Error("Saved circuits data is not a list.");
      return parsed.filter((item) => item && typeof item.id === "string" &&
        typeof item.name === "string" && item.circuit &&
        Array.isArray(item.circuit.components) && Array.isArray(item.circuit.connections));
    } catch (error) {
      console.error("Could not read saved circuits from browser storage.", error);
      showToast("Saved circuits could not be read from this browser.");
      return [];
    }
  }

  function readPreferences() {
    const defaults = { snapToGrid: false, showGrid: true, breadboard: false };
    try {
      const stored = JSON.parse(localStorage.getItem("bench-preferences") || "{}");
      return {
        snapToGrid: stored.snapToGrid === true,
        showGrid: stored.showGrid !== false,
        breadboard: stored.breadboard === true
      };
    } catch (error) {
      console.error("Could not read circuit preferences from browser storage.", error);
      showToast("Circuit preferences could not be read from this browser.");
      return defaults;
    }
  }

  function persistPreferences() {
    try {
      localStorage.setItem("bench-preferences", JSON.stringify(preferences));
      return true;
    } catch (error) {
      console.error("Could not save circuit preferences to browser storage.", error);
      showToast("Preferences could not be saved in this browser.");
      return false;
    }
  }

  function persistSavedCircuits() {
    try {
      localStorage.setItem("bench-saved-circuits", JSON.stringify(savedCircuits));
      return true;
    } catch (error) {
      console.error("Could not save circuits to browser storage.", error);
      showToast("Saved circuits could not be stored in this browser.");
      return false;
    }
  }

  function element(name, attributes = {}) {
    const node = document.createElementNS(NS, name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }

  function setTool(tool) {
    activeTool = tool;
    suppressClick = false;
    wireStart = null;
    wirePointerId = null;
    wirePointerStartedFromTap = false;
    toolButtons.forEach((button) => {
      const selected = button.dataset.tool === tool;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    document.getElementById("canvas-tool-label").textContent = toolNames[tool];
    svg.classList.toggle("canvas-cursor-crosshair", [...componentTools, "wire", "probe"].includes(tool));
    svg.classList.toggle("canvas-cursor-delete", tool === "delete");
    if (tool === "probe") {
      oscilloscopePanel.hidden = false;
      oscilloscope.setVisible(true);
      document.getElementById("footer-message").textContent = "Probe a component for current/voltage, or a terminal for node voltage.";
    } else if (!oscilloscope.traces.size) {
      oscilloscopePanel.hidden = true;
      oscilloscope.setVisible(false);
    }
    if (tool === "wire") {
      document.getElementById("footer-message").textContent = "Start at a terminal or tap an existing wire, then connect to a terminal.";
    }
    if (circuit3DVisualizer) circuit3DVisualizer.setProbeMode(tool === "probe", handle3DProbePick);
    draw();
  }

  function svgPoint(event) {
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const transformed = point.matrixTransform(svg.getScreenCTM().inverse());
    return { x: transformed.x, y: transformed.y };
  }

  function updateViewBox() {
    svg.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
    const zoom = Math.round((1200 / viewBox.width) * 100);
    document.getElementById("zoom-level").textContent = `${zoom}%`;
    document.getElementById("zoom-out-button").disabled = viewBox.width >= 2400;
    document.getElementById("zoom-in-button").disabled = viewBox.width <= 600;
  }

  function clampViewBox() {
    const clampAxis = (position, size, worldSize) => size <= worldSize
      ? Math.max(0, Math.min(worldSize - size, position))
      : Math.max(worldSize - size, Math.min(0, position));
    viewBox.x = clampAxis(viewBox.x, viewBox.width, 1200);
    viewBox.y = clampAxis(viewBox.y, viewBox.height, 800);
  }

  function zoomAt(point, factor) {
    const previousWidth = viewBox.width;
    const nextWidth = Math.max(600, Math.min(2400, previousWidth / factor));
    const zoomRatio = nextWidth / previousWidth;
    viewBox.x = point.x - (point.x - viewBox.x) * zoomRatio;
    viewBox.y = point.y - (point.y - viewBox.y) * zoomRatio;
    viewBox.width = nextWidth;
    viewBox.height = nextWidth * (2 / 3);
    clampViewBox();
    updateViewBox();
  }

  function zoomFromCenter(factor) {
    zoomAt(
      { x: viewBox.x + viewBox.width / 2, y: viewBox.y + viewBox.height / 2 },
      factor
    );
  }

  function pointerIsOverCanvas(event) {
    const bounds = svg.getBoundingClientRect();
    return event.clientX >= bounds.left && event.clientX <= bounds.right &&
      event.clientY >= bounds.top && event.clientY <= bounds.bottom;
  }

  function componentById(id) {
    return model.components.find((component) => component.id === id);
  }

  function createSymbol(component, parent) {
    const group = element("g", { class: "component-node", transform: `translate(${component.x} ${component.y}) rotate(${component.rotation})`, "data-id": component.id, "data-kind": "component" });
    group.appendChild(element("rect", { class: "hit-area", x: -49, y: -38, width: 98, height: 76, rx: 8 }));
    if (model.selection && model.selection.kind === "component" && model.selection.id === component.id) {
      group.appendChild(element("rect", { class: "selection-halo", x: -38, y: -29, width: 76, height: 58, rx: 6 }));
      group.classList.add("selected");
    }

    if (component.type === "battery") {
      group.appendChild(element("path", { class: "symbol-stroke", d: "M-31 0H-8 M8 0H31 M-8-13V13 M8-7V7" }));
      group.appendChild(element("text", { x: -14, y: -17, fill: "#8eaaa0", "font-size": "9", "font-family": "DM Mono, monospace", "text-anchor": "middle" })).textContent = "+";
      group.appendChild(element("text", { x: 14, y: -17, fill: "#8eaaa0", "font-size": "9", "font-family": "DM Mono, monospace", "text-anchor": "middle" })).textContent = "−";
    } else if (component.type === "currentSource") {
      group.appendChild(element("path", { class: "symbol-stroke", d: "M-32 0H-12 M12 0H32" }));
      group.appendChild(element("circle", { class: "symbol-stroke", cx: 0, cy: 0, r: 12 }));
      const arrowPath = component.direction === -1 ? "M8 0H-8M-3-5-8 0-3 5" : "M-8 0H8M3-5 8 0 3 5";
      group.appendChild(element("path", { class: "symbol-stroke", d: arrowPath }));
    } else if (component.type === "resistor") {
      group.appendChild(element("path", { class: "symbol-stroke", d: "M-34 0H-22L-15-10-5 10 5-10 15 10 22 0H34" }));
    } else if (component.type === "capacitor") {
      group.appendChild(element("path", { class: "symbol-stroke", d: "M-32 0H-7 M7 0H32 M-7-13V13 M7-13V13" }));
    } else if (component.type === "led") {
      group.appendChild(element("path", { class: "symbol-stroke", d: "M-32 0H-14 M12 0H32 M-14-13V13L10 0-14-13ZM-7-17 0-24m3 12 7-7" }));
    } else if (component.type === "switch") {
      group.appendChild(element("path", { class: "symbol-stroke", d: component.closed ? "M-32 0H-17 M17 0H32 M-14-3H14" : "M-32 0H-17 M17 0H32 M-14-3 10-14" }));
      group.appendChild(element("circle", { class: "symbol-fill", cx: -14, cy: 0, r: 3 }));
      group.appendChild(element("circle", { class: "symbol-fill", cx: 14, cy: 0, r: 3 }));
    }
    const terminalNames = component.type === "battery"
      ? [{ id: "positive", x: -32, label: "+" }, { id: "negative", x: 32, label: "−" }]
      : [{ id: "left", x: -32 }, { id: "right", x: 32 }];
    terminalNames.forEach((terminal) => {
      const terminalGroup = element("g", {
        class: "terminal-node",
        "data-kind": "terminal",
        "data-component": component.id,
        "data-terminal": terminal.id,
        "aria-label": `${component.name} ${terminal.label || terminal.id} terminal`,
        role: "button",
        tabindex: "0"
      });
      terminalGroup.appendChild(element("circle", { class: "terminal-hit-area", cx: terminal.x, cy: 0, r: 11 }));
      terminalGroup.appendChild(element("circle", { class: "terminal-dot", cx: terminal.x, cy: 0, r: 4.5 }));
      group.appendChild(terminalGroup);
      if (terminal.label) {
        const label = element("text", { class: "terminal-label", x: terminal.x, y: -10 });
        label.textContent = terminal.label;
        group.appendChild(label);
      }
    });
    const label = element("text", { class: "component-id", x: 0, y: 34 });
    label.textContent = component.id;
    group.appendChild(label);
    parent.appendChild(group);
  }

  function endpoint(component, terminal) {
    const radians = (component.rotation * Math.PI) / 180;
    const isLeft = component.type === "battery" ? terminal === "positive" : terminal === "left";
    const localX = isLeft ? -32 : 32;
    return {
      x: component.x + localX * Math.cos(radians),
      y: component.y + localX * Math.sin(radians)
    };
  }

  function closestPointOnRoute(point, points) {
    let closest = points[0];
    let minimumDistance = Infinity;
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy;
      const progress = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
        ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared
      ));
      const candidate = { x: start.x + progress * dx, y: start.y + progress * dy };
      const distance = Math.hypot(point.x - candidate.x, point.y - candidate.y);
      if (distance < minimumDistance) {
        closest = candidate;
        minimumDistance = distance;
      }
    }
    return closest;
  }

  function routePoints(start, end, horizontalFirst = true) {
    const corner = horizontalFirst
      ? { x: end.x, y: start.y }
      : { x: start.x, y: end.y };
    return [start, corner, end].filter((point, index, points) =>
      index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y
    );
  }

  function tapPosition(wireTap) {
    const tappedWire = model.connections.find((connection) => connection.id === wireTap.connectionId);
    if (!tappedWire) return { x: wireTap.x, y: wireTap.y };
    return closestPointOnRoute({ x: wireTap.x, y: wireTap.y }, wireRoute(tappedWire));
  }

  function wireRoute(connection) {
    const from = componentById(connection.fromComponent);
    const to = componentById(connection.toComponent);
    if (!from) return [];
    const tapAtEnd = connection.wireTap && connection.wireTap.side === "to";
    const start = connection.wireTap && !tapAtEnd
      ? tapPosition(connection.wireTap)
      : endpoint(from, connection.fromTerminal);
    if (connection.freeEnd) {
      return routePoints(start, connection.freeEnd, connection.wireTap ? true : from.rotation % 180 === 0);
    }
    if (!to) return [];
    const end = connection.wireTap && tapAtEnd
      ? tapPosition(connection.wireTap)
      : endpoint(to, connection.toTerminal);
    const startHorizontal = connection.wireTap && !tapAtEnd ? null : from.rotation % 180 === 0;
    const endHorizontal = connection.wireTap && tapAtEnd ? null : to.rotation % 180 === 0;
    if (tapAtEnd) return routePoints(start, end, startHorizontal);
    if (startHorizontal !== null && startHorizontal === endHorizontal) {
      const middle = startHorizontal
        ? { x: (start.x + end.x) / 2, y: start.y }
        : { x: start.x, y: (start.y + end.y) / 2 };
      const otherMiddle = startHorizontal
        ? { x: middle.x, y: end.y }
        : { x: end.x, y: middle.y };
      return [start, middle, otherMiddle, end].filter((point, index, points) =>
        index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y
      );
    }
    const horizontalFirst = startHorizontal === null ? !endHorizontal : startHorizontal;
    return routePoints(start, end, horizontalFirst);
  }

  function routePath(points) {
    return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  }

  function renderBreadboard() {
    const layer = document.getElementById("breadboard-layer");
    layer.replaceChildren();
    layer.appendChild(element("rect", { class: "breadboard-base", x: 72, y: 112, width: 1056, height: 576, rx: 18 }));
    layer.appendChild(element("rect", { class: "breadboard-center", x: 96, y: 330, width: 1008, height: 140, rx: 5 }));
    [144, 656].forEach((y) => {
      layer.appendChild(element("line", { class: "breadboard-power-rail positive", x1: 104, y1: y, x2: 1096, y2: y }));
      layer.appendChild(element("line", { class: "breadboard-power-rail negative", x1: 104, y1: y + 32, x2: 1096, y2: y + 32 }));
      for (let x = 120; x <= 1080; x += 48) {
        layer.appendChild(element("circle", { class: "breadboard-rail-hole positive", cx: x, cy: y, r: 3 }));
        layer.appendChild(element("circle", { class: "breadboard-rail-hole negative", cx: x, cy: y + 32, r: 3 }));
      }
    });
    for (let x = 120; x <= 1080; x += 24) {
      for (let y = 188; y <= 308; y += 24) {
        layer.appendChild(element("circle", { class: "breadboard-hole", cx: x, cy: y, r: 3 }));
      }
      for (let y = 492; y <= 612; y += 24) {
        layer.appendChild(element("circle", { class: "breadboard-hole", cx: x, cy: y, r: 3 }));
      }
    }
    layer.appendChild(element("text", { class: "breadboard-label", x: 120, y: 128 })).textContent = "+";
    layer.appendChild(element("text", { class: "breadboard-label", x: 120, y: 704 })).textContent = "−";
    layer.setAttribute("visibility", preferences.breadboard ? "visible" : "hidden");
    document.getElementById("schematic-grid").setAttribute("visibility", preferences.showGrid && !preferences.breadboard ? "visible" : "hidden");
    document.getElementById("breadboard-toggle").classList.toggle("active", preferences.breadboard);
    document.getElementById("breadboard-toggle").setAttribute("aria-pressed", String(preferences.breadboard));
    document.getElementById("show-schematic-grid").checked = preferences.showGrid;
    document.getElementById("snap-to-grid").checked = preferences.snapToGrid;
  }

  function snappedPoint(point) {
    if (!preferences.snapToGrid) return point;
    return { x: Math.round(point.x / 24) * 24, y: Math.round(point.y / 24) * 24 };
  }

  function draw() {
    wireLayer.replaceChildren();
    componentLayer.replaceChildren();
    previewLayer.replaceChildren();
    model.connections.forEach((connection) => {
      const points = wireRoute(connection);
      if (!points.length) return;
      const group = element("g", {
        class: `wire-node${model.selection && model.selection.kind === "connection" && model.selection.id === connection.id ? " selected" : ""}`,
        "data-id": connection.id,
        "data-kind": "connection"
      });
      group.appendChild(element("path", { class: "wire-hit-area", d: routePath(points) }));
      group.appendChild(element("path", { class: "wire-path", d: routePath(points) }));
      wireLayer.appendChild(group);
    });
    model.components.forEach((component) => createSymbol(component, componentLayer));
    model.connections.forEach((connection) => {
      const from = componentById(connection.fromComponent);
      const to = componentById(connection.toComponent);
      if (!from) return;
      if (connection.freeEnd) {
        previewLayer.appendChild(element("circle", {
          class: "wire-endpoint",
          cx: connection.freeEnd.x,
          cy: connection.freeEnd.y,
          r: 4,
          "pointer-events": "none"
        }));
      }
      if (!to && !connection.freeEnd) return;
      const endpoints = connection.wireTap && connection.wireTap.side === "to"
        ? [endpoint(from, connection.fromTerminal)]
        : connection.freeEnd
          ? (connection.wireTap ? [] : [endpoint(from, connection.fromTerminal)])
        : connection.wireTap
          ? [endpoint(to, connection.toTerminal)]
          : [endpoint(from, connection.fromTerminal), endpoint(to, connection.toTerminal)];
      endpoints.forEach((point) => {
        previewLayer.appendChild(element("circle", {
          class: "wire-endpoint",
          cx: point.x,
          cy: point.y,
          r: 4,
          "pointer-events": "none"
        }));
      });
      if (connection.wireTap) {
        const point = tapPosition(connection.wireTap);
        previewLayer.appendChild(element("circle", {
          class: "wire-junction",
          cx: point.x,
          cy: point.y,
          r: 4.5,
          "data-kind": "junction",
          "pointer-events": "none"
        }));
      }
    });
    if (wireStart) {
      const from = componentById(wireStart.component);
      if (from) {
        const start = wireStart.wireTap
          ? tapPosition(wireStart.wireTap)
          : endpoint(from, wireStart.terminal);
        previewLayer.appendChild(element("circle", { class: "wire-start", cx: start.x, cy: start.y, r: 4 }));
        previewLayer.appendChild(element("path", {
          class: "wire-temp",
          d: routePath(routePoints(start, pointerPosition, from.rotation % 180 === 0))
        }));
      }
    }
  }

  function componentIcon(type) {
    const paths = {
      battery: '<path d="M3 12h5m8 0h5M8 7v10m8-7v4"/>',
      currentSource: '<circle cx="12" cy="12" r="8"/><path d="M6 12h11m-4-4 4 4-4 4"/>',
      resistor: '<path d="M2 12h4l2-5 4 10 4-10 2 5h4"/>',
      capacitor: '<path d="M2 12h8m4 0h8m-8-7v14m-4-14v14"/>',
      led: '<path d="M7 6v12l11-6L7 6Zm12-2 2-2m-1 7h3"/>',
      switch: '<path d="M2 14h5m10 0h5M7 14l9-6"/>'
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[type]}</svg>`;
  }

  function componentTypeLabel(type) {
    return type === "currentSource" ? "CURRENT SOURCE" : type.toUpperCase();
  }

  function renderInspector() {
    const selected = model.selection;
    document.getElementById("rotate-button").disabled = !selected || selected.kind !== "component";
    if (!selected || selected.kind !== "component") {
      if (selected && selected.kind === "connection") {
        const wire = model.connections.find((item) => item.id === selected.id);
        inspector.innerHTML = wire
          ? `<div class="property-card"><div class="selected-component"><span class="component-badge"><svg viewBox="0 0 24 24"><path d="M3 17c0-7 18-7 18-14M3 17h4m13-14h1"/></svg></span><div><h2>Wire</h2><p>${escapeAttribute(wire.id)}</p></div></div><div class="property-group-label">CONNECTION</div><div class="read-only-value">${escapeAttribute(wire.fromComponent)} · ${escapeAttribute(wire.fromTerminal)}</div><div class="read-only-value" style="margin-top:9px">${wire.freeEnd ? `Open end · X ${Math.round(wire.freeEnd.x)}, Y ${Math.round(wire.freeEnd.y)}` : `${escapeAttribute(wire.toComponent)} · ${escapeAttribute(wire.toTerminal)}`}</div><div class="component-actions"><button class="small-action danger" id="delete-selected">Delete wire</button></div></div>${renderAnalysisPanel()}`
          : emptyInspector();
      } else inspector.innerHTML = `${emptyInspector()}${renderAnalysisPanel()}`;
      const deleteButton = document.getElementById("delete-selected");
      if (deleteButton) deleteButton.addEventListener("click", () => model.deleteSelection());
      return;
    }
    const component = componentById(selected.id);
    if (!component) { inspector.innerHTML = emptyInspector(); return; }
    const componentResult = analysisResult.components[component.id] || {};
    const specificField = component.type === "resistor"
      ? `<div class="property-field"><label for="component-value">Resistance</label><div class="field-control"><input id="component-value" type="number" min="0" step="any" value="${escapeAttribute(component.resistance)}" aria-label="Resistance value"><span class="field-unit">Ω</span></div></div>
        <div class="property-field"><label for="component-current-override">Current (manual override)</label><div class="field-control"><input id="component-current-override" data-manual-field="manualCurrent" type="number" step="any" value="${component.manualCurrent === null ? "" : escapeAttribute(component.manualCurrent)}" placeholder="${escapeAttribute(inputPlaceholder(componentResult.current))}" aria-label="Manual resistor current"><span class="field-unit">A</span></div></div>
        <div class="property-field"><label for="component-voltage-override">Voltage (manual override)</label><div class="field-control"><input id="component-voltage-override" data-manual-field="manualVoltage" type="number" step="any" value="${component.manualVoltage === null ? "" : escapeAttribute(component.manualVoltage)}" placeholder="${escapeAttribute(inputPlaceholder(componentResult.voltage))}" aria-label="Manual resistor voltage"><span class="field-unit">V</span></div></div>
        <p class="manual-value-hint">Enter your own values. Leave blank to use MNA results; manual values affect this resistor’s displayed output only.</p>`
      : component.type === "capacitor"
        ? `<div class="property-field"><label for="component-value">Capacitance</label><div class="field-control"><input id="component-value" type="number" min="0" step="any" value="${escapeAttribute(component.capacitance)}" aria-label="Capacitance value"><span class="field-unit">F</span></div><p class="manual-value-hint">Capacitors are modeled as open circuits at DC steady state; transient analysis is not available.</p></div>`
      : component.type === "battery"
        ? `<div class="property-field"><label for="component-value">Voltage</label><div class="field-control"><input id="component-value" type="number" min="0" step="any" value="${escapeAttribute(component.voltage)}" aria-label="Voltage value"><span class="field-unit">V</span></div></div>`
        : component.type === "currentSource"
          ? `<div class="property-field"><label for="component-value">Source current</label><div class="field-control"><input id="component-value" type="number" min="0" step="any" value="${escapeAttribute(component.sourceCurrent)}" aria-label="Current source value"><span class="field-unit">A</span></div></div><div class="property-field"><label>Current direction</label><button class="small-action" id="reverse-current-source" type="button">Reverse arrow</button></div>`
        : component.type === "switch"
          ? `<div class="property-field"><label>Switch state</label><button class="small-action switch-toggle" id="toggle-switch" type="button">${component.closed ? "Open switch" : "Close switch"}</button></div>`
        : `<div class="property-field"><label>Type</label><div class="read-only-value">${component.type === "led" ? "Light-emitting diode" : "Manual switch"}</div></div>`;
    const currentField = component.type === "resistor"
      ? ""
      : `<div class="property-field"><label>Current</label><div class="read-only-value"><span data-component-current>${formatValue(componentResult.current, "A")}</span></div></div>`;
    inspector.innerHTML = `<div class="property-card"><div class="selected-component"><span class="component-badge">${componentIcon(component.type)}</span><div><h2>${escapeAttribute(component.name)}</h2><p>${escapeAttribute(component.id)} · ${componentTypeLabel(component.type)}</p></div></div><div class="property-group-label">COMPONENT DETAILS</div><div class="property-field"><label for="component-name">Name</label><div class="field-control"><input id="component-name" type="text" maxlength="48" value="${escapeAttribute(component.name)}" aria-label="Component name"></div></div><div class="property-field"><label>Component ID</label><div class="read-only-value">${escapeAttribute(component.id)}<span class="placeholder-chip">AUTO</span></div></div>${specificField}${currentField}<div class="component-actions"><button class="small-action" id="rotate-selected">↻ &nbsp; Rotate <kbd>R</kbd></button><button class="small-action danger" id="delete-selected">Delete</button></div></div>${renderAnalysisPanel()}`;
    const nameInput = document.getElementById("component-name");
    nameInput.addEventListener("change", () => {
      const value = nameInput.value.trim();
      if (value) model.updateComponent(component.id, { name: value });
      else nameInput.value = component.name;
    });
    const valueInput = document.getElementById("component-value");
    if (valueInput) {
      const valueKey = component.type === "battery"
        ? "voltage"
        : component.type === "currentSource" ? "sourceCurrent"
          : component.type === "capacitor" ? "capacitance" : "resistance";
      const strictlyPositive = component.type === "resistor" || component.type === "capacitor";
      let previewChanged = false;
      valueInput.addEventListener("input", () => {
        const value = valueInput.valueAsNumber;
        if (!Number.isFinite(value) || (strictlyPositive ? value <= 0 : value < 0)) return;
        if (Object.is(component[valueKey], value)) return;
        model.updateComponent(component.id, { [valueKey]: value }, false);
        previewChanged = true;
      });
      valueInput.addEventListener("change", () => {
        const value = valueInput.valueAsNumber;
        if (!Number.isFinite(value) || (strictlyPositive ? value <= 0 : value < 0)) {
          valueInput.value = String(component[valueKey]);
          showToast(component.type === "resistor" || component.type === "capacitor"
            ? "Enter a finite value greater than zero."
            : "Enter a valid non-negative value.");
          return;
        }
        if (previewChanged) {
          model.commit("component-updated");
          previewChanged = false;
        } else if (!Object.is(component[valueKey], value)) {
          model.updateComponent(component.id, { [valueKey]: value });
        }
      });
    }
    inspector.querySelectorAll("[data-manual-field]").forEach((input) => {
      const valueKey = input.dataset.manualField;
      let previewChanged = false;
      input.addEventListener("input", () => {
        const value = input.value === "" ? null : input.valueAsNumber;
        if (value !== null && !Number.isFinite(value)) return;
        const existing = component[valueKey] ?? null;
        if (Object.is(existing, value)) return;
        model.updateComponent(component.id, { [valueKey]: value }, false);
        previewChanged = true;
      });
      input.addEventListener("change", () => {
        const value = input.value === "" ? null : input.valueAsNumber;
        if (value !== null && !Number.isFinite(value)) {
          input.value = component[valueKey] === null ? "" : String(component[valueKey]);
          showToast("Enter a finite current or voltage, or leave the field blank.");
          return;
        }
        const existing = component[valueKey] ?? null;
        if (previewChanged) {
          model.commit("component-updated");
          previewChanged = false;
        } else if (!Object.is(existing, value)) {
          model.updateComponent(component.id, { [valueKey]: value });
        }
      });
    });
    const toggleSwitchButton = document.getElementById("toggle-switch");
    if (toggleSwitchButton) toggleSwitchButton.addEventListener("click", () => model.toggleSwitch(component.id));
    const reverseCurrentSourceButton = document.getElementById("reverse-current-source");
    if (reverseCurrentSourceButton) reverseCurrentSourceButton.addEventListener("click", () =>
      model.updateComponent(component.id, { direction: component.direction * -1 }));
    document.getElementById("rotate-selected").addEventListener("click", () => model.rotateComponent(component.id));
    document.getElementById("delete-selected").addEventListener("click", () => model.deleteSelection());
  }

  function emptyInspector() {
    return `<div class="empty-inspector"><div class="empty-illustration"><span class="empty-line"></span><span class="empty-terminal"></span><span class="empty-core"></span><span class="empty-terminal second"></span></div><h2>Nothing selected</h2><p>Select a component on the canvas to view its properties and specifications.</p><div class="empty-shortcut"><kbd>CLICK</kbd><span>a component to inspect it</span></div></div>`;
  }

  function formatValue(value, unit) {
    if (!Number.isFinite(value)) return "—";
    const rounded = Number(value.toPrecision(6));
    return `${rounded} ${unit}`;
  }

  function inputPlaceholder(value) {
    return Number.isFinite(value) ? String(Number(value.toPrecision(6))) : "MNA";
  }

  function renderAnalysisPanel() {
    const result = analysisResult;
    const statusLabel = result.status === "valid" ? "CALCULATED" : result.status === "invalid" ? "INVALID" : "INCOMPLETE";
    const componentRows = model.components.map((component) => {
      const values = result.components[component.id] || {};
      const currentTag = values.manual && values.manual.current ? '<small class="manual-value-tag">MANUAL</small>' : "";
      const voltageTag = values.manual && values.manual.voltage ? '<small class="manual-value-tag">MANUAL</small>' : "";
      return `<div class="analysis-row"><span class="analysis-component">${escapeAttribute(component.id)} <small>${escapeAttribute(component.name)}</small></span><span class="analysis-value">${formatValue(values.current, "A")}${currentTag}</span><span class="analysis-value">${formatValue(values.voltage, "V")}${voltageTag}</span></div>`;
    }).join("");
    const nodeEntries = Object.entries(result.nodeVoltages || {}).filter(([, value]) => Number.isFinite(value));
    const sortedNodes = [...nodeEntries].sort(([, left], [, right]) => Math.abs(right) - Math.abs(left));
    const nodeRows = sortedNodes.length
      ? sortedNodes.slice(0, 6).map(([node, value]) => {
        const state = value >= 0 ? "HIGH" : "LOW";
        return `<div class="analysis-row compact"><span class="analysis-component">${escapeAttribute(node)}</span><span class="analysis-value">${formatValue(value, "V")}</span><span class="analysis-state ${value >= 0 ? "positive" : "negative"}">${state}</span></div>`;
      }).join("")
      : `<p class="analysis-empty">No node voltages available yet.</p>`;
    const nodeValues = nodeEntries.map(([, value]) => value);
    const averageNodeVoltage = nodeValues.length ? nodeValues.reduce((sum, value) => sum + value, 0) / nodeValues.length : null;
    const minNodeVoltage = nodeValues.length ? Math.min(...nodeValues) : null;
    const maxNodeVoltage = nodeValues.length ? Math.max(...nodeValues) : null;
    const peakNode = sortedNodes.length ? sortedNodes[0] : null;
    const message = result.message
      ? `<p class="analysis-message${result.status === "invalid" ? " invalid" : ""}">${escapeAttribute(result.message)}</p>`
      : "";
    const guidance = result.status === "incomplete"
      ? `<p class="analysis-guidance">${model.components.some((component) => component.type === "battery")
        ? "Connect a resistor path between both battery terminals, including a return wire."
        : "Connect a resistive return path across the current-source terminals."}</p>`
      : "";
    return `<section class="analysis-section" aria-labelledby="analysis-title"><div class="analysis-heading"><h2 id="analysis-title">Circuit Analysis</h2><span class="analysis-status ${result.status}">${statusLabel}</span></div>${message}${guidance}<div class="analysis-metrics"><div><span>Total Resistance</span><strong>${formatValue(result.totalResistance, "Ω")}</strong></div><div><span>Total Voltage</span><strong>${formatValue(result.totalVoltage, "V")}</strong></div><div><span>Total Current</span><strong>${formatValue(result.totalCurrent, "A")}</strong></div></div><div class="analysis-subsection"><h3>Node Analysis</h3><div class="analysis-summary-grid"><div><span>Nodes</span><strong>${nodeValues.length}</strong></div><div><span>Avg. voltage</span><strong>${formatValue(averageNodeVoltage, "V")}</strong></div><div><span>Min voltage</span><strong>${formatValue(minNodeVoltage, "V")}</strong></div><div><span>Peak node</span><strong>${peakNode ? `${escapeAttribute(peakNode[0])} · ${formatValue(peakNode[1], "V")}` : "—"}</strong></div></div><div class="analysis-table analysis-node-table"><div class="analysis-row analysis-table-head"><span>Node</span><span>Voltage</span><span>State</span></div>${nodeRows}</div></div><div class="analysis-subsection"><h3>Mass Analysis</h3><div class="analysis-summary-grid"><div><span>Voltage spread</span><strong>${formatValue(maxNodeVoltage !== null && minNodeVoltage !== null ? maxNodeVoltage - minNodeVoltage : null, "V")}</strong></div><div><span>High node</span><strong>${maxNodeVoltage !== null ? formatValue(maxNodeVoltage, "V") : "—"}</strong></div><div><span>Low node</span><strong>${minNodeVoltage !== null ? formatValue(minNodeVoltage, "V") : "—"}</strong></div><div><span>Components</span><strong>${model.components.length}</strong></div></div></div><div class="analysis-table"><div class="analysis-row analysis-table-head"><span>Component</span><span>Current</span><span>Voltage</span></div>${componentRows || `<p class="analysis-empty">Add components to see component values.</p>`}</div></section>`;
  }

  function refreshLiveAnalysis() {
    const container = document.createElement("div");
    container.innerHTML = renderAnalysisPanel();
    const currentPanel = inspector.querySelector(".analysis-section");
    if (currentPanel) currentPanel.replaceWith(container.firstElementChild);

    const selected = model.selection;
    if (!selected || selected.kind !== "component") return;
    const values = analysisResult.components[selected.id] || {};
    const current = inspector.querySelector("[data-component-current]");
    if (current) current.textContent = formatValue(values.current, "A");
    const voltage = inspector.querySelector("[data-component-voltage]");
    if (voltage) voltage.textContent = formatValue(values.voltage, "V");
  }

  function escapeAttribute(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  }

  function updateStatus() {
    document.getElementById("component-count").textContent = `${model.components.length} COMPONENT${model.components.length === 1 ? "" : "S"}`;
    document.getElementById("undo-button").disabled = !model.canUndo();
    document.getElementById("redo-button").disabled = !model.canRedo();
    document.getElementById("unsaved-indicator").classList.toggle("visible", hasUnsavedChanges);
    document.getElementById("save-status").textContent = hasUnsavedChanges ? "Unsaved changes" : "All changes saved";
    const messages = {
      "component-added": "Component placed on canvas",
      "component-moved": "Component moved",
      "component-rotated": "Component rotated",
      "connection-added": "Wire connected",
      "selection-deleted": "Selection deleted",
      "circuit-cleared": "Circuit cleared",
      "circuit-loaded": "Circuit loaded",
      undo: "Change undone",
      redo: "Change restored"
    };
    if (messages[statusState.reason]) document.getElementById("footer-message").textContent = messages[statusState.reason];
    document.getElementById("unsaved-indicator").classList.toggle("visible", hasUnsavedChanges);
    document.getElementById("save-status").textContent = hasUnsavedChanges ? "Unsaved changes" : "All changes saved";
  }
  const statusState = { reason: "" };
  function getCircuit3DStatus() {
    if (currentFlow3DMode) {
      if (!model.components.length) return "Demo loop · animated conventional current";
      return analysisResult.status === "valid"
        ? "Animated arrows show conventional current direction"
        : "Current direction unavailable · close the circuit to animate";
    }
    if (!model.components.length) return "Demo loop · current flowing";
    return analysisResult.status === "valid"
      ? "Current flow shown from MNA results"
      : "Circuit values unavailable";
  }
  function handleCircuit3DState(state, error) {
    if (state === "context-lost") {
      circuit3DMessage.hidden = false;
      circuit3DMessage.textContent = "WebGL context lost. Waiting for the browser to restore the 3D view…";
      circuit3DStatus.textContent = "Waiting for WebGL recovery";
    } else if (state === "context-restored") {
      circuit3DMessage.hidden = true;
      circuit3DStatus.textContent = getCircuit3DStatus();
    } else if (state === "error") {
      console.error("3D circuit rendering failed.", error);
      circuit3DMessage.hidden = false;
      circuit3DMessage.textContent = "The 3D view stopped because rendering failed. Close and reopen it to try again.";
      circuit3DStatus.textContent = "Rendering unavailable";
    }
  }
  model.subscribe((reason) => {
    statusState.reason = reason;
    if (reason !== "selection-changed" && reason !== "component-moving") hasUnsavedChanges = true;
    analysisResult = window.CircuitAnalysis.calculate(model.snapshot());
    if (oscilloscope.traces.size) oscilloscope.sample();
    if (circuit3DVisualizer) circuit3DVisualizer.setCircuit(model.snapshot(), analysisResult);
    if (!circuit3DOverlay.hidden && circuit3DVisualizer
      && !circuit3DVisualizer.contextLost && !circuit3DVisualizer.failed) {
      circuit3DStatus.textContent = getCircuit3DStatus();
    }
    if (reason === "component-preview") {
      refreshLiveAnalysis();
    } else {
      draw();
      if (reason !== "component-moving") renderInspector();
    }
    updateStatus();
  });

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 2400);
  }

  function setCircuitName(name) {
    currentCircuitName = name;
    document.getElementById("circuit-name").textContent = name;
    document.getElementById("saved-circuit-name").value = name;
  }

  function showPage(page) {
    const home = page === "home";
    document.querySelector(".workspace").hidden = !home;
    document.getElementById("options-page").hidden = page !== "options";
    document.getElementById("settings-page").hidden = page !== "settings";
    document.querySelectorAll(".nav-tab").forEach((tab) => {
      const selected = tab.dataset.page === page;
      tab.classList.toggle("active", selected);
      if (selected) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    });
    if (page === "options") renderSavedCircuits();
  }

  function renderSavedCircuits() {
    const list = document.getElementById("saved-circuit-list");
    list.replaceChildren();
    if (!savedCircuits.length) {
      const empty = document.createElement("div");
      empty.className = "saved-empty";
      empty.innerHTML = "<h2>No saved circuits yet</h2><p>Save the circuit on your canvas to add it to this list.</p>";
      list.appendChild(empty);
      return;
    }
    savedCircuits.slice().sort((left, right) => right.updatedAt - left.updatedAt).forEach((saved) => {
      const card = document.createElement("article");
      card.className = "saved-circuit-card";
      const info = document.createElement("div");
      info.className = "saved-circuit-info";
      const title = document.createElement("h2");
      title.textContent = saved.name;
      const date = document.createElement("p");
      date.textContent = `${saved.circuit.components.length} component${saved.circuit.components.length === 1 ? "" : "s"} · ${new Date(saved.updatedAt).toLocaleString()}`;
      info.append(title, date);
      const actions = document.createElement("div");
      actions.className = "saved-circuit-actions";
      const loadButton = document.createElement("button");
      loadButton.type = "button";
      loadButton.className = "primary-button";
      loadButton.textContent = "Open";
      loadButton.addEventListener("click", () => {
        try {
          model.load(saved.circuit);
          currentCircuitId = saved.id;
          setCircuitName(saved.name);
          hasUnsavedChanges = false;
          updateStatus();
          showPage("home");
          showToast(`Loaded “${saved.name}”.`);
        } catch (error) {
          console.error("Could not load saved circuit.", error);
          showToast(`Could not load circuit: ${error.message}`);
        }
      });
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "secondary-button danger-button";
      deleteButton.textContent = "Delete";
      deleteButton.addEventListener("click", () => {
        const previous = savedCircuits;
        savedCircuits = savedCircuits.filter((item) => item.id !== saved.id);
        if (!persistSavedCircuits()) {
          savedCircuits = previous;
          return;
        }
        renderSavedCircuits();
        if (currentCircuitId === saved.id) currentCircuitId = null;
        showToast(`Deleted “${saved.name}”.`);
      });
      actions.append(loadButton, deleteButton);
      card.append(info, actions);
      list.appendChild(card);
    });
  }

  function saveToLibrary(name, showMessage = true) {
    const title = name.trim();
    if (!title) {
      showToast("Enter a name for this circuit.");
      return false;
    }
    const savedAt = Date.now();
    const circuit = model.snapshot();
    const index = savedCircuits.findIndex((item) => item.id === currentCircuitId);
    const saved = {
      id: currentCircuitId || `circuit-${savedAt}-${Math.random().toString(36).slice(2, 8)}`,
      name: title,
      updatedAt: savedAt,
      circuit
    };
    const previous = savedCircuits;
    savedCircuits = index < 0
      ? [saved, ...savedCircuits]
      : savedCircuits.map((item, itemIndex) => itemIndex === index ? saved : item);
    if (!persistSavedCircuits()) {
      savedCircuits = previous;
      return false;
    }
    currentCircuitId = saved.id;
    setCircuitName(title);
    renderSavedCircuits();
    if (showMessage) showToast(`Saved “${title}” to this browser.`);
    return true;
  }

  function setAccountMode(mode) {
    const signingUp = mode === "sign-up";
    document.getElementById("sign-in-form").hidden = signingUp;
    document.getElementById("sign-up-form").hidden = !signingUp;
    document.getElementById("sign-in-tab").classList.toggle("active", !signingUp);
    document.getElementById("sign-up-tab").classList.toggle("active", signingUp);
    document.getElementById("sign-in-tab").setAttribute("aria-selected", String(!signingUp));
    document.getElementById("sign-up-tab").setAttribute("aria-selected", String(signingUp));
    document.getElementById("account-title").textContent = signingUp ? "Create your account" : "Welcome back";
  }

  function openAccountDialog(mode = "sign-in") {
    const overlay = document.getElementById("account-overlay");
    overlay.hidden = false;
    setAccountMode(mode);
    document.getElementById("close-account-button").focus();
  }

  function findTarget(event) {
    const target = event.target.closest("[data-kind]");
    if (!target) return null;
    if (target.dataset.kind === "terminal") {
      return {
        kind: "terminal",
        component: target.dataset.component,
        terminal: target.dataset.terminal
      };
    }
    return { kind: target.dataset.kind, id: target.dataset.id };
  }

  function addComponentProbe(componentId, measurement = document.getElementById("probe-measurement").value) {
    const component = componentById(componentId);
    if (!component || !["current", "voltage"].includes(measurement)) return;
    const unit = measurement === "current" ? "A" : "V";
    const result = oscilloscope.addTrace({
      id: `component:${component.id}:${measurement}`,
      label: `${component.id} ${measurement}`,
      unit,
      readValue: () => {
        const values = analysisResult.components[component.id];
        return values ? values[measurement] : null;
      }
    });
    if (!result.ok) {
      showToast(result.reason === "unit"
        ? "Use one measurement unit per graph; clear probes before switching between A and V."
        : "That component is already being probed.");
      return;
    }
    oscilloscopePanel.hidden = false;
    oscilloscope.setVisible(true);
    document.getElementById("footer-message").textContent = `Oscilloscope probing ${component.id} ${measurement}.`;
  }

  function addNodeProbe(componentId, terminal) {
    const terminalNodes = analysisResult.terminalNodes || {};
    const nodeId = terminalNodes[componentId] && terminalNodes[componentId][terminal];
    const key = nodeId || `${componentId}:${terminal}`;
    const result = oscilloscope.addTrace({
      id: `node:${key}`,
      label: `Node ${nodeId || key}`,
      unit: "V",
      readValue: () => {
        const currentNodeId = (analysisResult.terminalNodes || {})[componentId];
        const resolvedId = currentNodeId && currentNodeId[terminal];
        return resolvedId && analysisResult.nodeVoltages
          ? analysisResult.nodeVoltages[resolvedId]
          : null;
      }
    });
    if (!result.ok) {
      showToast(result.reason === "unit"
        ? "Use one measurement unit per graph; clear probes before switching between A and V."
        : "That node is already being probed.");
      return;
    }
    oscilloscopePanel.hidden = false;
    oscilloscope.setVisible(true);
    document.getElementById("footer-message").textContent = `Oscilloscope probing node ${nodeId || key}.`;
  }

  function handle3DProbePick(target) {
    if (!target || activeTool !== "probe") return;
    if (target.kind === "node") addNodeProbe(target.componentId, target.terminal);
    else if (target.kind === "component") {
      addComponentProbe(target.componentId);
      showToast(`Probe attached to ${target.componentId} in the 3D view.`);
    }
  }

  function finishWire(target) {
    if (!wireStart || !target || target.kind !== "terminal") return false;
    const start = wireStart;
    wireStart = null;
    const result = model.addConnection(
      start.component,
      start.terminal,
      target.component,
      target.terminal,
      start.wireTap || null
    );
    if (!result.ok) {
      showToast(result.reason === "self" ? "Choose a different terminal." : result.reason === "duplicate" ? "Those terminals are already connected." : "That terminal is no longer available.");
      return false;
    }
    return true;
  }

  function finishFreeWire(point) {
    if (!wireStart || !point) return false;
    const start = wireStart;
    wireStart = null;
    const result = model.addFreeConnection(
      start.component,
      start.terminal,
      snappedPoint(point),
      start.wireTap ? { ...start.wireTap, side: "from" } : null
    );
    if (!result.ok) {
      showToast(result.reason === "endpoint" ? "Choose an endpoint inside the canvas." : "The wire start is no longer available.");
      draw();
      return false;
    }
    document.getElementById("footer-message").textContent = "Open-ended wire added.";
    return true;
  }

  function finishWireAtTap(connection, point) {
    if (!wireStart || !connection || !point) return false;
    const start = wireStart;
    const source = componentById(start.component);
    if (!source) return false;
    const pin = endpoint(source, start.terminal);
    const horizontal = source.rotation % 180 === 0;
    const route = wireRoute(connection);
    let alignedTap = null;
    let alignmentDistance = Infinity;
    for (let index = 1; index < route.length; index += 1) {
      const segmentStart = route[index - 1];
      const segmentEnd = route[index];
      let candidate = null;
      if (horizontal) {
        if (Math.abs(segmentStart.y - pin.y) < 1e-6 && Math.abs(segmentEnd.y - pin.y) < 1e-6) {
          candidate = closestPointOnRoute(point, [segmentStart, segmentEnd]);
        } else if (Math.abs(segmentStart.x - segmentEnd.x) < 1e-6 &&
          pin.y >= Math.min(segmentStart.y, segmentEnd.y) && pin.y <= Math.max(segmentStart.y, segmentEnd.y)) {
          candidate = { x: segmentStart.x, y: pin.y };
        }
      } else if (Math.abs(segmentStart.x - pin.x) < 1e-6 && Math.abs(segmentEnd.x - pin.x) < 1e-6) {
        candidate = closestPointOnRoute(point, [segmentStart, segmentEnd]);
      } else if (Math.abs(segmentStart.y - segmentEnd.y) < 1e-6 &&
        pin.x >= Math.min(segmentStart.x, segmentEnd.x) && pin.x <= Math.max(segmentStart.x, segmentEnd.x)) {
        candidate = { x: pin.x, y: segmentStart.y };
      }
      if (!candidate) continue;
      const distance = Math.hypot(point.x - candidate.x, point.y - candidate.y);
      if (distance < alignmentDistance) {
        alignedTap = candidate;
        alignmentDistance = distance;
      }
    }
    const tap = alignedTap || closestPointOnRoute(point, route);
    wireStart = null;
    const result = model.addConnection(
      start.component,
      start.terminal,
      connection.fromComponent,
      connection.fromTerminal,
      { connectionId: connection.id, x: tap.x, y: tap.y, side: "to" }
    );
    if (!result.ok) {
      showToast(result.reason === "self" ? "Choose a different terminal." : result.reason === "duplicate" ? "Those terminals are already connected." : "That wire is no longer available.");
      return false;
    }
    document.getElementById("footer-message").textContent = `Wire connected to ${connection.id}.`;
    return true;
  }

  function handleCanvasClick(event) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (dragState) return;
    const point = svgPoint(event);
    const target = findTarget(event);
    if (activeTool === "delete") {
      if (target) {
        model.deleteSelection(target.kind === "terminal" ? { kind: "component", id: target.component } : target);
        return;
      }
      model.select(null);
      return;
    }
    if (componentTools.includes(activeTool)) {
      const placement = snappedPoint(point);
      model.addComponent(activeTool, placement.x, placement.y);
      return;
    }
    if (activeTool === "wire") {
      if (!wireStart) return;
      if (target && target.kind === "terminal") finishWire(target);
      else if (target && target.kind === "connection") {
        const connection = model.connections.find((item) => item.id === target.id);
        if (connection) finishWireAtTap(connection, closestPointOnRoute(point, wireRoute(connection)));
      } else finishFreeWire(point);
      return;
    }
    if (activeTool === "probe") {
      if (target && target.kind === "terminal") addNodeProbe(target.component, target.terminal);
      else if (target && target.kind === "component") addComponentProbe(target.id);
      else document.getElementById("footer-message").textContent = "Probe a component or terminal on the schematic.";
      return;
    }
    if (target) model.select(target.kind === "terminal" ? { kind: "component", id: target.component } : target);
    else model.select(null);
  }

  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.button !== 1) return;
    if ((spacePressed && event.button === 0) || event.button === 1) {
      event.preventDefault();
      panState = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: viewBox.x,
        startY: viewBox.y,
        width: viewBox.width,
        height: viewBox.height
      };
      svg.setPointerCapture(event.pointerId);
      return;
    }
    const target = findTarget(event);
    if (activeTool === "wire") {
      if (!target || (target.kind !== "terminal" && target.kind !== "connection")) {
        if (wireStart) suppressClick = false;
        return;
      }
      event.preventDefault();
      suppressClick = true;
      if (!wireStart) {
        if (target.kind === "terminal") {
          wireStart = { component: target.component, terminal: target.terminal };
          wirePointerStartedFromTap = false;
          document.getElementById("footer-message").textContent = `Drag to a terminal or blank canvas to wire from ${target.component} · ${target.terminal}`;
        } else {
          const connection = model.connections.find((item) => item.id === target.id);
          const point = svgPoint(event);
          const tap = connection && closestPointOnRoute(point, wireRoute(connection));
          if (!connection || !tap) return;
          wireStart = {
            component: connection.fromComponent,
            terminal: connection.fromTerminal,
            wireTap: { connectionId: connection.id, x: tap.x, y: tap.y }
          };
          wirePointerStartedFromTap = true;
          document.getElementById("footer-message").textContent = `Wire tap on ${connection.id} — drag to a terminal or blank canvas.`;
        }
        pointerPosition = svgPoint(event);
        draw();
      } else {
        wirePointerStartedFromTap = false;
      }
      wirePointerId = event.pointerId;
      svg.setPointerCapture(event.pointerId);
      return;
    }
    if (activeTool !== "select") return;
    if (!target || target.kind !== "component") return;
    const point = svgPoint(event);
    const component = componentById(target.id);
    dragState = { id: target.id, startX: point.x, startY: point.y, originalX: component.x, originalY: component.y, moved: false };
    model.select(target);
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener("pointermove", (event) => {
    if (panState && panState.pointerId === event.pointerId) {
      const bounds = svg.getBoundingClientRect();
      const scale = Math.min(bounds.width / panState.width, bounds.height / panState.height);
      viewBox.x = panState.startX - (event.clientX - panState.startClientX) / scale;
      viewBox.y = panState.startY - (event.clientY - panState.startClientY) / scale;
      clampViewBox();
      updateViewBox();
    }
    pointerPosition = svgPoint(event);
    const coords = document.getElementById("canvas-coordinates");
    coords.textContent = `X ${String(Math.round(pointerPosition.x)).padStart(3, "0")} · Y ${String(Math.round(pointerPosition.y)).padStart(3, "0")}`;
    if (wireStart) draw();
    if (panState) return;
    if (dragState) {
      const dx = pointerPosition.x - dragState.startX;
      const dy = pointerPosition.y - dragState.startY;
      if (Math.hypot(dx, dy) > 3) dragState.moved = true;
      if (dragState.moved) {
        const position = snappedPoint({ x: dragState.originalX + dx, y: dragState.originalY + dy });
        model.moveComponent(dragState.id, position.x, position.y, false);
      }
    }
  });
  svg.addEventListener("pointerup", (event) => {
    if (panState && panState.pointerId === event.pointerId) {
      panState = null;
      return;
    }
    if (activeTool === "wire" && wirePointerId === event.pointerId) {
      wirePointerId = null;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const terminal = hit && hit.closest("[data-kind=\"terminal\"]");
      const wire = hit && hit.closest("[data-kind=\"connection\"]");
      if (terminal && wireStart) {
        const target = {
          kind: "terminal",
          component: terminal.dataset.component,
          terminal: terminal.dataset.terminal
        };
        if (target.component !== wireStart.component || target.terminal !== wireStart.terminal) finishWire(target);
      } else if (wire && wireStart && !wirePointerStartedFromTap) {
        const connection = model.connections.find((item) => item.id === wire.dataset.id);
        if (connection) finishWireAtTap(connection, closestPointOnRoute(svgPoint(event), wireRoute(connection)));
      } else if (wire && wirePointerStartedFromTap) {
        wirePointerStartedFromTap = false;
        return;
      } else if (wireStart) {
        finishFreeWire(svgPoint(event));
      }
      wirePointerStartedFromTap = false;
      return;
    }
    if (!dragState) return;
    const wasMoved = dragState.moved;
    const component = componentById(dragState.id);
    if (wasMoved && component) {
      model.commit("component-moved");
      suppressClick = true;
    }
    dragState = null;
  });
  svg.addEventListener("pointercancel", (event) => {
    if (panState && panState.pointerId === event.pointerId) panState = null;
    if (wirePointerId === event.pointerId) {
      wirePointerId = null;
      wireStart = null;
      wirePointerStartedFromTap = false;
      draw();
    }
    if (dragState) {
      model.moveComponent(dragState.id, dragState.originalX, dragState.originalY, false);
      dragState = null;
    }
  });
  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    const point = svgPoint(event);
    zoomAt(point, event.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });
  svg.addEventListener("click", handleCanvasClick);
  svg.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      const target = findTarget(event);
      if (!target) return;
      event.preventDefault();
      if (target.kind === "terminal" && activeTool === "wire") {
        if (!wireStart) {
          wireStart = { component: target.component, terminal: target.terminal };
          pointerPosition = endpoint(componentById(target.component), target.terminal);
          draw();
        } else finishWire(target);
      } else {
        model.select(target.kind === "terminal" ? { kind: "component", id: target.component } : target);
      }
    }
  });

  toolButtons.forEach((button) => {
    button.addEventListener("click", (event) => {
      if (suppressPaletteClick) {
        suppressPaletteClick = false;
        event.preventDefault();
        return;
      }
      setTool(button.dataset.tool);
    });
    if (componentTools.includes(button.dataset.tool)) {
      button.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        paletteDrag = {
          type: button.dataset.tool,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          started: false
        };
        button.setPointerCapture(event.pointerId);
      });
    }
  });
  window.addEventListener("pointermove", (event) => {
    if (!paletteDrag || paletteDrag.pointerId !== event.pointerId) return;
    if (!paletteDrag.started && Math.hypot(
      event.clientX - paletteDrag.startX,
      event.clientY - paletteDrag.startY
    ) > 6) paletteDrag.started = true;
    if (paletteDrag.started) {
      svg.classList.toggle("canvas-drop-target", pointerIsOverCanvas(event));
    }
  });
  window.addEventListener("pointerup", (event) => {
    if (!paletteDrag || paletteDrag.pointerId !== event.pointerId) return;
    if (paletteDrag.started && pointerIsOverCanvas(event)) {
      const point = svgPoint(event);
      const placement = snappedPoint(point);
      model.addComponent(paletteDrag.type, placement.x, placement.y);
    }
    if (paletteDrag.started) {
      suppressPaletteClick = true;
      setTimeout(() => { suppressPaletteClick = false; }, 0);
    }
    svg.classList.remove("canvas-drop-target");
    paletteDrag = null;
  });
  window.addEventListener("pointercancel", (event) => {
    if (!paletteDrag || paletteDrag.pointerId !== event.pointerId) return;
    paletteDrag = null;
    svg.classList.remove("canvas-drop-target");
  });
  document.getElementById("zoom-out-button").addEventListener("click", () => zoomFromCenter(1 / 1.2));
  document.getElementById("zoom-in-button").addEventListener("click", () => zoomFromCenter(1.2));
  document.getElementById("rotate-button").addEventListener("click", () => {
    if (model.selection && model.selection.kind === "component") model.rotateComponent(model.selection.id);
  });
  document.getElementById("undo-button").addEventListener("click", () => model.undo());
  document.getElementById("redo-button").addEventListener("click", () => model.redo());
  document.getElementById("clear-button").addEventListener("click", () => {
    if (model.clear()) showToast("Circuit cleared.");
  });
  document.getElementById("clear-probes-button").addEventListener("click", () => {
    oscilloscope.clear();
    if (activeTool !== "probe") {
      oscilloscopePanel.hidden = true;
      oscilloscope.setVisible(false);
    }
  });
  function closeCircuit3D() {
    circuit3DOverlay.hidden = true;
    document.body.style.overflow = "";
    if (circuit3DVisualizer) {
      circuit3DVisualizer.setVisible(false);
      circuit3DVisualizer.setProbeMode(false, null);
    }
    circuit3DLauncher.focus();
  }
  async function openCircuit3D(showCurrentFlow = false) {
    currentFlow3DMode = showCurrentFlow;
    circuit3DLauncher = showCurrentFlow
      ? document.getElementById("current-flow-3d-button")
      : document.getElementById("view-3d-button");
    circuit3DOverlay.hidden = false;
    document.body.style.overflow = "hidden";
    document.getElementById("circuit-3d-title").textContent = showCurrentFlow ? "3D Current Flow" : "Circuit 3D";
    circuit3DMessage.textContent = "Preparing the 3D view…";
    document.getElementById("close-3d-button").focus();
    try {
      if (!circuit3DModulePromise) {
        circuit3DModulePromise = import("./circuit-3d-visualizer.js");
      }
      const { Circuit3DVisualizer } = await circuit3DModulePromise;
      if (circuit3DVisualizer && circuit3DVisualizer.failed) {
        circuit3DVisualizer.dispose();
        circuit3DVisualizer = null;
      }
      if (!circuit3DVisualizer) {
        circuit3DVisualizer = new Circuit3DVisualizer(circuit3DContainer, handleCircuit3DState);
      }
      circuit3DVisualizer.setCircuit(model.snapshot(), analysisResult);
      circuit3DVisualizer.setCurrentFlowMode(showCurrentFlow);
      circuit3DVisualizer.setVisible(!circuit3DOverlay.hidden);
      circuit3DVisualizer.setProbeMode(activeTool === "probe", handle3DProbePick);
      circuit3DMessage.hidden = true;
      circuit3DStatus.textContent = getCircuit3DStatus();
    } catch (error) {
      circuit3DMessage.hidden = false;
      circuit3DMessage.textContent = "Could not load Three.js or initialize WebGL. Check your connection and browser support.";
      circuit3DModulePromise = null;
      console.error("Could not initialize the 3D circuit view.", error);
      showToast(error.message || "Could not load the 3D view.");
    }
  }
  document.getElementById("view-3d-button").addEventListener("click", () => openCircuit3D(false));
  document.getElementById("current-flow-3d-button").addEventListener("click", () => openCircuit3D(true));
  document.getElementById("close-3d-button").addEventListener("click", closeCircuit3D);
  circuit3DOverlay.addEventListener("click", (event) => {
    if (event.target === circuit3DOverlay) closeCircuit3D();
  });
  circuit3DOverlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeCircuit3D();
    }
  }, true);

  function saveCircuit() {
    const savedToLibrary = saveToLibrary(currentCircuitName, false);
    const data = JSON.stringify(model.snapshot(), null, 2);
    let storageFailed = false;
    try { localStorage.setItem("bench-circuit", data); } catch (error) {
      storageFailed = true;
      console.error("Could not save circuit data in browser storage.", error);
    }
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "circuit.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    hasUnsavedChanges = false;
    updateStatus();
    document.getElementById("footer-message").textContent = savedToLibrary
      ? "Circuit saved to this browser and downloaded as circuit.json"
      : "Circuit downloaded as circuit.json";
    showToast(storageFailed || !savedToLibrary
      ? "Circuit downloaded, but browser storage was unavailable."
      : "Circuit saved to this browser and downloaded.");
  }
  document.getElementById("save-button").addEventListener("click", saveCircuit);
  document.getElementById("save-circuit-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.getElementById("saved-circuit-name").value.trim();
    if (saveToLibrary(name)) hasUnsavedChanges = false;
    updateStatus();
  });
  document.getElementById("load-button").addEventListener("click", () => document.getElementById("file-input").click());
  document.getElementById("file-input").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      model.load(JSON.parse(await file.text()));
      currentCircuitId = null;
      setCircuitName("Untitled circuit");
      hasUnsavedChanges = false;
      updateStatus();
      showToast("Circuit loaded successfully.");
    } catch (error) {
      showToast(error instanceof SyntaxError ? "Could not read that file as circuit JSON." : error.message);
    } finally {
      event.target.value = "";
    }
  });
  document.querySelectorAll(".nav-tab").forEach((tab) => {
    tab.addEventListener("click", () => showPage(tab.dataset.page));
  });
  document.getElementById("breadboard-toggle").addEventListener("click", () => {
    preferences.breadboard = !preferences.breadboard;
    persistPreferences();
    renderBreadboard();
  });
  document.getElementById("snap-to-grid").addEventListener("change", (event) => {
    preferences.snapToGrid = event.target.checked;
    persistPreferences();
  });
  document.getElementById("show-schematic-grid").addEventListener("change", (event) => {
    preferences.showGrid = event.target.checked;
    persistPreferences();
    renderBreadboard();
  });
  document.getElementById("account-button").addEventListener("click", () => openAccountDialog());
  document.getElementById("close-account-button").addEventListener("click", () => {
    document.getElementById("account-overlay").hidden = true;
  });
  document.getElementById("account-overlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.hidden = true;
  });
  document.getElementById("sign-in-tab").addEventListener("click", () => setAccountMode("sign-in"));
  document.getElementById("sign-up-tab").addEventListener("click", () => setAccountMode("sign-up"));
  ["sign-in-form", "sign-up-form"].forEach((id) => {
    document.getElementById(id).addEventListener("submit", (event) => {
      event.preventDefault();
      showToast("Authentication is not connected yet. No account data was sent or stored.");
    });
  });
  document.getElementById("help-button").addEventListener("click", () => showToast("Shortcuts: V select · P probe · R rotate · Delete remove · Space+drag pan · wheel zoom · Ctrl/Cmd+Z undo"));
  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space") return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
      target instanceof HTMLButtonElement || target.isContentEditable) return;
    spacePressed = true;
    event.preventDefault();
  });
  document.addEventListener("keyup", (event) => {
    if (event.code === "Space") spacePressed = false;
  });
  window.addEventListener("blur", () => {
    spacePressed = false;
    panState = null;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !document.getElementById("account-overlay").hidden) {
      document.getElementById("account-overlay").hidden = true;
      return;
    }
    const target = event.target;
    const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (editing) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "z") {
      event.preventDefault();
      if (event.shiftKey) model.redo(); else model.undo();
    } else if ((event.ctrlKey || event.metaKey) && key === "y") {
      event.preventDefault();
      model.redo();
    } else if (key === "delete" || key === "backspace") {
      if (model.selection) { event.preventDefault(); model.deleteSelection(); }
      else if (activeTool !== "delete") { event.preventDefault(); model.select(null); }
    } else if (key === "r" && model.selection && model.selection.kind === "component") {
      model.rotateComponent(model.selection.id);
    } else if (key === "v") setTool("select");
    else if (key === "p") setTool("probe");
    else if (key === "escape") {
      wireStart = null;
      setTool("select");
      model.select(null);
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (hasUnsavedChanges) { event.preventDefault(); event.returnValue = ""; }
  });

  updateViewBox();
  setCircuitName(currentCircuitName);
  renderBreadboard();
  setTool("select");
  renderInspector();
  updateStatus();
})();
