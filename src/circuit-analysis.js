(function () {
  "use strict";

  const INCOMPLETE_MESSAGE = "Circuit is incomplete — calculation unavailable.";
  const CLOSED_SWITCH_RESISTANCE = 1e-6;

  class DisjointSet {
    constructor(items) {
      this.parents = new Map(items.map((item) => [item, item]));
    }

    find(item) {
      const parent = this.parents.get(item);
      if (parent === undefined) return undefined;
      if (parent !== item) this.parents.set(item, this.find(parent));
      return this.parents.get(item);
    }

    union(left, right) {
      const leftRoot = this.find(left);
      const rightRoot = this.find(right);
      if (leftRoot !== undefined && rightRoot !== undefined && leftRoot !== rightRoot) {
        this.parents.set(rightRoot, leftRoot);
      }
    }
  }

  function unavailable(status, message, components = {}) {
    return {
      status,
      message,
      totalResistance: null,
      totalVoltage: null,
      totalCurrent: null,
      components,
      nodeVoltages: {},
      terminalNodes: {}
    };
  }

  function solveLinearSystem(matrix, values) {
    const size = values.length;
    const rows = matrix.map((row, index) => {
      const scale = Math.max(...row.map(Math.abs));
      if (!Number.isFinite(scale) || scale === 0) return [...row, values[index]];
      return [...row.map((value) => value / scale), values[index] / scale];
    });
    for (let column = 0; column < size; column += 1) {
      let pivot = column;
      for (let row = column + 1; row < size; row += 1) {
        if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
      }
      if (!Number.isFinite(rows[pivot][column]) || Math.abs(rows[pivot][column]) < 1e-12) return null;
      [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
      const divisor = rows[column][column];
      for (let entry = column; entry <= size; entry += 1) rows[column][entry] /= divisor;
      for (let row = 0; row < size; row += 1) {
        if (row === column) continue;
        const factor = rows[row][column];
        for (let entry = column; entry <= size; entry += 1) {
          rows[row][entry] -= factor * rows[column][entry];
        }
      }
    }
    const result = rows.map((row) => row[size]);
    return result.every(Number.isFinite) ? result : null;
  }

  function calculate(circuit) {
    if (!circuit || !Array.isArray(circuit.components) || !Array.isArray(circuit.connections)) {
      return unavailable("invalid", "Circuit data is invalid.");
    }

    const components = circuit.components;
    const componentIds = new Set();
    for (const component of components) {
      if (!component || typeof component.id !== "string" || !component.id ||
        !["battery", "resistor", "capacitor", "currentSource", "led", "switch"].includes(component.type) || componentIds.has(component.id)) {
        return unavailable("invalid", "Circuit data is invalid — components must have unique IDs and supported types.");
      }
      componentIds.add(component.id);
    }
    const summary = Object.fromEntries(components.map((component) => [
      component.id,
      {
        current: Number.isFinite(component.manualCurrent) ? component.manualCurrent : null,
        voltage: Number.isFinite(component.manualVoltage) ? component.manualVoltage : null,
        voltageDrop: Number.isFinite(component.manualVoltage) ? component.manualVoltage : null,
        terminalVoltages: null,
        manual: {
          current: Number.isFinite(component.manualCurrent),
          voltage: Number.isFinite(component.manualVoltage)
        }
      }
    ]));
    const batteries = components.filter((component) => component.type === "battery");
    const currentSources = components.filter((component) => component.type === "currentSource");
    if (batteries.length === 0 && currentSources.length === 0) {
      return unavailable("incomplete", INCOMPLETE_MESSAGE, summary);
    }
    for (const battery of batteries) {
      if (!Number.isFinite(battery.voltage) || battery.voltage < 0) {
        return unavailable("invalid", `Calculation unavailable — ${battery.id} must have a finite, non-negative voltage.`, summary);
      }
    }
    const resistors = components.filter((component) => component.type === "resistor");
    for (const resistor of resistors) {
      if (!Number.isFinite(resistor.resistance) || resistor.resistance <= 0) {
        return unavailable("invalid", `Calculation unavailable — ${resistor.id} must have a finite resistance greater than zero.`, summary);
      }
      const capacitors = components.filter((component) => component.type === "capacitor");
      for (const capacitor of capacitors) {
        if (!Number.isFinite(capacitor.capacitance) || capacitor.capacitance <= 0) {
          return unavailable("invalid", `Calculation unavailable — ${capacitor.id} must have a finite capacitance greater than zero.`, summary);
        }
      }
    }
    for (const source of currentSources) {
      if (!Number.isFinite(source.sourceCurrent) || source.sourceCurrent < 0 ||
        ![-1, 1].includes(source.direction)) {
        return unavailable("invalid", `Calculation unavailable — ${source.id} must have a finite, non-negative current and valid direction.`, summary);
      }
    }
    const terminalNames = (component) => component.type === "battery"
      ? ["positive", "negative"]
      : ["left", "right"];
    const terminalKey = (componentId, terminal) => `${componentId}:${terminal}`;
    const terminals = components.flatMap((component) =>
      terminalNames(component).map((terminal) => terminalKey(component.id, terminal))
    );
    const nets = new DisjointSet(terminals);
    const componentsById = new Map(components.map((component) => [component.id, component]));
    for (const connection of circuit.connections) {
      const from = connection && componentsById.get(connection.fromComponent);
      const to = connection && componentsById.get(connection.toComponent);
      const isFreeWire = connection && connection.freeEnd !== undefined;
      if (!connection || !from || (!isFreeWire && !to) ||
        !["positive", "negative", "left", "right"].includes(connection.fromTerminal) ||
        (!isFreeWire && !["positive", "negative", "left", "right"].includes(connection.toTerminal)) ||
        (isFreeWire && (
          connection.toComponent !== undefined || connection.toTerminal !== undefined ||
          !connection.freeEnd ||
          !Number.isFinite(connection.freeEnd.x) || connection.freeEnd.x < 0 || connection.freeEnd.x > 1200 ||
          !Number.isFinite(connection.freeEnd.y) || connection.freeEnd.y < 0 || connection.freeEnd.y > 800
        )) ||
        (!isFreeWire && connection.fromComponent === connection.toComponent &&
          connection.fromTerminal === connection.toTerminal)) {
        return unavailable("invalid", "Calculation unavailable — a wire contains invalid component references.", summary);
      }
      if (from.type === "battery" && !["positive", "negative"].includes(connection.fromTerminal) ||
        from.type !== "battery" && !["left", "right"].includes(connection.fromTerminal) ||
        (!isFreeWire && (
          to.type === "battery" && !["positive", "negative"].includes(connection.toTerminal) ||
          to.type !== "battery" && !["left", "right"].includes(connection.toTerminal)
        ))) {
        return unavailable("invalid", "Calculation unavailable — a wire refers to a terminal that does not exist.", summary);
      }
      if (isFreeWire) continue;
      nets.union(
        terminalKey(from.id, connection.fromTerminal),
        terminalKey(to.id, connection.toTerminal)
      );
    }

    const batteryTerminals = new Map(batteries.map((battery) => [
      battery.id,
      {
        positive: nets.find(terminalKey(battery.id, "positive")),
        negative: nets.find(terminalKey(battery.id, "negative"))
      }
    ]));
    for (const battery of batteries) {
      const terminalsForBattery = batteryTerminals.get(battery.id);
      if (!terminalsForBattery || terminalsForBattery.positive === undefined || terminalsForBattery.negative === undefined) {
        return unavailable("invalid", `Calculation unavailable — ${battery.id} terminals are invalid.`, summary);
      }
      if (terminalsForBattery.positive === terminalsForBattery.negative) {
        return unavailable("invalid", `Calculation unavailable — ${battery.id} terminals are short-circuited.`, summary);
      }
    }

    const passiveEdges = components
      .filter((component) => component.type === "resistor" || component.type === "capacitor" || component.type === "switch" || component.type === "led")
      .map((component) => ({
        component,
        left: nets.find(terminalKey(component.id, "left")),
        right: nets.find(terminalKey(component.id, "right")),
        resistance: component.type === "resistor"
          ? component.resistance
          : component.type === "switch" && component.closed ? CLOSED_SWITCH_RESISTANCE : null
      }));
    const topology = new Map();
    passiveEdges
      .filter((edge) => edge.component.type !== "capacitor" && (edge.component.type !== "switch" || edge.component.closed))
      .forEach((edge) => {
        if (!topology.has(edge.left)) topology.set(edge.left, []);
        if (!topology.has(edge.right)) topology.set(edge.right, []);
        topology.get(edge.left).push(edge.right);
        topology.get(edge.right).push(edge.left);
      });
    batteries.forEach((battery) => {
      const { positive, negative } = batteryTerminals.get(battery.id);
      if (!topology.has(positive)) topology.set(positive, []);
      if (!topology.has(negative)) topology.set(negative, []);
      topology.get(positive).push(negative);
      topology.get(negative).push(positive);
    });
    const reachableFrom = (start) => {
      const reachable = new Set([start]);
      const queue = [start];
      while (queue.length) {
        const current = queue.shift();
        (topology.get(current) || []).forEach((neighbor) => {
          if (!reachable.has(neighbor)) {
            reachable.add(neighbor);
            queue.push(neighbor);
          }
        });
      }
      return reachable;
    };
    let activeNodes;
    const firstBattery = batteries[0] || null;
    const firstCurrentSource = currentSources[0] || null;
    const referencePositive = firstBattery
      ? batteryTerminals.get(firstBattery.id).positive
      : nets.find(terminalKey(firstCurrentSource.id, "left"));
    const referenceNegative = firstBattery
      ? batteryTerminals.get(firstBattery.id).negative
      : nets.find(terminalKey(firstCurrentSource.id, "right"));
    activeNodes = reachableFrom(referencePositive);
    if (!activeNodes.has(referenceNegative) ||
      batteries.some((battery) => {
        const terminalsForBattery = batteryTerminals.get(battery.id);
        return !activeNodes.has(terminalsForBattery.positive) || !activeNodes.has(terminalsForBattery.negative);
      }) ||
      currentSources.some((source) =>
        !activeNodes.has(nets.find(terminalKey(source.id, "left"))) ||
        !activeNodes.has(nets.find(terminalKey(source.id, "right"))))) {
      return unavailable("incomplete", INCOMPLETE_MESSAGE, summary);
    }
    const unsupported = passiveEdges.find((edge) =>
      edge.component.type === "led" &&
      activeNodes.has(edge.left) &&
      activeNodes.has(edge.right)
    );
    if (unsupported) {
      return unavailable("invalid", `Calculation unavailable — ${unsupported.component.name || unsupported.component.type} is not supported by the current solver.`, summary);
    }

    const activeEdges = passiveEdges.filter((edge) =>
      (edge.component.type === "resistor" || edge.component.type === "switch" && edge.component.closed) &&
      activeNodes.has(edge.left) && activeNodes.has(edge.right)
    );
    const nodeOrder = Array.from(new Set(terminals.map((terminal) => nets.find(terminal))));
    const reference = referenceNegative;
    const nodeIds = new Map([[reference, "0"]]);
    let nextNodeId = 1;
    nodeOrder.forEach((node) => {
      if (node !== reference) nodeIds.set(node, `N${nextNodeId++}`);
    });
    const unknownNodes = Array.from(activeNodes).filter((node) => node !== reference);
    const nodeIndices = new Map(unknownNodes.map((node, index) => [node, index]));
    function solveCircuit(activeSource = null, omittedBattery = null, testCurrent = null) {
      const activeBatteries = batteries.filter((battery) => battery.id !== omittedBattery);
      const sourceIndices = new Map(activeBatteries.map((battery, index) => [
        battery.id,
        unknownNodes.length + index
      ]));
      const matrixSize = unknownNodes.length + activeBatteries.length;
      const matrix = Array.from({ length: matrixSize }, () => Array(matrixSize).fill(0));
      const rhs = Array(matrixSize).fill(0);
      const stampConductance = (left, right, conductance) => {
        const leftIndex = nodeIndices.get(left);
        const rightIndex = nodeIndices.get(right);
        if (leftIndex !== undefined) matrix[leftIndex][leftIndex] += conductance;
        if (rightIndex !== undefined) matrix[rightIndex][rightIndex] += conductance;
        if (leftIndex !== undefined && rightIndex !== undefined) {
          matrix[leftIndex][rightIndex] -= conductance;
          matrix[rightIndex][leftIndex] -= conductance;
        }
      };
      activeEdges.forEach((edge) => {
        if (edge.left === edge.right) return;
        const conductance = 1 / edge.resistance;
        if (!Number.isFinite(conductance) || conductance <= 0) return;
        stampConductance(edge.left, edge.right, conductance);
      });

      activeBatteries.forEach((battery) => {
        const sourceIndex = sourceIndices.get(battery.id);
        const { positive, negative } = batteryTerminals.get(battery.id);
        const positiveIndex = nodeIndices.get(positive);
        const negativeIndex = nodeIndices.get(negative);
        if (positiveIndex !== undefined) {
          matrix[positiveIndex][sourceIndex] += 1;
          matrix[sourceIndex][positiveIndex] += 1;
        }
        if (negativeIndex !== undefined) {
          matrix[negativeIndex][sourceIndex] -= 1;
          matrix[sourceIndex][negativeIndex] -= 1;
        }
        rhs[sourceIndex] = activeSource && activeSource.id === battery.id ? battery.voltage : 0;
      });
      currentSources.forEach((source) => {
        const leftIndex = nodeIndices.get(nets.find(terminalKey(source.id, "left")));
        const rightIndex = nodeIndices.get(nets.find(terminalKey(source.id, "right")));
        const branchCurrent = activeSource && activeSource.id === source.id
          ? source.sourceCurrent * source.direction
          : 0;
        if (leftIndex !== undefined) rhs[leftIndex] -= branchCurrent;
        if (rightIndex !== undefined) rhs[rightIndex] += branchCurrent;
      });
      if (testCurrent) {
        const fromIndex = nodeIndices.get(testCurrent.from);
        const toIndex = nodeIndices.get(testCurrent.to);
        if (fromIndex !== undefined) rhs[fromIndex] += testCurrent.current;
        if (toIndex !== undefined) rhs[toIndex] -= testCurrent.current;
      }

      const solution = solveLinearSystem(matrix, rhs);
      if (!solution) return null;
      const voltages = new Map([[reference, 0]]);
      unknownNodes.forEach((node, index) => voltages.set(node, solution[index]));
      const sourceCurrents = new Map(activeBatteries.map((battery) => [
        battery.id,
        solution[sourceIndices.get(battery.id)]
      ]));
      return { voltages, sourceCurrents };
    }

    const sourceCases = [...batteries, ...currentSources];
    const actualVoltages = new Map(Array.from(activeNodes, (node) => [node, 0]));
    const totalSourceCurrents = new Map(batteries.map((battery) => [battery.id, 0]));
    // Zero-voltage sources remain shorted; inactive current sources contribute no injection.
    for (const source of sourceCases) {
      const contribution = solveCircuit(source);
      if (!contribution) {
        return unavailable("invalid", "Calculation unavailable — the MNA system is singular or numerically unstable. Check for conflicting or redundant ideal voltage sources.", summary);
      }
      contribution.voltages.forEach((voltage, node) => {
        actualVoltages.set(node, actualVoltages.get(node) + voltage);
      });
      contribution.sourceCurrents.forEach((current, batteryId) => {
        totalSourceCurrents.set(batteryId, totalSourceCurrents.get(batteryId) + current);
      });
    }
    const testResistance = solveCircuit(null, firstBattery ? firstBattery.id : null, {
      from: referencePositive,
      to: referenceNegative,
      current: 1
    });
    if (!testResistance) {
      return unavailable("invalid", "Calculation unavailable — the MNA system could not determine the equivalent resistance.", summary);
    }
    const totalResistance = Math.abs(
      testResistance.voltages.get(referencePositive) - testResistance.voltages.get(referenceNegative)
    );
    const totalVoltage = Math.abs(actualVoltages.get(referencePositive) - actualVoltages.get(referenceNegative));
    const totalCurrent = firstBattery
      ? Math.abs(-totalSourceCurrents.get(firstBattery.id))
      : Math.abs(currentSources.reduce((sum, source) => sum + source.sourceCurrent * source.direction, 0));
    if (![totalResistance, totalVoltage, totalCurrent].every(Number.isFinite)) {
      return unavailable("invalid", "Calculation unavailable — circuit values exceed the supported numeric range.", summary);
    }
    const terminalNodes = {};
    components.forEach((component) => {
      const names = terminalNames(component);
      terminalNodes[component.id] = Object.fromEntries(names.map((name) => [
        name,
        nodeIds.get(nets.find(terminalKey(component.id, name)))
      ]));
    });
    const nodeVoltages = {};
    activeNodes.forEach((node) => {
      nodeVoltages[nodeIds.get(node)] = actualVoltages.get(node);
    });
    batteries.forEach((battery) => {
      const { positive, negative } = batteryTerminals.get(battery.id);
      const batteryVoltageDrop = actualVoltages.get(positive) - actualVoltages.get(negative);
      summary[battery.id] = {
        current: -totalSourceCurrents.get(battery.id),
        voltage: Math.abs(batteryVoltageDrop),
        voltageDrop: batteryVoltageDrop,
        terminalVoltages: {
          positive: actualVoltages.get(positive),
          negative: actualVoltages.get(negative)
        }
      };
    });
    let invalidComponentValue = false;
    activeEdges.forEach((edge) => {
      const leftVoltage = actualVoltages.get(edge.left);
      const rightVoltage = actualVoltages.get(edge.right);
      const voltageDrop = leftVoltage - rightVoltage;
      const current = edge.left === edge.right ? 0 : voltageDrop / edge.resistance;
      if (!Number.isFinite(voltageDrop) || !Number.isFinite(current)) {
        invalidComponentValue = true;
        return;
      }
      summary[edge.component.id] = {
        current: Number.isFinite(edge.component.manualCurrent) ? edge.component.manualCurrent : current,
        voltage: Number.isFinite(edge.component.manualVoltage) ? edge.component.manualVoltage : Math.abs(voltageDrop),
        voltageDrop: Number.isFinite(edge.component.manualVoltage) ? edge.component.manualVoltage : voltageDrop,
        terminalVoltages: { left: leftVoltage, right: rightVoltage },
        manual: {
          current: Number.isFinite(edge.component.manualCurrent),
          voltage: Number.isFinite(edge.component.manualVoltage)
        }
      };
    });
    passiveEdges
      .filter((edge) => edge.component.type === "switch" && !edge.component.closed)
      .forEach((edge) => {
        const leftVoltage = actualVoltages.get(edge.left);
        const rightVoltage = actualVoltages.get(edge.right);
        if (Number.isFinite(leftVoltage) && Number.isFinite(rightVoltage)) {
          summary[edge.component.id] = {
            current: 0,
            voltage: Math.abs(leftVoltage - rightVoltage),
            voltageDrop: leftVoltage - rightVoltage,
            terminalVoltages: { left: leftVoltage, right: rightVoltage },
            manual: { current: false, voltage: false }
          };
        }
      });
    passiveEdges
      .filter((edge) => edge.component.type === "capacitor")
      .forEach((edge) => {
        const leftVoltage = actualVoltages.get(edge.left);
        const rightVoltage = actualVoltages.get(edge.right);
        if (Number.isFinite(leftVoltage) && Number.isFinite(rightVoltage)) {
          summary[edge.component.id] = {
            current: 0,
            voltage: Math.abs(leftVoltage - rightVoltage),
            voltageDrop: leftVoltage - rightVoltage,
            terminalVoltages: { left: leftVoltage, right: rightVoltage },
            manual: { current: false, voltage: false }
          };
        }
      });
    currentSources.forEach((source) => {
      const leftVoltage = actualVoltages.get(nets.find(terminalKey(source.id, "left")));
      const rightVoltage = actualVoltages.get(nets.find(terminalKey(source.id, "right")));
      const voltageDrop = leftVoltage - rightVoltage;
      const current = source.sourceCurrent * source.direction;
      if (!Number.isFinite(voltageDrop) || !Number.isFinite(current)) {
        invalidComponentValue = true;
        return;
      }
      summary[source.id] = {
        current,
        voltage: Math.abs(voltageDrop),
        voltageDrop,
        terminalVoltages: { left: leftVoltage, right: rightVoltage },
        manual: { current: false, voltage: false }
      };
    });
    if (invalidComponentValue) {
      return unavailable("invalid", "Calculation unavailable — circuit values exceed the supported numeric range.", summary);
    }

    return {
      status: "valid",
      message: "",
      totalResistance,
      totalVoltage,
      totalCurrent,
      components: summary,
      nodeVoltages,
      terminalNodes
    };
  }

  window.CircuitAnalysis = { calculate };
})();
