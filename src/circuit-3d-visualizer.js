import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const COMPONENT_HEIGHT = 0.3;
const WORLD_SCALE = 0.015;
const ELECTRONS_PER_WIRE = 3;
const FLOW_ARROWS_PER_WIRE = 2;
const DEMO_CIRCUIT = {
  components: [
    { id: "B1", type: "battery", name: "Battery", x: 410, y: 360, rotation: 0, voltage: 9 },
    { id: "R1", type: "resistor", name: "Resistor", x: 790, y: 440, rotation: 0, resistance: 1000 }
  ],
  connections: [
    { id: "demo-wire-1", fromComponent: "B1", fromTerminal: "negative", toComponent: "R1", toTerminal: "right" },
    { id: "demo-wire-2", fromComponent: "R1", fromTerminal: "left", toComponent: "B1", toTerminal: "positive" }
  ]
};
const DEMO_ANALYSIS = {
  B1: {
    current: 0.009,
    terminalVoltages: { positive: 9, negative: 0 }
  },
  R1: {
    current: 0.009,
    terminalVoltages: { left: 9, right: 0 }
  }
};

export class Circuit3DVisualizer {
  constructor(container, onStateChange = () => {}) {
    if (!(container instanceof HTMLElement)) {
      throw new TypeError("Circuit3DVisualizer requires a valid container element.");
    }
    if (typeof onStateChange !== "function") {
      throw new TypeError("Circuit3DVisualizer onStateChange must be a function.");
    }
    this.container = container;
    this.onStateChange = onStateChange;
    this.contextLost = false;
    this.failed = false;
    this.disposed = false;
    this.visible = false;
    this.frameHandle = 0;
    this.canvas = document.createElement("canvas");
    this.handleContextCreationError = (event) => {
      const detail = event.statusMessage ? ` (${event.statusMessage})` : "";
      this.reportFailure(new Error(`WebGL context creation failed${detail}.`));
    };
    this.canvas.addEventListener("webglcontextcreationerror", this.handleContextCreationError);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#101820");
    this.scene.fog = new THREE.Fog("#101820", 18, 42);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camera.position.set(0, 10, 12);
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
    } catch (error) {
      this.canvas.removeEventListener("webglcontextcreationerror", this.handleContextCreationError);
      this.canvas.remove();
      throw new Error("Unable to initialize WebGL for the 3D circuit view.", { cause: error });
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.domElement.className = "circuit-3d-canvas";
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    this.container.appendChild(this.renderer.domElement);
    this.canvas.removeEventListener("webglcontextcreationerror", this.handleContextCreationError);
    this.handleContextLost = this.handleContextLost.bind(this);
    this.handleContextRestored = this.handleContextRestored.bind(this);
    this.renderer.domElement.addEventListener("webglcontextlost", this.handleContextLost, false);
    this.renderer.domElement.addEventListener("webglcontextrestored", this.handleContextRestored, false);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0.15, 0);
    this.controls.minDistance = 4;
    this.controls.maxDistance = 28;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.raycaster = new THREE.Raycaster();
    this.probePointer = new THREE.Vector2();
    this.probeMode = false;
    this.probeHandler = null;
    this.pointerDown = null;
    this.handleProbePointerDown = this.handleProbePointerDown.bind(this);
    this.handleProbePointerUp = this.handleProbePointerUp.bind(this);
    this.renderer.domElement.addEventListener("pointerdown", this.handleProbePointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.handleProbePointerUp);
    this.scene.add(new THREE.HemisphereLight("#dcefff", "#243028", 2));
    const keyLight = new THREE.DirectionalLight("#ffffff", 3);
    keyLight.position.set(-5, 9, 6);
    this.scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight("#79d9af", 1.8);
    rimLight.position.set(5, 5, -7);
    this.scene.add(rimLight);

