/*
 * canvas-paint -- freehand painting on a <canvas>, no dependencies.
 *
 * Coordinates are kept in CSS pixels; the backing store is scaled by
 * devicePixelRatio so strokes stay sharp on high-density displays.
 */
(() => {
  'use strict';

  const canvas = document.getElementById('surface');
  const ctx = canvas.getContext('2d');

  const colorInput = document.getElementById('color');
  const sizeInput = document.getElementById('size');
  const sizeOutput = document.getElementById('size-output');
  const widthInput = document.getElementById('canvas-width');
  const heightInput = document.getElementById('canvas-height');
  const brushPreview = document.getElementById('brush-preview');
  const undoButton = document.getElementById('undo');
  const clearButton = document.getElementById('clear');
  const saveButton = document.getElementById('save');
  const statusEl = document.getElementById('status');

  const BACKGROUND = '#ffffff';
  const MAX_HISTORY = 24;
  const PREVIEW_CAP = 36;
  const SIZE = { min: 1, max: 80 };
  const EXTENT = { min: 120, max: 2400 };
  const DEFAULT = { width: 720, height: 450 };

  const state = {
    color: colorInput.value,
    size: Number(sizeInput.value),
    painting: false,
    lastX: 0,
    lastY: 0,
    width: 0, // logical canvas size, in CSS pixels
    height: 0,
  };

  /** Undo snapshots, oldest first. */
  const history = [];

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  /**
   * Read an integer out of a text field. Returns null for anything that isn't a
   * finite number -- note that Number('') is 0, so empty input needs its own check.
   */
  function parseExtent(raw) {
    const text = String(raw).trim();
    if (text === '') return null;
    const value = Number(text);
    return Number.isFinite(value) ? Math.round(value) : null;
  }

  function announce(message) {
    statusEl.textContent = message;
  }

  // --- canvas sizing -------------------------------------------------------

  function applyBrushDefaults() {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  /**
   * Resize the drawing surface. Changing width/height always clears the backing
   * store, so existing artwork is copied back in, anchored at the top-left.
   */
  function resizeSurface(width, height) {
    const ratio = window.devicePixelRatio || 1;

    let carried = null;
    if (state.width > 0 && canvas.width > 0) {
      carried = document.createElement('canvas');
      carried.width = canvas.width;
      carried.height = canvas.height;
      carried.getContext('2d').drawImage(canvas, 0, 0);
    }
    const carriedWidth = state.width;
    const carriedHeight = state.height;

    state.width = width;
    state.height = height;
    canvas.style.width = `${width}px`;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    applyBrushDefaults();

    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, width, height);
    if (carried) ctx.drawImage(carried, 0, 0, carriedWidth, carriedHeight);

    widthInput.value = String(width);
    heightInput.value = String(height);
  }

  function handleExtentChange() {
    const width = parseExtent(widthInput.value);
    const height = parseExtent(heightInput.value);

    if (width === null || height === null) {
      widthInput.value = String(state.width);
      heightInput.value = String(state.height);
      announce('Width and height both need to be numbers.');
      return;
    }

    const nextWidth = clamp(width, EXTENT.min, EXTENT.max);
    const nextHeight = clamp(height, EXTENT.min, EXTENT.max);

    if (nextWidth === state.width && nextHeight === state.height) {
      widthInput.value = String(nextWidth);
      heightInput.value = String(nextHeight);
      return;
    }

    remember();
    resizeSurface(nextWidth, nextHeight);
    announce(`Canvas is now ${nextWidth} by ${nextHeight} pixels.`);
  }

  // --- undo history --------------------------------------------------------

  function remember() {
    history.push({
      deviceWidth: canvas.width,
      deviceHeight: canvas.height,
      width: state.width,
      height: state.height,
      image: ctx.getImageData(0, 0, canvas.width, canvas.height),
    });
    if (history.length > MAX_HISTORY) history.shift();
    undoButton.disabled = false;
  }

  function undo() {
    const snapshot = history.pop();
    if (!snapshot) return;

    if (snapshot.deviceWidth !== canvas.width || snapshot.deviceHeight !== canvas.height) {
      canvas.width = snapshot.deviceWidth;
      canvas.height = snapshot.deviceHeight;
      canvas.style.width = `${snapshot.width}px`;
      state.width = snapshot.width;
      state.height = snapshot.height;
      widthInput.value = String(snapshot.width);
      heightInput.value = String(snapshot.height);

      const ratio = snapshot.deviceWidth / snapshot.width;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      applyBrushDefaults();
    }

    // putImageData ignores the current transform, so device pixels go back as-is.
    ctx.putImageData(snapshot.image, 0, 0);
    undoButton.disabled = history.length === 0;
    announce('Reverted the last change.');
  }

  // --- painting ------------------------------------------------------------

  /** Map a pointer event onto canvas coordinates, allowing for CSS downscaling. */
  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width ? state.width / rect.width : 1;
    const scaleY = rect.height ? state.height / rect.height : 1;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  }

  /** A single click should leave a mark, not nothing. */
  function paintDot(x, y) {
    ctx.beginPath();
    ctx.arc(x, y, state.size / 2, 0, Math.PI * 2);
    ctx.fillStyle = state.color;
    ctx.fill();
  }

  /**
   * Join the previous point to this one. Stamping lone circles per event leaves
   * gaps whenever the pointer moves faster than events arrive.
   */
  function paintSegment(x, y) {
    ctx.beginPath();
    ctx.moveTo(state.lastX, state.lastY);
    ctx.lineTo(x, y);
    ctx.strokeStyle = state.color;
    ctx.lineWidth = state.size;
    ctx.stroke();
    state.lastX = x;
    state.lastY = y;
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();

    // Capture keeps move/up events coming here even once the pointer leaves the
    // canvas, so releasing outside it can't leave the brush stuck down.
    canvas.setPointerCapture(event.pointerId);

    remember();
    state.painting = true;
    const { x, y } = pointerPosition(event);
    state.lastX = x;
    state.lastY = y;
    paintDot(x, y);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!state.painting) return;

    // Browsers may batch several moves into one event; replaying them all
    // reproduces the actual path rather than a straight chord across it.
    const coalesced =
      typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    const samples = coalesced.length ? coalesced : [event];

    for (const sample of samples) {
      const { x, y } = pointerPosition(sample);
      paintSegment(x, y);
    }
  });

  function stopPainting(event) {
    if (!state.painting) return;
    state.painting = false;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  }

  canvas.addEventListener('pointerup', stopPainting);
  canvas.addEventListener('pointercancel', stopPainting);

  // --- tools ---------------------------------------------------------------

  function setColor(value) {
    state.color = value;
    brushPreview.style.background = value;
  }

  function setSize(value) {
    state.size = clamp(Math.round(Number(value) || SIZE.min), SIZE.min, SIZE.max);
    sizeInput.value = String(state.size);
    sizeOutput.value = String(state.size);
    const diameter = Math.min(state.size, PREVIEW_CAP);
    brushPreview.style.width = `${diameter}px`;
    brushPreview.style.height = `${diameter}px`;
  }

  function clearCanvas() {
    remember();
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, state.width, state.height);
    announce('Canvas cleared — Undo brings it back.');
  }

  function savePng() {
    const link = document.createElement('a');
    link.download = `painting-${new Date().toISOString().slice(0, 10)}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    announce('Saved a PNG to your downloads.');
  }

  colorInput.addEventListener('input', (event) => setColor(event.target.value));
  sizeInput.addEventListener('input', (event) => setSize(event.target.value));
  widthInput.addEventListener('change', handleExtentChange);
  heightInput.addEventListener('change', handleExtentChange);
  undoButton.addEventListener('click', undo);
  clearButton.addEventListener('click', clearCanvas);
  saveButton.addEventListener('click', savePng);

  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undo();
      return;
    }
    if (event.key === '[') setSize(state.size - 1);
    if (event.key === ']') setSize(state.size + 1);
  });

  setColor(colorInput.value);
  setSize(sizeInput.value);
  resizeSurface(DEFAULT.width, DEFAULT.height);
})();
