(function () {
  "use strict";

  const MAX_SAMPLES = 360;
  const WINDOW_SECONDS = 12;
  const COLORS = ["#87e6ae", "#6fc9ed", "#f3bd76", "#d99cf2", "#f18e91", "#d9e477"];

  class CircuitOscilloscope {
    constructor(canvas, legend, emptyMessage) {
      if (!(canvas instanceof HTMLCanvasElement) || !(legend instanceof HTMLElement) ||
        !(emptyMessage instanceof HTMLElement)) {
        throw new TypeError("CircuitOscilloscope requires a canvas, legend, and empty-state element.");
      }
      this.canvas = canvas;
      this.context = canvas.getContext("2d");
      if (!this.context) throw new Error("Canvas 2D is unavailable for the oscilloscope.");
      this.legend = legend;
      this.emptyMessage = emptyMessage;
      this.traces = new Map();
      this.visible = false;
      this.timer = null;
      this.startTime = performance.now() / 1000;
      this.handleLegendClick = this.handleLegendClick.bind(this);
      this.resizeObserver = new ResizeObserver(() => this.draw());
      this.resizeObserver.observe(this.canvas.parentElement);
      this.legend.addEventListener("click", this.handleLegendClick);
      this.draw();
    }

    handleLegendClick(event) {
      const button = event.target.closest("[data-remove-trace]");
      if (button) this.removeTrace(button.dataset.removeTrace);
    }

    addTrace(trace) {
      if (!trace || typeof trace.id !== "string" || typeof trace.label !== "string" ||
        !["A", "V"].includes(trace.unit) || typeof trace.readValue !== "function") {
        throw new TypeError("A probe requires an ID, label, A/V unit, and value reader.");
      }
      const existing = this.traces.get(trace.id);
      if (existing) return { ok: false, reason: "duplicate" };
      const unit = this.traces.values().next().value;
      if (unit && unit.unit !== trace.unit) return { ok: false, reason: "unit" };
      this.traces.set(trace.id, {
        ...trace,
        color: COLORS[this.traces.size % COLORS.length],
        samples: []
      });
      this.sample();
      this.renderLegend();
      this.syncTimer();
      return { ok: true };
    }

    removeTrace(id) {
      if (!this.traces.delete(id)) return false;
      this.renderLegend();
      this.syncTimer();
      this.draw();
      return true;
    }

    clear() {
      this.traces.clear();
      this.renderLegend();
      this.syncTimer();
      this.draw();
    }

    setVisible(visible) {
      this.visible = Boolean(visible);
      this.syncTimer();
      if (this.visible) this.draw();
    }

    syncTimer() {
      const shouldRun = this.visible && this.traces.size > 0;
      if (shouldRun && !this.timer) {
        this.timer = window.setInterval(() => this.sample(), 100);
      } else if (!shouldRun && this.timer) {
        window.clearInterval(this.timer);
        this.timer = null;
      }
    }

    sample(timestamp = performance.now() / 1000) {
      const time = timestamp - this.startTime;
      this.traces.forEach((trace) => {
        const value = trace.readValue();
        trace.samples.push({ time, value: Number.isFinite(value) ? value : null });
        if (trace.samples.length > MAX_SAMPLES) trace.samples.shift();
        while (trace.samples.length > 2 && time - trace.samples[0].time > WINDOW_SECONDS) {
          trace.samples.shift();
        }
      });
      this.legend.querySelectorAll("[data-trace-value]").forEach((node) => {
        const trace = this.traces.get(node.dataset.traceValue);
        const latest = trace && trace.samples[trace.samples.length - 1];
        node.textContent = latest && Number.isFinite(latest.value)
          ? `${Number(latest.value.toPrecision(5))} ${trace.unit}`
          : trace ? `— ${trace.unit}` : "";
      });
      this.draw();
    }

    renderLegend() {
      this.emptyMessage.hidden = this.traces.size > 0;
      this.legend.replaceChildren();
      this.traces.forEach((trace) => {
        const item = document.createElement("span");
        item.className = "scope-legend-item";
        item.style.setProperty("--trace-color", trace.color);
        const swatch = document.createElement("i");
        swatch.setAttribute("aria-hidden", "true");
        const text = document.createElement("span");
        text.textContent = trace.label;
        const latest = trace.samples[trace.samples.length - 1];
        const value = document.createElement("strong");
        value.dataset.traceValue = trace.id;
        value.textContent = latest && Number.isFinite(latest.value)
          ? `${Number(latest.value.toPrecision(5))} ${trace.unit}`
          : `— ${trace.unit}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.dataset.removeTrace = trace.id;
        remove.setAttribute("aria-label", `Remove ${trace.label} probe`);
        remove.textContent = "×";
        item.append(swatch, text, value, remove);
        this.legend.appendChild(item);
      });
    }

    draw() {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(rect.width * dpr);
      const height = Math.round(rect.height * dpr);
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      const context = this.context;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);
      context.fillStyle = "#111a1f";
      context.fillRect(0, 0, rect.width, rect.height);

      const plot = { left: 49, right: rect.width - 13, top: 12, bottom: rect.height - 24 };
      const plotWidth = Math.max(1, plot.right - plot.left);
      const plotHeight = Math.max(1, plot.bottom - plot.top);
      const now = performance.now() / 1000 - this.startTime;
      const values = [];
      this.traces.forEach((trace) => trace.samples.forEach((sample) => {
        if (Number.isFinite(sample.value) && sample.time >= now - WINDOW_SECONDS) values.push(sample.value);
      }));
      let minValue = values.length ? values.reduce((minimum, value) => Math.min(minimum, value), Infinity) : -1;
      let maxValue = values.length ? values.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : 1;
      if (minValue === maxValue) {
        const padding = Math.max(Math.abs(minValue) * 0.12, 0.1);
        minValue -= padding;
        maxValue += padding;
      } else {
        const padding = (maxValue - minValue) * 0.12;
        minValue -= padding;
        maxValue += padding;
      }

      context.lineWidth = 1;
      context.font = '9px "DM Mono", Consolas, monospace';
      context.textAlign = "right";
      context.textBaseline = "middle";
      for (let index = 0; index <= 4; index += 1) {
        const fraction = index / 4;
        const y = plot.top + plotHeight * fraction;
        const value = maxValue - (maxValue - minValue) * fraction;
        context.strokeStyle = "#29373c";
        context.beginPath();
        context.moveTo(plot.left, y);
        context.lineTo(plot.right, y);
        context.stroke();
        context.fillStyle = "#819095";
        context.fillText(Number(value.toPrecision(3)).toString(), plot.left - 7, y);
      }
      for (let index = 0; index <= 4; index += 1) {
        const fraction = index / 4;
        const x = plot.left + plotWidth * fraction;
        context.strokeStyle = "#202d32";
        context.beginPath();
        context.moveTo(x, plot.top);
        context.lineTo(x, plot.bottom);
        context.stroke();
        context.fillStyle = "#74858a";
        context.textAlign = "center";
        context.textBaseline = "top";
        context.fillText(`${Math.round(-WINDOW_SECONDS + WINDOW_SECONDS * fraction)}s`, x, plot.bottom + 5);
      }
      context.save();
      context.beginPath();
      context.rect(plot.left, plot.top, plotWidth, plotHeight);
      context.clip();
      this.traces.forEach((trace) => {
        context.strokeStyle = trace.color;
        context.lineWidth = 1.8;
        context.shadowColor = trace.color;
        context.shadowBlur = 5;
        context.beginPath();
        let drawing = false;
        trace.samples.forEach((sample) => {
          if (!Number.isFinite(sample.value) || sample.time < now - WINDOW_SECONDS) {
            drawing = false;
            return;
          }
          const x = plot.right - ((now - sample.time) / WINDOW_SECONDS) * plotWidth;
          const y = plot.bottom - ((sample.value - minValue) / (maxValue - minValue)) * plotHeight;
          if (!drawing) {
            context.moveTo(x, y);
            drawing = true;
          } else {
            context.lineTo(x, y);
          }
        });
        context.stroke();
      });
      context.restore();
    }

    dispose() {
      this.setVisible(false);
      this.resizeObserver.disconnect();
      this.legend.removeEventListener("click", this.handleLegendClick);
      this.traces.clear();
      this.legend.replaceChildren();
    }
  }

  window.CircuitOscilloscope = CircuitOscilloscope;
})();