    // A subdued tabletop and grid preserve the simulator's technical visual style.
    this.board = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 40),
      new THREE.MeshStandardMaterial({ color: "#172229", roughness: 0.94, metalness: 0.04 })
    );
    this.board.rotation.x = -Math.PI / 2;
    this.board.position.y = -0.035;
    this.scene.add(this.board);
    this.grid = new THREE.GridHelper(30, 60, "#40564e", "#27383a");
    this.grid.position.y = -0.02;
    this.scene.add(this.grid);
    this.content = new THREE.Group();
    this.scene.add(this.content);

    this.electronMaterial = new THREE.MeshStandardMaterial({
      color: "#d8ffe2",
      emissive: "#65ff9a",
      emissiveIntensity: 5,
      roughness: 0.2,
      metalness: 0
    });
    this.electronGeometry = new THREE.SphereGeometry(0.075, 14, 10);
    this.flowArrowGeometry = new THREE.ConeGeometry(0.075, 0.2, 10);
    this.flowArrowMaterial = new THREE.MeshStandardMaterial({
      color: "#e7fff0",
      emissive: "#79ffae",
      emissiveIntensity: 4,
      roughness: 0.2
    });
    this.flowArrowAxis = new THREE.Vector3(0, 1, 0);
    this.electrons = [];
    this.flowArrows = [];
    this.currentFlowMode = false;
    this.layoutSignature = null;
    this.lastFrame = 0;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    this.animate = this.animate.bind(this);
  }

  notifyState(state, error = null) {
    this.onStateChange(state, error);
  }

  reportFailure(error) {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.stopAnimation();
    this.pointerDown = null;
    this.probeMode = false;
    this.notifyState("error", error);
  }

  handleContextLost(event) {
    event.preventDefault();
    if (this.disposed) return;
    this.contextLost = true;
    this.lastFrame = 0;
    this.pointerDown = null;
    this.stopAnimation();
    this.notifyState("context-lost");
  }

  handleContextRestored() {
    if (this.disposed || this.failed) return;
    this.contextLost = false;
    this.lastFrame = 0;
    this.notifyState("context-restored");
    this.resize();
    if (this.failed) return;
    if (!this.visible) {
      try {
        this.renderer.render(this.scene, this.camera);
      } catch (error) {
        this.reportFailure(error);
        return;
      }
    }
    if (this.visible) this.startAnimation();
  }

  mapPoint(x, y, height = COMPONENT_HEIGHT) {
    // Keep the schematic centered at world origin and invert screen Y into depth.
    return new THREE.Vector3((x - 600) * WORLD_SCALE, height, (400 - y) * WORLD_SCALE);
  }

  terminalPosition(component, terminal) {
    const left = component.type === "battery" ? terminal === "positive" : terminal === "left";
    const radians = THREE.MathUtils.degToRad(component.rotation || 0);
    const localX = left ? -32 : 32;
    return this.mapPoint(
      component.x + localX * Math.cos(radians),
      component.y + localX * Math.sin(radians),
      COMPONENT_HEIGHT
    );
  }

  makeMaterial(color, emissive = "#000000", emissiveIntensity = 0) {
    return new THREE.MeshStandardMaterial({
      color,
      emissive,
      emissiveIntensity,
      roughness: 0.42,
      metalness: 0.24
    });
  }

  addLeads(group, material, fromX, toX) {
    [-1, 1].forEach((direction) => {
      const lead = new THREE.Mesh(
        new THREE.CylinderGeometry(0.022, 0.022, toX - fromX, 10),
        material
      );
      lead.rotation.z = Math.PI / 2;
      lead.position.x = direction * ((fromX + toX) / 2);
      group.add(lead);
    });
  }

  createComponentMesh(component) {
    // Build lightweight meshes aligned to the schematic's terminal spacing.
    const group = new THREE.Group();
    const leadMaterial = this.makeMaterial("#b4c5bd", "#42634f", 0.25);
    const bodyMaterial = component.type === "battery"
      ? this.makeMaterial("#4a9a69", "#173a29", 0.6)
      : component.type === "resistor"
        ? this.makeMaterial("#d09a61", "#4a2c14", 0.28)
        : component.type === "capacitor"
          ? this.makeMaterial("#75b7c9", "#174452", 0.45)
        : component.type === "currentSource"
          ? this.makeMaterial("#6ea9cf", "#173d58", 0.8)
        : component.type === "led"
          ? this.makeMaterial("#dc7774", "#b72536", 1.2)
          : this.makeMaterial("#8ea2a4", "#263d40", 0.3);

    if (component.type === "battery") {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.62, 24), bodyMaterial);
      body.rotation.z = Math.PI / 2;
      group.add(body);
      const capMaterial = this.makeMaterial("#d6e7d9", "#7acb91", 0.5);
      [-0.33, 0.33].forEach((x) => {
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.035, 18), capMaterial);
        cap.rotation.z = Math.PI / 2;
        cap.position.x = x;
        group.add(cap);
      });
      this.addLeads(group, leadMaterial, 0.34, 0.49);
    } else if (component.type === "resistor") {
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.48, 5, 14), bodyMaterial);
      body.rotation.z = Math.PI / 2;
      group.add(body);
      this.addLeads(group, leadMaterial, 0.35, 0.49);
      const bandMaterial = this.makeMaterial("#543a2d");
      [-0.19, 0, 0.19].forEach((x) => {
        const band = new THREE.Mesh(new THREE.TorusGeometry(0.132, 0.018, 6, 20), bandMaterial);
        band.rotation.y = Math.PI / 2;
        band.position.x = x;
        group.add(band);
      });
    } else if (component.type === "capacitor") {
      [-0.055, 0.055].forEach((x) => {
        const plate = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.42, 0.12), bodyMaterial);
        plate.position.x = x;
        group.add(plate);
      });
      this.addLeads(group, leadMaterial, 0.09, 0.49);
    } else if (component.type === "led") {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.4, 20), bodyMaterial);
      body.rotation.z = Math.PI / 2;
      group.add(body);
      const lens = new THREE.Mesh(
        new THREE.SphereGeometry(0.145, 18, 14),
        this.makeMaterial("#fa9e95", "#e13249", 2)
      );
      lens.position.x = -0.2;
      group.add(lens);
      this.addLeads(group, leadMaterial, 0.23, 0.49);
    } else if (component.type === "currentSource") {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.045, 8, 24), bodyMaterial);
      ring.rotation.x = Math.PI / 2;
      group.add(ring);
      this.addLeads(group, leadMaterial, 0.21, 0.49);
      const arrow = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.2, 8), leadMaterial);
      shaft.rotation.z = Math.PI / 2;
      arrow.add(shaft);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.1, 10), leadMaterial);
      tip.rotation.z = -Math.PI / 2;
      tip.position.x = 0.12;
      arrow.add(tip);
      arrow.position.y = 0.055;
      arrow.scale.x = component.direction === -1 ? -1 : 1;
      group.add(arrow);
    } else {
      const baseMaterial = this.makeMaterial("#53696a");
      [-0.25, 0.25].forEach((x) => {
        const terminal = new THREE.Mesh(new THREE.SphereGeometry(0.075, 14, 10), baseMaterial);
        terminal.position.x = x;
        group.add(terminal);
      });
      const lever = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.035, 0.42, 10),
        this.makeMaterial("#b9c8c0", "#557565", 0.35)
      );
      lever.position.set(0.03, 0.055, 0);
      lever.rotation.z = component.closed ? 0 : -0.52;
      group.add(lever);
      this.addLeads(group, leadMaterial, 0.26, 0.49);
    }

    group.position.copy(this.mapPoint(component.x, component.y));
    group.rotation.y = THREE.MathUtils.degToRad(component.rotation || 0);
    group.userData.componentId = component.id;
    group.userData.componentName = component.name || component.type;
    group.userData.probeKind = "component";
    const terminals = component.type === "battery" ? ["positive", "negative"] : ["left", "right"];
    terminals.forEach((terminal) => {
      const nodeMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.085, 12, 10),
        this.makeMaterial("#c8ffdc", "#54e68c", 2.4)
      );
      nodeMarker.position.set(terminal === terminals[0] ? -0.49 : 0.49, 0.035, 0);
      nodeMarker.userData.probeKind = "node";
      nodeMarker.userData.componentId = component.id;
      nodeMarker.userData.terminal = terminal;
      group.add(nodeMarker);
    });
    return group;
  }

  terminalCurrentInto(component, terminal, results) {
    const result = results[component.id];
    if (!result || !Number.isFinite(result.current) || Math.abs(result.current) < 1e-12) return 0;
    if (component.type === "battery") {
      return -result.current * (terminal === "positive" ? 1 : -1);
    }
    if (component.type === "currentSource") {
      return result.current * (terminal === "left" ? 1 : -1);
    }
    const voltages = result.terminalVoltages;
    const leftVoltage = voltages && voltages.left;
    const rightVoltage = voltages && voltages.right;
    const currentSign = Number.isFinite(leftVoltage) && Number.isFinite(rightVoltage)
      ? Math.sign(leftVoltage - rightVoltage)
      : Math.sign(result.current);
    return currentSign * Math.abs(result.current) * (terminal === "left" ? 1 : -1);
  }

  buildWire(connection, componentsById, results) {
    const from = componentsById.get(connection.fromComponent);
    const to = componentsById.get(connection.toComponent);
    if (!from || (!to && !connection.freeEnd)) return;
    const tapAtEnd = connection.wireTap && connection.wireTap.side === "to";
    const start = connection.wireTap && !tapAtEnd
      ? this.mapPoint(connection.wireTap.x, connection.wireTap.y, COMPONENT_HEIGHT)
      : this.terminalPosition(from, connection.fromTerminal);
    const end = connection.freeEnd
      ? this.mapPoint(connection.freeEnd.x, connection.freeEnd.y, COMPONENT_HEIGHT)
      : connection.wireTap && tapAtEnd
        ? this.mapPoint(connection.wireTap.x, connection.wireTap.y, COMPONENT_HEIGHT)
        : this.terminalPosition(to, connection.toTerminal);
    const startHorizontal = connection.wireTap && !tapAtEnd ? null : from.rotation % 180 === 0;
    const endHorizontal = connection.freeEnd || connection.wireTap && tapAtEnd
      ? null
      : to.rotation % 180 === 0;
    let route;
    if (connection.freeEnd) {
      const horizontalFirst = startHorizontal === null ? true : startHorizontal;
      route = [
        start,
        horizontalFirst
          ? new THREE.Vector3(end.x, COMPONENT_HEIGHT, start.z)
          : new THREE.Vector3(start.x, COMPONENT_HEIGHT, end.z),
        end
      ];
    } else if (tapAtEnd) {
      route = [
        start,
        startHorizontal
          ? new THREE.Vector3(end.x, COMPONENT_HEIGHT, start.z)
          : new THREE.Vector3(start.x, COMPONENT_HEIGHT, end.z),
        end
      ];
    } else if (startHorizontal !== null && startHorizontal === endHorizontal) {
      if (startHorizontal) {
        const middleX = (start.x + end.x) / 2;
        route = [
          start,
          new THREE.Vector3(middleX, COMPONENT_HEIGHT, start.z),
          new THREE.Vector3(middleX, COMPONENT_HEIGHT, end.z),
          end
        ];
      } else {
        const middleZ = (start.z + end.z) / 2;
        route = [
          start,
          new THREE.Vector3(start.x, COMPONENT_HEIGHT, middleZ),
          new THREE.Vector3(end.x, COMPONENT_HEIGHT, middleZ),
          end
        ];
      }
    } else {
      const horizontalFirst = startHorizontal === null ? !endHorizontal : startHorizontal;
      route = [
        start,
        horizontalFirst
          ? new THREE.Vector3(end.x, COMPONENT_HEIGHT, start.z)
          : new THREE.Vector3(start.x, COMPONENT_HEIGHT, end.z),
        end
      ];
    }
    const points = route.filter((point, index) =>
      index === 0 || point.distanceTo(route[index - 1]) > 1e-6
    );
    if (points.length < 2) return;
    const curve = new THREE.CurvePath();
    for (let index = 1; index < points.length; index += 1) {
      curve.add(new THREE.LineCurve3(points[index - 1], points[index]));
    }
    const material = new THREE.MeshStandardMaterial({
      color: "#65dba0",
      emissive: "#36ce82",
      emissiveIntensity: 2.2,
      roughness: 0.26,
      metalness: 0.25
    });
    for (let index = 1; index < points.length; index += 1) {
      const segment = new THREE.LineCurve3(points[index - 1], points[index]);
      this.content.add(new THREE.Mesh(new THREE.TubeGeometry(segment, 1, 0.025, 7, false), material));
    }
    points.slice(1, -1).forEach((point) => {
      const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), material);
      elbow.position.copy(point);
      this.content.add(elbow);
    });

    const hasFromTerminal = !(connection.wireTap && connection.wireTap.side !== "to");
    const hasToTerminal = !connection.freeEnd &&
      !(connection.wireTap && connection.wireTap.side === "to");
    const fromTerminalCurrent = hasFromTerminal
      ? this.terminalCurrentInto(from, connection.fromTerminal, results)
      : 0;
    const toTerminalCurrent = hasToTerminal
      ? this.terminalCurrentInto(to, connection.toTerminal, results)
      : 0;
    const currentValues = [fromTerminalCurrent, toTerminalCurrent].filter((current) => Math.abs(current) > 1e-12).map(Math.abs);
    // Ideal wire current is not an independent MNA unknown; use the adjacent branch current.
    const branchCurrent = currentValues.length
      ? Math.min(...currentValues)
      : 0;
    const flowDirection = fromTerminalCurrent
      ? -Math.sign(fromTerminalCurrent)
      : toTerminalCurrent
        ? Math.sign(toTerminalCurrent)
        : 0;
    for (let index = 0; index < ELECTRONS_PER_WIRE; index += 1) {
      const electron = new THREE.Mesh(this.electronGeometry, this.electronMaterial);
      electron.visible = branchCurrent > 0 && flowDirection !== 0;
      electron.userData.curve = curve;
      electron.userData.phase = index / ELECTRONS_PER_WIRE;
      electron.userData.current = branchCurrent;
      electron.userData.direction = flowDirection;
      this.electrons.push(electron);
      this.content.add(electron);
    }
    for (let index = 0; index < FLOW_ARROWS_PER_WIRE; index += 1) {
      const arrow = new THREE.Mesh(this.flowArrowGeometry, this.flowArrowMaterial);
      arrow.visible = this.currentFlowMode && branchCurrent > 0 && flowDirection !== 0;
      arrow.userData.curve = curve;
      arrow.userData.phase = index / FLOW_ARROWS_PER_WIRE;
      arrow.userData.current = branchCurrent;
      arrow.userData.direction = flowDirection;
      this.flowArrows.push(arrow);
      this.content.add(arrow);
    }
    const endpoints = connection.wireTap && tapAtEnd
      ? [start]
      : connection.freeEnd
        ? [start, end]
      : connection.wireTap
        ? [end]
        : [start, end];
    endpoints.forEach((point) => {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.055, 12, 8),
        this.makeMaterial("#c2ffdb", "#62f59a", 3)
      );
      marker.position.copy(point);
      this.content.add(marker);
    });
    if (connection.wireTap) {
      const junction = new THREE.Mesh(
        new THREE.SphereGeometry(0.055, 12, 8),
        this.makeMaterial("#c0e5c7", "#62f59a", 2)
      );
      junction.position.copy(tapAtEnd ? end : start);
      this.content.add(junction);
    }
  }

  setCircuit(circuit, analysis) {
    if (this.disposed || this.failed) return;
    if (this.contextLost) return;
    try {
      // The visualizer only reads model snapshots; it never mutates history state.
      this.clearContent();
      const providedComponents = Array.isArray(circuit && circuit.components) ? circuit.components : [];
      const isDemo = providedComponents.length === 0;
      const displayCircuit = isDemo ? DEMO_CIRCUIT : circuit;
      const components = displayCircuit.components;
      const connections = displayCircuit.connections;
      const layoutSignature = JSON.stringify([
        isDemo,
        components.map(({ id, type, x, y, rotation }) => [id, type, x, y, rotation]),
        connections.map(({ id, fromComponent, fromTerminal, toComponent, toTerminal, wireTap, freeEnd }) =>
          [id, fromComponent, fromTerminal, toComponent, toTerminal, wireTap || null, freeEnd || null])
      ]);
      const shouldFitCamera = this.layoutSignature !== layoutSignature;
      this.layoutSignature = layoutSignature;
      const componentsById = new Map(components.map((component) => [component.id, component]));
      components.forEach((component) => this.content.add(this.createComponentMesh(component)));
      const results = isDemo
        ? DEMO_ANALYSIS
        : analysis && analysis.components ? analysis.components : {};
      connections.forEach((connection) => this.buildWire(connection, componentsById, results));
      if (components.length && shouldFitCamera) {
        const centerX = components.reduce((sum, component) => sum + component.x, 0) / components.length;
        const centerY = components.reduce((sum, component) => sum + component.y, 0) / components.length;
        const target = this.mapPoint(centerX, centerY, 0);
        this.controls.target.copy(target);
        const positions = components.map((component) => this.mapPoint(component.x, component.y, 0));
        const minX = Math.min(...positions.map((point) => point.x));
        const maxX = Math.max(...positions.map((point) => point.x));
        const minZ = Math.min(...positions.map((point) => point.z));
        const maxZ = Math.max(...positions.map((point) => point.z));
        const aspect = Math.max(1, this.container.clientWidth / Math.max(1, this.container.clientHeight));
        const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
        const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
        const fitDistance = Math.max(
          (maxZ - minZ + 2) / (2 * Math.tan(verticalFov / 2)),
          (maxX - minX + 2) / (2 * Math.tan(horizontalFov / 2))
        ) * 1.15;
        this.camera.position.set(target.x, target.y + fitDistance * 0.72, target.z + fitDistance * 0.7);
        this.camera.lookAt(target);
        this.controls.update();
      }
      this.renderer.render(this.scene, this.camera);
    } catch (error) {
      this.reportFailure(error);
    }
  }

  clearContent() {
    // Retain shared electron resources while disposing meshes rebuilt from new data.
    this.content.traverse((object) => {
      if (!object.isMesh) return;
      if (object.geometry !== this.electronGeometry) object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => {
        if (material !== this.electronMaterial) material.dispose();
      });
    });
    this.content.clear();
    this.electrons = [];
    this.flowArrows = [];
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    if (this.visible) {
      this.resize();
      // Keep the render loop idle while the overlay is closed.
      this.startAnimation();
    } else {
      this.stopAnimation();
    }
  }

  setCurrentFlowMode(enabled) {
    this.currentFlowMode = Boolean(enabled);
    this.flowArrows.forEach((arrow) => {
      arrow.visible = this.currentFlowMode && arrow.userData.current > 0 && arrow.userData.direction !== 0;
    });
    if (this.visible) this.renderer.render(this.scene, this.camera);
  }

  startAnimation() {
    if (this.disposed || this.failed || this.contextLost || !this.visible || this.frameHandle) return;
    this.frameHandle = requestAnimationFrame(this.animate);
  }

  stopAnimation() {
    if (!this.frameHandle) return;
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
  }

  setProbeMode(enabled, handler) {
    if (this.disposed || this.failed) return;
    this.probeMode = Boolean(enabled);
    this.probeHandler = typeof handler === "function" ? handler : null;
    this.renderer.domElement.classList.toggle("circuit-3d-probe-mode", this.probeMode);
  }

  handleProbePointerDown(event) {
    if (!this.probeMode || event.button !== 0) return;
    this.pointerDown = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }

  handleProbePointerUp(event) {
    if (this.failed || this.contextLost || !this.probeMode || !this.pointerDown || this.pointerDown.id !== event.pointerId) return;
    const start = this.pointerDown;
    this.pointerDown = null;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.probePointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.probePointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.probePointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.content.children, true)
      .find((intersection) => {
        let object = intersection.object;
        while (object && !object.userData.probeKind) object = object.parent;
        return Boolean(object && object.userData.probeKind);
      });
    if (!hit) return;
    let object = hit.object;
    while (object && !object.userData.probeKind) object = object.parent;
    if (object && this.probeHandler) {
      this.probeHandler({
        kind: object.userData.probeKind,
        componentId: object.userData.componentId,
        terminal: object.userData.terminal
      });
    }
  }

  resize() {
    if (this.disposed || this.failed || this.contextLost) return;
    try {
      const width = Math.max(1, this.container.clientWidth);
      const height = Math.max(1, this.container.clientHeight);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height);
      if (this.visible) this.renderer.render(this.scene, this.camera);
    } catch (error) {
      this.reportFailure(error);
    }
  }

  animate(timestamp) {
    if (this.disposed) return;
    this.frameHandle = 0;
    if (!this.visible || this.failed || this.contextLost) return;
    try {
      const delta = Math.min((timestamp - this.lastFrame) / 1000 || 0, 0.05);
      this.lastFrame = timestamp;
      this.electrons.forEach((electron) => {
        if (!electron.visible) return;
        const current = electron.userData.current;
        // Log scaling keeps milliamp and amp-level branches both visibly animated.
        const speed = Math.min(1.7, Math.log1p(current / 0.001) * 0.38);
        electron.userData.phase = (electron.userData.phase + speed * delta * electron.userData.direction + 1) % 1;
        electron.position.copy(electron.userData.curve.getPointAt(electron.userData.phase));
      });
      this.flowArrows.forEach((arrow) => {
        if (!arrow.visible) return;
        const speed = Math.min(1.7, Math.log1p(arrow.userData.current / 0.001) * 0.38);
        arrow.userData.phase = (arrow.userData.phase + speed * delta * arrow.userData.direction + 1) % 1;
        arrow.position.copy(arrow.userData.curve.getPointAt(arrow.userData.phase));
        const tangent = arrow.userData.curve.getTangentAt(arrow.userData.phase)
          .multiplyScalar(arrow.userData.direction)
          .normalize();
        arrow.quaternion.setFromUnitVectors(this.flowArrowAxis, tangent);
      });
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.startAnimation();
    } catch (error) {
      this.reportFailure(error);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAnimation();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.domElement.removeEventListener("pointerdown", this.handleProbePointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.handleProbePointerUp);
    this.renderer.domElement.removeEventListener("webglcontextlost", this.handleContextLost);
    this.renderer.domElement.removeEventListener("webglcontextrestored", this.handleContextRestored);
    this.canvas.removeEventListener("webglcontextcreationerror", this.handleContextCreationError);
    this.clearContent();
    this.board.geometry.dispose();
    this.board.material.dispose();
    this.grid.geometry.dispose();
    if (Array.isArray(this.grid.material)) this.grid.material.forEach((material) => material.dispose());
    else this.grid.material.dispose();
    this.electronGeometry.dispose();
    this.electronMaterial.dispose();
    this.flowArrowGeometry.dispose();
    this.flowArrowMaterial.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
