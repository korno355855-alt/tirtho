(function () {
  "use strict";

  const DEFAULTS = {
    battery: { name: "Battery", prefix: "B", voltage: 9 },
    resistor: { name: "Resistor", prefix: "R", resistance: 1000 },
    capacitor: { name: "Capacitor", prefix: "C", capacitance: 1e-6 },
    currentSource: { name: "Current Source", prefix: "I", sourceCurrent: 0.01, direction: 1 },
    led: { name: "LED", prefix: "LED", current: null },
    switch: { name: "Switch", prefix: "SW", current: null, closed: false }
  };

  class CircuitModel {
    constructor() {
      this.components = [];
      this.connections = [];
      this.selection = null;
      this.history = [];
      this.historyIndex = -1;
      this.listeners = new Set();
      this.counters = { B: 0, R: 0, C: 0, I: 0, LED: 0, SW: 0 };
      this.recordHistory();
    }

    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    emit(reason) {
      this.listeners.forEach((listener) => listener(reason));
    }

    snapshot() {
      return {
        version: 1,
        components: this.components.map((component) => ({ ...component })),
        connections: this.connections.map((connection) => ({
          ...connection,
          ...(connection.wireTap ? { wireTap: { ...connection.wireTap } } : {}),
          ...(connection.fromWireTap ? { fromWireTap: { ...connection.fromWireTap } } : {}),
          ...(connection.freeEnd ? { freeEnd: { ...connection.freeEnd } } : {})
        }))
      };
    }

    recordHistory() {
      this.history = this.history.slice(0, this.historyIndex + 1);
      const snapshot = JSON.stringify(this.snapshot());
      if (this.history[this.history.length - 1] === snapshot) return;
      this.history.push(snapshot);
      if (this.history.length > 100) this.history.shift();
      this.historyIndex = this.history.length - 1;
    }

    commit(reason) {
      this.recordHistory();
      this.emit(reason);
    }

    nextId(type) {
      const prefix = DEFAULTS[type].prefix;
      this.counters[prefix] += 1;
      return `${prefix}${this.counters[prefix]}`;
    }

    addComponent(type, x, y) {
      if (!DEFAULTS[type]) throw new Error(`Unsupported component type: ${type}`);
      const component = {
        id: this.nextId(type),
        type,
        name: DEFAULTS[type].name,
        x: Math.max(24, Math.min(1176, Math.round(x))),
        y: Math.max(24, Math.min(776, Math.round(y))),
        rotation: 0,
        current: null,
        ...(type === "battery" ? { voltage: DEFAULTS.battery.voltage } : {}),
        ...(type === "currentSource" ? {
          sourceCurrent: DEFAULTS.currentSource.sourceCurrent,
          direction: DEFAULTS.currentSource.direction
        } : {}),
        ...(type === "resistor" ? {
          resistance: DEFAULTS.resistor.resistance,
          manualCurrent: null,
          manualVoltage: null
        } : {}),
        ...(type === "capacitor" ? { capacitance: DEFAULTS.capacitor.capacitance } : {}),
        ...(type === "switch" ? { closed: DEFAULTS.switch.closed } : {})
      };
      this.components.push(component);
      this.selection = { kind: "component", id: component.id };
      this.commit("component-added");
      return component;
    }

    updateComponent(id, changes, record = true) {
      const component = this.components.find((item) => item.id === id);
      if (!component) return;
      const changed = Object.entries(changes).some(([key, value]) => !Object.is(component[key], value));
      if (!changed) return;
      Object.assign(component, changes);
      if (record) this.commit("component-updated");
      else this.emit("component-preview");
    }

    moveComponent(id, x, y, record = true) {
      const component = this.components.find((item) => item.id === id);
      if (!component) return;
      component.x = Math.max(24, Math.min(1176, Math.round(x)));
      component.y = Math.max(24, Math.min(776, Math.round(y)));
      if (record) this.commit("component-moved");
      else this.emit("component-moving");
    }

    rotateComponent(id) {
      const component = this.components.find((item) => item.id === id);
      if (!component) return;
      component.rotation = (component.rotation + 90) % 360;
      this.commit("component-rotated");
    }

    toggleSwitch(id) {
      const component = this.components.find((item) => item.id === id && item.type === "switch");
      if (!component) return false;
      component.closed = !component.closed;
      this.commit("switch-toggled");
      return true;
    }

    addConnection(fromComponent, fromTerminal, toComponent, toTerminal, wireTap = null, fromWireTap = null) {
      const terminalTypes = {
        battery: ["positive", "negative"],
        resistor: ["left", "right"],
        capacitor: ["left", "right"],
        currentSource: ["left", "right"],
        led: ["left", "right"],
        switch: ["left", "right"]
      };
      if (fromComponent === toComponent && fromTerminal === toTerminal) return { ok: false, reason: "self" };
      const fromComponentData = this.components.find((component) => component.id === fromComponent);
      const toComponentData = this.components.find((component) => component.id === toComponent);
      if (!fromComponentData || !toComponentData) {
        return { ok: false, reason: "missing" };
      }
      if (wireTap && (!this.connections.some((connection) => connection.id === wireTap.connectionId) ||
        !Number.isFinite(wireTap.x) || !Number.isFinite(wireTap.y) ||
        wireTap.x < 0 || wireTap.x > 1200 || wireTap.y < 0 || wireTap.y > 800 ||
        (wireTap.side !== undefined && !["from", "to"].includes(wireTap.side)))) {
        return { ok: false, reason: "tap" };
      }
      if (fromWireTap && (!this.connections.some((connection) => connection.id === fromWireTap.connectionId) ||
        !Number.isFinite(fromWireTap.x) || !Number.isFinite(fromWireTap.y) ||
        fromWireTap.x < 0 || fromWireTap.x > 1200 || fromWireTap.y < 0 || fromWireTap.y > 800)) {
        return { ok: false, reason: "tap" };
      }
      if (!terminalTypes[fromComponentData.type].includes(fromTerminal) || !terminalTypes[toComponentData.type].includes(toTerminal)) {
        return { ok: false, reason: "terminal" };
      }
      const exists = this.connections.some((connection) =>
        (connection.fromComponent === fromComponent && connection.fromTerminal === fromTerminal &&
          connection.toComponent === toComponent && connection.toTerminal === toTerminal) ||
        (connection.fromComponent === toComponent && connection.fromTerminal === toTerminal &&
          connection.toComponent === fromComponent && connection.toTerminal === fromTerminal)
      );
      if (exists) return { ok: false, reason: "duplicate" };
      const nextWireId = this.connections.reduce((maximum, wire) => Math.max(maximum, Number(wire.id.slice(1)) || 0), 0) + 1;
      const connection = {
        id: `W${nextWireId}`,
        fromComponent,
        fromTerminal,
        toComponent,
        toTerminal,
        ...(wireTap ? { wireTap: { ...wireTap } } : {}),
        ...(fromWireTap ? { fromWireTap: { ...fromWireTap } } : {})
      };
      this.connections.push(connection);
      this.selection = { kind: "connection", id: connection.id };
      this.commit("connection-added");
      return { ok: true, connection };
    }

    addFreeConnection(fromComponent, fromTerminal, freeEnd, wireTap = null) {
      const from = this.components.find((component) => component.id === fromComponent);
      const validTerminal = from && (from.type === "battery"
        ? ["positive", "negative"].includes(fromTerminal)
        : ["left", "right"].includes(fromTerminal));
      if (!validTerminal) return { ok: false, reason: "terminal" };
      if (!freeEnd || !Number.isFinite(freeEnd.x) || !Number.isFinite(freeEnd.y) ||
        freeEnd.x < 0 || freeEnd.x > 1200 || freeEnd.y < 0 || freeEnd.y > 800) {
        return { ok: false, reason: "endpoint" };
      }
      if (wireTap && (!this.connections.some((connection) => connection.id === wireTap.connectionId) ||
        !Number.isFinite(wireTap.x) || !Number.isFinite(wireTap.y) ||
        wireTap.x < 0 || wireTap.x > 1200 || wireTap.y < 0 || wireTap.y > 800 ||
        (wireTap.side !== undefined && !["from", "to"].includes(wireTap.side)))) {
        return { ok: false, reason: "tap" };
      }
      const nextWireId = this.connections.reduce((maximum, wire) => Math.max(maximum, Number(wire.id.slice(1)) || 0), 0) + 1;
      const connection = {
        id: `W${nextWireId}`,
        fromComponent,
        fromTerminal,
        freeEnd: { ...freeEnd },
        ...(wireTap ? { wireTap: { ...wireTap } } : {})
      };
      this.connections.push(connection);
      this.selection = { kind: "connection", id: connection.id };
      this.commit("connection-added");
      return { ok: true, connection };
    }

    select(selection) {
      this.selection = selection;
      this.emit("selection-changed");
    }

    deleteSelection(selection = this.selection) {
      if (!selection) return false;
      if (selection.kind === "component") {
        const before = this.components.length;
        this.components = this.components.filter((component) => component.id !== selection.id);
        if (this.components.length === before) return false;
        this.connections = this.connections.filter((connection) =>
          connection.fromComponent !== selection.id && connection.toComponent !== selection.id
        );
      } else if (selection.kind === "connection") {
        const before = this.connections.length;
        this.connections = this.connections.filter((connection) => connection.id !== selection.id);
        if (this.connections.length === before) return false;
        this.connections.forEach((connection) => {
          if (connection.wireTap && connection.wireTap.connectionId === selection.id) {
            delete connection.wireTap;
          }
        });
      }
      this.selection = null;
      this.commit("selection-deleted");
      return true;
    }

    clear() {
      if (!this.components.length && !this.connections.length) return false;
      this.components = [];
      this.connections = [];
      this.selection = null;
      this.commit("circuit-cleared");
      return true;
    }

    undo() {
      if (this.historyIndex <= 0) return false;
      this.historyIndex -= 1;
      this.restoreSnapshot(this.history[this.historyIndex]);
      this.emit("undo");
      return true;
    }

    redo() {
      if (this.historyIndex >= this.history.length - 1) return false;
      this.historyIndex += 1;
      this.restoreSnapshot(this.history[this.historyIndex]);
      this.emit("redo");
      return true;
    }

    restoreSnapshot(serialized) {
      const snapshot = JSON.parse(serialized);
      this.components = snapshot.components.map((component) => ({ ...component }));
      this.connections = snapshot.connections.map((connection) => ({
        ...connection,
        ...(connection.wireTap ? { wireTap: { ...connection.wireTap } } : {}),
        ...(connection.fromWireTap ? { fromWireTap: { ...connection.fromWireTap } } : {}),
        ...(connection.freeEnd ? { freeEnd: { ...connection.freeEnd } } : {})
      }));
      this.selection = null;
      this.refreshCounters();
    }

    refreshCounters() {
      this.counters = { B: 0, R: 0, C: 0, I: 0, LED: 0, SW: 0 };
      this.components.forEach((component) => {
        const prefix = DEFAULTS[component.type] && DEFAULTS[component.type].prefix;
        const match = prefix && component.id.match(new RegExp(`^${prefix}(\\d+)$`));
        if (match) this.counters[prefix] = Math.max(this.counters[prefix], Number(match[1]));
      });
    }

    load(data) {
      if (!data || !Array.isArray(data.components) || !Array.isArray(data.connections)) {
        throw new Error("Invalid circuit file: expected components and connections arrays.");
      }
      const ids = new Set();
      data.components.forEach((component) => {
        const prefixes = { battery: "B", resistor: "R", capacitor: "C", currentSource: "I", led: "LED", switch: "SW" };
        const prefix = component && prefixes[component.type];
        if (!component || typeof component.id !== "string" || !DEFAULTS[component.type] ||
          !Number.isFinite(component.x) || !Number.isFinite(component.y) ||
          component.x < 0 || component.x > 1200 || component.y < 0 || component.y > 800 ||
          !Number.isInteger(component.rotation) || component.rotation % 90 !== 0 ||
          typeof component.name !== "string" || !component.name.trim() ||
          !prefix || !new RegExp(`^${prefix}\\d+$`).test(component.id) || ids.has(component.id) ||
          (component.type === "battery" && (!Number.isFinite(component.voltage) || component.voltage < 0)) ||
          (component.type === "currentSource" && (
            !Number.isFinite(component.sourceCurrent) || component.sourceCurrent < 0 ||
            ![-1, 1].includes(component.direction)
          )) ||
          (component.type === "resistor" && (
            !Number.isFinite(component.resistance) || component.resistance < 0 ||
            (component.manualCurrent !== undefined && component.manualCurrent !== null && !Number.isFinite(component.manualCurrent)) ||
            (component.manualVoltage !== undefined && component.manualVoltage !== null && !Number.isFinite(component.manualVoltage))
          )) ||
          (component.type === "capacitor" && (!Number.isFinite(component.capacitance) || component.capacitance <= 0)) ||
          (component.type === "switch" && component.closed !== undefined && typeof component.closed !== "boolean")) {
          throw new Error("Invalid circuit file: a component is malformed or has a duplicate ID.");
        }
        ids.add(component.id);
      });
      const connectionIds = new Set();
      const connectionIdsInFile = new Set(data.connections.map((connection) => connection && connection.id));
      const connectionPairs = new Set();
      const normalizedConnections = [];
      const componentTypes = new Map(data.components.map((component) => [component.id, component.type]));
      const validTerminal = (componentId, terminal) => componentTypes.get(componentId) === "battery"
        ? ["positive", "negative"].includes(terminal)
        : ["left", "right"].includes(terminal);
      data.connections.forEach((connection) => {
        const legacy = connection && connection.fromComponent === undefined && connection.toComponent === undefined &&
          ids.has(connection.from) && ids.has(connection.to) && connection.from !== connection.to;
        const legacyFrom = legacy && data.components.find((component) => component.id === connection.from);
        const legacyTo = legacy && data.components.find((component) => component.id === connection.to);
        const normalized = legacy
          ? {
            ...connection,
            fromComponent: connection.from,
            fromTerminal: legacyFrom.type === "battery" ? "negative" : "right",
            toComponent: connection.to,
            toTerminal: legacyTo.type === "battery" ? "positive" : "left"
          }
          : connection;
        const isFreeWire = normalized && normalized.freeEnd !== undefined;
        if (!normalized || typeof normalized.id !== "string" || !/^W\d+$/.test(normalized.id) || connectionIds.has(normalized.id) ||
          !ids.has(normalized.fromComponent) || (!isFreeWire && !ids.has(normalized.toComponent)) ||
          !validTerminal(normalized.fromComponent, normalized.fromTerminal) ||
          (!isFreeWire && !validTerminal(normalized.toComponent, normalized.toTerminal)) ||
          (isFreeWire && (
            normalized.toComponent !== undefined || normalized.toTerminal !== undefined ||
            !normalized.freeEnd || !Number.isFinite(normalized.freeEnd.x) ||
            normalized.freeEnd.x < 0 || normalized.freeEnd.x > 1200 ||
            !Number.isFinite(normalized.freeEnd.y) || normalized.freeEnd.y < 0 || normalized.freeEnd.y > 800
          )) ||
          (normalized.wireTap !== undefined && (
            !normalized.wireTap || typeof normalized.wireTap.connectionId !== "string" ||
            !connectionIds.has(normalized.wireTap.connectionId) ||
            !connectionIdsInFile.has(normalized.wireTap.connectionId) ||
            !Number.isFinite(normalized.wireTap.x) || normalized.wireTap.x < 0 || normalized.wireTap.x > 1200 ||
            !Number.isFinite(normalized.wireTap.y) || normalized.wireTap.y < 0 || normalized.wireTap.y > 800 ||
            (normalized.wireTap.side !== undefined && !["from", "to"].includes(normalized.wireTap.side))
          )) ||
          (normalized.fromWireTap !== undefined && (
            !normalized.fromWireTap || typeof normalized.fromWireTap.connectionId !== "string" ||
            !connectionIds.has(normalized.fromWireTap.connectionId) ||
            !connectionIdsInFile.has(normalized.fromWireTap.connectionId) ||
            !Number.isFinite(normalized.fromWireTap.x) || normalized.fromWireTap.x < 0 || normalized.fromWireTap.x > 1200 ||
            !Number.isFinite(normalized.fromWireTap.y) || normalized.fromWireTap.y < 0 || normalized.fromWireTap.y > 800
          )) ||
          (!isFreeWire && normalized.fromComponent === normalized.toComponent && normalized.fromTerminal === normalized.toTerminal)) {
          throw new Error("Invalid circuit file: a wire references an invalid component.");
        }
        const pair = [
          `${normalized.fromComponent}:${normalized.fromTerminal}`,
          isFreeWire
            ? `free:${normalized.freeEnd.x},${normalized.freeEnd.y}`
            : `${normalized.toComponent}:${normalized.toTerminal}`
        ].sort().join(":");
        if (connectionPairs.has(pair)) throw new Error("Invalid circuit file: duplicate wires are not allowed.");
        connectionIds.add(normalized.id);
        connectionPairs.add(pair);
        normalizedConnections.push({
          id: normalized.id,
          fromComponent: normalized.fromComponent,
          fromTerminal: normalized.fromTerminal,
          ...(!isFreeWire ? {
            toComponent: normalized.toComponent,
            toTerminal: normalized.toTerminal
          } : { freeEnd: { ...normalized.freeEnd } }),
            ...(normalized.wireTap ? { wireTap: { ...normalized.wireTap } } : {}),
            ...(normalized.fromWireTap ? { fromWireTap: { ...normalized.fromWireTap } } : {})
        });
      });
      this.components = data.components.map((component) => ({
        id: component.id,
        type: component.type,
        name: component.name,
        x: component.x,
        y: component.y,
        rotation: component.rotation % 360,
        current: null,
        ...(component.type === "battery" ? { voltage: component.voltage } : {}),
        ...(component.type === "currentSource" ? {
          sourceCurrent: component.sourceCurrent,
          direction: component.direction
        } : {}),
        ...(component.type === "resistor" ? {
          resistance: component.resistance,
          manualCurrent: component.manualCurrent ?? null,
          manualVoltage: component.manualVoltage ?? null
        } : {}),
        ...(component.type === "capacitor" ? { capacitance: component.capacitance } : {}),
        ...(component.type === "switch" ? { closed: component.closed === true } : {})
      }));
      this.connections = normalizedConnections;
      this.selection = null;
      this.refreshCounters();
      this.commit("circuit-loaded");
    }

    canUndo() { return this.historyIndex > 0; }
    canRedo() { return this.historyIndex < this.history.length - 1; }
  }

  window.CircuitModel = CircuitModel;
})();
