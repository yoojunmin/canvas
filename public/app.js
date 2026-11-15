(() => {
  const WIDTH = 1200;
  const HEIGHT = 760;
  const canvas = document.getElementById('drawing-canvas');
  const inputContext = canvas.getContext('2d');
  const canvasPaper = document.getElementById('canvas-paper');
  const canvasStage = document.getElementById('canvas-stage');
  const canvasViewer = document.getElementById('canvas-viewer');
  const socket = io();
  const $ = (id) => document.getElementById(id);
  const boardList = $('board-list');
  const mobileBoardList = $('mobile-board-list');
  const layerList = $('layer-list');
  const boardName = $('current-board-name');
  const peopleCount = $('people-count');
  const hint = $('canvas-hint');
  const colorPicker = $('color-picker');
  const hexInput = $('hex-input');
  const rgbInputs = [$('red-input'), $('green-input'), $('blue-input')];
  const sizeSlider = $('brush-size');
  const opacitySlider = $('brush-opacity');
  let activeBoardId = null;
  let joiningBoardId = null;
  let boards = [];
  let layers = [];
  let activeLayerId = null;
  let tool = 'brush';
  let brushType = 'normal';
  let color = '#ff6b4a';
  let brushOpacity = 1;
  let isDrawing = false;
  let activeStroke = null;
  let hasDrawing = false;
  let zoom = 100;
  let toastTimer;
  const layerSurfaces = new Map();
  const remoteStrokes = new Map();
  const historyByBoard = new Map();

  inputContext.clearRect(0, 0, WIDTH, HEIGHT);

  function stackFor(boardId = activeBoardId) {
    if (!boardId) return { undo: [], redo: [] };
    if (!historyByBoard.has(boardId)) historyByBoard.set(boardId, { undo: [], redo: [] });
    return historyByBoard.get(boardId);
  }

  function updateHistoryControls() {
    const stacks = stackFor();
    $('undo-button').disabled = !stacks.undo.length;
    $('redo-button').disabled = !stacks.redo.length;
  }

  function setHint() {
    hint.classList.toggle('hidden', hasDrawing);
  }

  function ensureLayerSurface(layer) {
    if (layerSurfaces.has(layer.id)) return layerSurfaces.get(layer.id);
    const surface = document.createElement('canvas');
    surface.width = WIDTH;
    surface.height = HEIGHT;
    surface.className = 'layer-canvas';
    surface.dataset.layerId = layer.id;
    const record = { canvas: surface, ctx: surface.getContext('2d', { willReadFrequently: true }) };
    layerSurfaces.set(layer.id, record);
    return record;
  }

  function syncLayerSurfaces() {
    const ids = new Set(layers.map((layer) => layer.id));
    for (const [id, surface] of layerSurfaces) {
      if (!ids.has(id)) {
        surface.canvas.remove();
        layerSurfaces.delete(id);
      }
    }
    layers.forEach((layer, index) => {
      const surface = ensureLayerSurface(layer);
      surface.canvas.style.display = layer.visible ? 'block' : 'none';
      surface.canvas.style.opacity = String(layer.opacity);
      surface.canvas.style.zIndex = String(index + 1);
      canvasPaper.insertBefore(surface.canvas, canvas);
    });
  }

  function layerContext(layerId) {
    return layerSurfaces.get(layerId)?.ctx || null;
  }

  function drawDot(point, stroke) {
    const target = layerContext(stroke.layerId);
    if (!target) return;
    const x = point.x * WIDTH;
    const y = point.y * HEIGHT;
    const erase = stroke.erase === true;
    const type = erase ? 'normal' : (stroke.brushType || 'normal');
    const opacity = Math.max(0, Math.min(1, Number(stroke.opacity ?? 1)));
    target.save();
    target.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    target.fillStyle = stroke.color;
    let radius = stroke.width / 2;
    let alpha = opacity;
    if (type === 'pencil') { radius *= 0.36; alpha *= 0.56; }
    if (type === 'paintbrush') { radius *= 0.68; alpha *= 0.78; }
    target.globalAlpha = alpha;
    target.beginPath();
    target.arc(x, y, Math.max(0.5, radius), 0, Math.PI * 2);
    target.fill();
    if (type === 'paintbrush') {
      target.globalAlpha = opacity * 0.22;
      target.fillRect(x - radius * 1.35, y - radius * 0.18, radius * 2.7, Math.max(0.7, radius * 0.18));
    }
    target.restore();
  }

  function drawSegment(from, to, stroke) {
    const target = layerContext(stroke.layerId);
    if (!target) return;
    const erase = stroke.erase === true;
    const type = erase ? 'normal' : (stroke.brushType || 'normal');
    const opacity = Math.max(0, Math.min(1, Number(stroke.opacity ?? 1)));
    const x1 = from.x * WIDTH;
    const y1 = from.y * HEIGHT;
    const x2 = to.x * WIDTH;
    const y2 = to.y * HEIGHT;
    const baseWidth = stroke.width;
    const line = (width, alpha, offset = 0) => {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const length = Math.hypot(dx, dy) || 1;
      const ox = (-dy / length) * offset;
      const oy = (dx / length) * offset;
      target.globalAlpha = alpha;
      target.lineWidth = Math.max(0.6, width);
      target.beginPath();
      target.moveTo(x1 + ox, y1 + oy);
      target.lineTo(x2 + ox, y2 + oy);
      target.stroke();
    };
    target.save();
    target.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    target.strokeStyle = stroke.color;
    target.lineCap = 'round';
    target.lineJoin = 'round';
    if (type === 'pencil') {
      line(baseWidth * 0.68, opacity * 0.6);
      line(baseWidth * 0.28, opacity * 0.18, baseWidth * 0.17);
    } else if (type === 'paintbrush') {
      line(baseWidth * 1.3, opacity * 0.48);
      line(baseWidth * 0.72, opacity * 0.86);
      line(baseWidth * 0.13, opacity * 0.28, baseWidth * 0.32);
      line(baseWidth * 0.13, opacity * 0.25, -baseWidth * 0.32);
    } else {
      line(baseWidth, opacity);
    }
    target.restore();
  }

  function replayStroke(stroke) {
    if (!stroke.points?.length || !layerContext(stroke.layerId)) return;
    if (stroke.points.length === 1) drawDot(stroke.points[0], stroke);
    else for (let i = 1; i < stroke.points.length; i += 1) drawSegment(stroke.points[i - 1], stroke.points[i], stroke);
  }

  function hexToRgb(hex) {
    const clean = hex.replace('#', '');
    return [0, 2, 4].map((offset) => parseInt(clean.slice(offset, offset + 2), 16));
  }

  function rgbToHex(values) {
    return `#${values.map((value) => Math.round(Math.max(0, Math.min(255, Number(value) || 0))).toString(16).padStart(2, '0')).join('')}`;
  }

  function setColor(next, source = 'all') {
    if (!/^#[0-9a-f]{6}$/i.test(next)) return;
    color = next.toLowerCase();
    const rgb = hexToRgb(color);
    colorPicker.value = color;
    $('color-preview').style.backgroundColor = color;
    if (source !== 'hex') hexInput.value = color.slice(1).toUpperCase();
    if (source !== 'rgb') rgb.forEach((value, index) => { rgbInputs[index].value = String(value); });
  }

  function sampleColor(point) {
    const x = Math.min(WIDTH - 1, Math.floor(point.x * WIDTH));
    const y = Math.min(HEIGHT - 1, Math.floor(point.y * HEIGHT));
    let result = [251, 250, 246];
    layers.forEach((layer) => {
      if (!layer.visible || layer.opacity <= 0) return;
      const pixel = layerContext(layer.id)?.getImageData(x, y, 1, 1).data;
      if (!pixel || pixel[3] === 0) return;
      const alpha = (pixel[3] / 255) * layer.opacity;
      result = result.map((value, index) => Math.round(pixel[index] * alpha + value * (1 - alpha)));
    });
    return rgbToHex(result);
  }

  function paintBucket(point, fillColor, layerId) {
    const target = layerContext(layerId);
    if (!target) return;
    const px = Math.max(0, Math.min(WIDTH - 1, Math.floor(point.x * WIDTH)));
    const py = Math.max(0, Math.min(HEIGHT - 1, Math.floor(point.y * HEIGHT)));
    const image = target.getImageData(0, 0, WIDTH, HEIGHT);
    const data = image.data;
    const startIndex = (py * WIDTH + px) * 4;
    const targetPixel = [data[startIndex], data[startIndex + 1], data[startIndex + 2], data[startIndex + 3]];
    const replacement = [...hexToRgb(fillColor), 255];
    if (targetPixel.every((value, index) => value === replacement[index])) return;
    const tolerance = 18;
    const matches = (index) => Math.abs(data[index] - targetPixel[0]) <= tolerance
      && Math.abs(data[index + 1] - targetPixel[1]) <= tolerance
      && Math.abs(data[index + 2] - targetPixel[2]) <= tolerance
      && Math.abs(data[index + 3] - targetPixel[3]) <= tolerance;
    const stack = [px, py];
    const seen = new Uint8Array(WIDTH * HEIGHT);
    while (stack.length) {
      const y = stack.pop();
      const x = stack.pop();
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) continue;
      const pixel = y * WIDTH + x;
      if (seen[pixel]) continue;
      seen[pixel] = 1;
      const index = pixel * 4;
      if (!matches(index)) continue;
      data[index] = replacement[0];
      data[index + 1] = replacement[1];
      data[index + 2] = replacement[2];
      data[index + 3] = 255;
      stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
    }
    target.putImageData(image, 0, 0);
  }

  function applyAction(action, updateHint = true) {
    if (action.kind === 'stroke') {
      replayStroke(action);
      hasDrawing = true;
    } else if (action.kind === 'fill') {
      paintBucket(action.point, action.color, action.layerId);
      hasDrawing = true;
    } else if (action.kind === 'clear') {
      layerSurfaces.forEach((surface) => surface.ctx.clearRect(0, 0, WIDTH, HEIGHT));
      hasDrawing = false;
    }
    if (updateHint) setHint();
  }

  function updateSize() {
    $('size-value').textContent = sizeSlider.value;
    const pct = ((Number(sizeSlider.value) - Number(sizeSlider.min)) / (Number(sizeSlider.max) - Number(sizeSlider.min))) * 100;
    sizeSlider.style.setProperty('--range-progress', `${pct}%`);
  }

  function updateBrushOpacity() {
    brushOpacity = Number(opacitySlider.value) / 100;
    $('brush-opacity-value').textContent = `${opacitySlider.value}%`;
    const pct = ((Number(opacitySlider.value) - Number(opacitySlider.min)) / (Number(opacitySlider.max) - Number(opacitySlider.min))) * 100;
    opacitySlider.style.setProperty('--range-progress', `${pct}%`);
  }

  function updateZoom(nextZoom, preserveCenter = true) {
    const oldZoom = zoom;
    const centerX = canvasStage.scrollLeft + canvasStage.clientWidth / 2;
    const centerY = canvasStage.scrollTop + canvasStage.clientHeight / 2;
    zoom = Math.max(50, Math.min(250, nextZoom));
    canvasPaper.style.width = `${zoom}%`;
    $('zoom-level').textContent = `${zoom}%`;
    if (preserveCenter && oldZoom !== zoom) {
      requestAnimationFrame(() => {
        const ratio = zoom / oldZoom;
        canvasStage.scrollLeft = centerX * ratio - canvasStage.clientWidth / 2;
        canvasStage.scrollTop = centerY * ratio - canvasStage.clientHeight / 2;
      });
    }
  }

  function toggleExpandedCanvas() {
    if (document.fullscreenElement === canvasViewer) {
      document.exitFullscreen?.();
      return;
    }
    if (canvasViewer.classList.contains('expanded')) {
      canvasViewer.classList.remove('expanded');
      updateExpandButton();
      return;
    }
    if (canvasViewer.requestFullscreen) {
      canvasViewer.requestFullscreen().catch(() => {
        canvasViewer.classList.add('expanded');
        updateExpandButton();
      });
    } else {
      canvasViewer.classList.add('expanded');
      updateExpandButton();
    }
  }

  function updateExpandButton() {
    const expanded = document.fullscreenElement === canvasViewer || canvasViewer.classList.contains('expanded');
    $('expand-canvas').setAttribute('aria-label', expanded ? '캔버스 크게 보기 닫기' : '캔버스 크게 보기');
    $('expand-canvas').title = expanded ? '크게 보기 닫기' : '화면 크게 보기';
  }

  function renderBoards() {
    boardList.replaceChildren();
    mobileBoardList.replaceChildren();
    boards.forEach((board, index) => {
      [boardList, mobileBoardList].forEach((list) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `board-item${board.id === activeBoardId ? ' active' : ''}`;
        button.setAttribute('aria-current', board.id === activeBoardId ? 'page' : 'false');
        const icon = document.createElement('span');
        icon.className = 'board-icon';
        icon.textContent = ['✳', '▤', '◌', '✿', '▧'][index % 5];
        const name = document.createElement('span');
        name.className = 'board-name';
        name.textContent = board.name;
        const people = document.createElement('span');
        people.className = 'board-people';
        people.textContent = String(board.people || 0).padStart(2, '0');
        button.append(icon, name, people);
        button.addEventListener('click', () => joinBoard(board.id));
        list.append(button);
      });
    });
    $('board-count').textContent = String(boards.length).padStart(2, '0');
  }

  function renderLayers() {
    layerList.replaceChildren();
    [...layers].reverse().forEach((layer, displayIndex) => {
      const row = document.createElement('div');
      row.className = `layer-row${layer.id === activeLayerId ? ' active' : ''}`;
      row.dataset.layerId = layer.id;
      const main = document.createElement('div');
      main.className = 'layer-row-main';
      const visible = document.createElement('button');
      visible.type = 'button';
      visible.className = `layer-visibility${layer.visible ? '' : ' hidden-layer'}`;
      visible.textContent = layer.visible ? '◉' : '○';
      visible.title = layer.visible ? '레이어 숨기기' : '레이어 표시';
      visible.setAttribute('aria-label', visible.title);
      visible.addEventListener('click', () => updateLayer(layer.id, { visible: !layer.visible }));
      const name = document.createElement('input');
      name.className = 'layer-name-input';
      name.value = layer.name;
      name.maxLength = 28;
      name.setAttribute('aria-label', '레이어 이름');
      name.addEventListener('focus', () => setActiveLayer(layer.id));
      name.addEventListener('change', () => updateLayer(layer.id, { name: name.value.trim() || layer.name }));
      name.addEventListener('keydown', (event) => { if (event.key === 'Enter') name.blur(); });
      const up = document.createElement('button');
      up.type = 'button'; up.className = 'layer-order-button'; up.textContent = '↑'; up.title = '위로';
      up.disabled = displayIndex === 0;
      up.addEventListener('click', () => socket.emit('layer:move', { boardId: activeBoardId, id: layer.id, direction: 1 }));
      const down = document.createElement('button');
      down.type = 'button'; down.className = 'layer-order-button'; down.textContent = '↓'; down.title = '아래로';
      down.disabled = displayIndex === layers.length - 1;
      down.addEventListener('click', () => socket.emit('layer:move', { boardId: activeBoardId, id: layer.id, direction: -1 }));
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'layer-delete-button'; remove.textContent = '×'; remove.title = '레이어 삭제';
      remove.disabled = layers.length <= 1;
      remove.addEventListener('click', () => {
        if (layers.length <= 1) return;
        if (!window.confirm(`“${layer.name}” 레이어와 그 안의 그림을 삭제할까요?`)) return;
        socket.emit('layer:delete', { boardId: activeBoardId, id: layer.id });
      });
      main.append(visible, name, up, down, remove);
      main.addEventListener('click', (event) => {
        if (event.target === main) setActiveLayer(layer.id);
      });
      const opacityRow = document.createElement('div');
      opacityRow.className = 'layer-opacity-row';
      const opacityLabel = document.createElement('span');
      opacityLabel.textContent = '불투명도';
      const opacity = document.createElement('input');
      opacity.type = 'range'; opacity.min = '0'; opacity.max = '100'; opacity.value = String(Math.round(layer.opacity * 100));
      opacity.style.setProperty('--range-progress', `${opacity.value}%`);
      opacity.setAttribute('aria-label', `${layer.name} 불투명도`);
      const value = document.createElement('strong');
      value.textContent = `${opacity.value}%`;
      opacity.addEventListener('input', () => {
        layer.opacity = Number(opacity.value) / 100;
        value.textContent = `${opacity.value}%`;
        opacity.style.setProperty('--range-progress', `${opacity.value}%`);
        syncLayerSurfaces();
      });
      opacity.addEventListener('change', () => updateLayer(layer.id, { opacity: Number(opacity.value) / 100 }));
      opacityRow.append(opacityLabel, opacity, value);
      row.append(main, opacityRow);
      row.addEventListener('pointerdown', () => setActiveLayer(layer.id));
      layerList.append(row);
    });
    $('layers-count').textContent = `${layers.length} / 8`;
    $('add-layer-button').disabled = layers.length >= 8;
  }

  function setActiveLayer(id) {
    if (!layers.some((layer) => layer.id === id)) return;
    activeLayerId = id;
    layerList.querySelectorAll('.layer-row').forEach((row) => {
      row.classList.toggle('active', row.dataset.layerId === id);
    });
  }

  function updateLayer(id, patch) {
    const layer = layers.find((item) => item.id === id);
    if (!layer) return;
    Object.assign(layer, patch);
    syncLayerSurfaces();
    renderLayers();
    socket.emit('layer:update', { boardId: activeBoardId, id, patch });
  }

  function setTool(nextTool) {
    tool = nextTool;
    document.querySelectorAll('.tool-button').forEach((button) => {
      button.classList.toggle('selected', button.dataset.tool === nextTool);
    });
    canvas.style.cursor = nextTool === 'eyedropper' ? 'copy' : nextTool === 'fill' ? 'cell' : nextTool === 'eraser' ? 'cell' : 'crosshair';
  }

  function setBrushType(nextType) {
    brushType = nextType;
    document.querySelectorAll('.brush-preset').forEach((button) => {
      button.classList.toggle('selected', button.dataset.brush === nextType);
    });
  }

  function createActionId() {
    return `${socket.id || 'user'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function commitAction(action) {
    action.id ||= createActionId();
    applyAction(action);
    socket.emit('board:action', { boardId: activeBoardId, action });
    const stacks = stackFor();
    stacks.undo.push(action.id);
    stacks.redo.length = 0;
    updateHistoryControls();
  }

  function undo() {
    const stacks = stackFor();
    const id = stacks.undo.pop();
    if (!id || !activeBoardId) return;
    stacks.redo.push(id);
    socket.emit('board:undo', { boardId: activeBoardId, id });
    updateHistoryControls();
  }

  function redo() {
    const stacks = stackFor();
    const id = stacks.redo.pop();
    if (!id || !activeBoardId) return;
    stacks.undo.push(id);
    socket.emit('board:redo', { boardId: activeBoardId, id });
    updateHistoryControls();
  }

  function pointFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  }

  function beginStroke(event) {
    if (!activeBoardId || !activeLayerId || event.button > 0) return;
    event.preventDefault();
    const point = pointFromEvent(event);
    if (tool === 'eyedropper') {
      setColor(sampleColor(point));
      setTool('brush');
      return;
    }
    if (tool === 'fill') {
      commitAction({ kind: 'fill', layerId: activeLayerId, point, color });
      return;
    }
    isDrawing = true;
    canvas.setPointerCapture?.(event.pointerId);
    const stroke = {
      kind: 'stroke', id: createActionId(), layerId: activeLayerId, color,
      width: Number(sizeSlider.value), brushType, opacity: brushOpacity,
      erase: tool === 'eraser', points: [point],
    };
    activeStroke = stroke;
    drawDot(point, stroke);
    hasDrawing = true;
    setHint();
    socket.emit('stroke:start', {
      boardId: activeBoardId, id: stroke.id, layerId: stroke.layerId, color: stroke.color,
      width: stroke.width, brushType: stroke.brushType, opacity: stroke.opacity,
      erase: stroke.erase, point,
    });
  }

  function moveStroke(event) {
    if (!isDrawing || !activeStroke) return;
    const point = pointFromEvent(event);
    const previous = activeStroke.points[activeStroke.points.length - 1];
    activeStroke.points.push(point);
    drawSegment(previous, point, activeStroke);
    socket.emit('stroke:move', { boardId: activeBoardId, id: activeStroke.id, points: [point] });
    setHint();
  }

  function finishStroke() {
    if (!isDrawing || !activeStroke) return;
    isDrawing = false;
    socket.emit('stroke:end', { boardId: activeBoardId, stroke: activeStroke });
    const stacks = stackFor();
    stacks.undo.push(activeStroke.id);
    stacks.redo.length = 0;
    activeStroke = null;
    updateHistoryControls();
  }

  function joinBoard(id) {
    if (!id || id === activeBoardId || id === joiningBoardId) return;
    joiningBoardId = id;
    socket.emit('board:join', { id });
  }

  function setActiveBoard(id) {
    activeBoardId = id;
    joiningBoardId = null;
    const board = boards.find((item) => item.id === id);
    if (board) {
      boardName.textContent = board.name;
      document.title = `${board.name} — 모여그림`;
      const url = new URL(window.location.href);
      url.searchParams.set('board', id);
      window.history.replaceState({}, '', url);
    }
    renderBoards();
    updateHistoryControls();
  }

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  function openBoardModal() {
    $('modal-error').textContent = '';
    $('board-name').value = '';
    $('board-modal').hidden = false;
    $('board-name').focus();
  }

  function closeBoardModal() { $('board-modal').hidden = true; }
  function openShortcuts() { $('shortcuts-modal').hidden = false; }
  function closeShortcuts() { $('shortcuts-modal').hidden = true; }

  socket.on('connect', () => {
    $('sidebar-connection').textContent = '실시간 연결됨';
    $('connection-state').textContent = '연결됨';
    if (activeBoardId) {
      const stacks = stackFor();
      stacks.undo.length = 0;
      stacks.redo.length = 0;
      updateHistoryControls();
      joiningBoardId = activeBoardId;
      socket.emit('board:join', { id: activeBoardId });
    } else socket.emit('boards:list');
  });
  socket.on('disconnect', () => {
    joiningBoardId = null;
    historyByBoard.forEach((stacks) => { stacks.undo.length = 0; stacks.redo.length = 0; });
    updateHistoryControls();
    $('sidebar-connection').textContent = '다시 연결 중';
    $('connection-state').textContent = '재연결 중';
  });

  socket.on('boards:update', (nextBoards) => {
    boards = nextBoards;
    if (!activeBoardId) {
      const requestedId = new URLSearchParams(window.location.search).get('board');
      joinBoard(boards.some((board) => board.id === requestedId) ? requestedId : boards[0]?.id);
    }
    renderBoards();
  });

  socket.on('board:state', ({ boardId, history, layers: nextLayers }) => {
    const sameBoard = boardId === activeBoardId;
    const previousActiveLayer = activeLayerId;
    if (!sameBoard) {
      isDrawing = false;
      activeStroke = null;
    }
    setActiveBoard(boardId);
    remoteStrokes.clear();
    layerSurfaces.forEach((surface) => surface.canvas.remove());
    layerSurfaces.clear();
    layers = Array.isArray(nextLayers) && nextLayers.length
      ? nextLayers.map((layer) => ({ ...layer }))
      : [{ id: 'layer-1', name: '레이어 1', visible: true, opacity: 1 }];
    activeLayerId = layers.some((layer) => layer.id === previousActiveLayer)
      ? previousActiveLayer
      : layers[layers.length - 1].id;
    syncLayerSurfaces();
    ctxClearPointerSurface();
    hasDrawing = false;
    history.forEach((action) => applyAction(action, false));
    if (sameBoard && activeStroke && layerContext(activeStroke.layerId)) {
      replayStroke(activeStroke);
      hasDrawing = true;
    }
    renderLayers();
    setHint();
  });

  function ctxClearPointerSurface() {
    inputContext.clearRect(0, 0, WIDTH, HEIGHT);
  }

  socket.on('layers:update', ({ boardId, layers: nextLayers }) => {
    if (boardId !== activeBoardId) return;
    layers = nextLayers.map((layer) => ({ ...layer }));
    if (!layers.some((layer) => layer.id === activeLayerId)) activeLayerId = layers[layers.length - 1]?.id;
    if (activeStroke && !layers.some((layer) => layer.id === activeStroke.layerId)) {
      isDrawing = false;
      activeStroke = null;
    }
    remoteStrokes.forEach((stroke, id) => {
      if (!layers.some((layer) => layer.id === stroke.layerId)) remoteStrokes.delete(id);
    });
    syncLayerSurfaces();
    renderLayers();
  });

  socket.on('board:presence', ({ boardId, count }) => {
    if (boardId === activeBoardId) peopleCount.textContent = count;
    const board = boards.find((item) => item.id === boardId);
    if (board) board.people = count;
    renderBoards();
  });

  socket.on('board:error', ({ message }) => showToast(message));
  socket.on('stroke:start', (stroke) => {
    drawDot(stroke.point, stroke);
    remoteStrokes.set(stroke.id, { ...stroke, points: [stroke.point] });
    hasDrawing = true;
    setHint();
  });
  socket.on('stroke:move', ({ id, points }) => {
    const live = remoteStrokes.get(id);
    if (!live) return;
    points.forEach((point) => {
      drawSegment(live.points[live.points.length - 1], point, live);
      live.points.push(point);
    });
    hasDrawing = true;
    setHint();
  });
  socket.on('board:action', (action) => {
    if (action.kind === 'clear') remoteStrokes.clear();
    if (action.kind === 'stroke' && action.id && remoteStrokes.has(action.id)) {
      const live = remoteStrokes.get(action.id);
      for (let i = live.points.length; i < action.points.length; i += 1) {
        drawSegment(action.points[i - 1], action.points[i], action);
      }
      remoteStrokes.delete(action.id);
      setHint();
      return;
    }
    applyAction(action);
  });

  canvas.addEventListener('pointerdown', beginStroke);
  canvas.addEventListener('pointermove', moveStroke);
  canvas.addEventListener('pointerup', finishStroke);
  canvas.addEventListener('pointercancel', finishStroke);
  canvas.addEventListener('lostpointercapture', finishStroke);

  document.querySelectorAll('.tool-button').forEach((button) => button.addEventListener('click', () => setTool(button.dataset.tool)));
  document.querySelectorAll('.brush-preset').forEach((button) => button.addEventListener('click', () => {
    setBrushType(button.dataset.brush);
    setTool('brush');
  }));
  sizeSlider.addEventListener('input', updateSize);
  opacitySlider.addEventListener('input', updateBrushOpacity);
  colorPicker.addEventListener('input', () => setColor(colorPicker.value));
  hexInput.addEventListener('input', () => {
    const value = hexInput.value.replace(/[^0-9a-f]/gi, '').slice(0, 6);
    if (value.length === 6) setColor(`#${value}`, 'hex');
  });
  hexInput.addEventListener('blur', () => { hexInput.value = color.slice(1).toUpperCase(); });
  rgbInputs.forEach((input) => input.addEventListener('input', () => {
    input.value = String(Math.round(Math.max(0, Math.min(255, Number(input.value) || 0))));
    setColor(rgbToHex(rgbInputs.map((entry) => entry.value)), 'rgb');
  }));

  $('new-board').addEventListener('click', openBoardModal);
  $('mobile-new-board').addEventListener('click', openBoardModal);
  $('close-modal').addEventListener('click', closeBoardModal);
  $('board-modal').addEventListener('click', (event) => { if (event.target === $('board-modal')) closeBoardModal(); });
  $('board-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('board-name').value.trim();
    socket.emit('board:create', { name }, (response) => {
      if (!response?.ok) {
        $('modal-error').textContent = response?.message || '캔버스를 만들지 못했어요.';
        return;
      }
      closeBoardModal();
      joinBoard(response.board.id);
      showToast('새 캔버스를 만들었어요. 친구를 초대해 보세요!');
    });
  });

  $('share-button').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      showToast('초대 링크를 복사했어요!');
    } catch {
      window.prompt('이 링크를 친구에게 보내세요:', window.location.href);
    }
  });
  $('clear-button').addEventListener('click', () => {
    if (!activeBoardId) return;
    commitAction({ kind: 'clear' });
  });
  $('undo-button').addEventListener('click', undo);
  $('redo-button').addEventListener('click', redo);
  $('zoom-out').addEventListener('click', () => updateZoom(zoom - 25));
  $('zoom-in').addEventListener('click', () => updateZoom(zoom + 25));
  $('zoom-fit').addEventListener('click', () => {
    updateZoom(100, false);
    canvasStage.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
  });
  $('expand-canvas').addEventListener('click', toggleExpandedCanvas);
  document.addEventListener('fullscreenchange', updateExpandButton);
  $('add-layer-button').addEventListener('click', () => {
    if (!activeBoardId) return;
    socket.emit('layer:create', { boardId: activeBoardId }, (response) => {
      if (!response?.ok) return showToast(response?.message || '레이어를 만들지 못했어요.');
      activeLayerId = response.layer.id;
      renderLayers();
      showToast('새 레이어를 추가했어요.');
    });
  });

  $('shortcuts-open').addEventListener('click', openShortcuts);
  $('close-shortcuts').addEventListener('click', closeShortcuts);
  $('shortcuts-modal').addEventListener('click', (event) => { if (event.target === $('shortcuts-modal')) closeShortcuts(); });

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
    if (event.key === 'Escape') {
      if (!$('board-modal').hidden) closeBoardModal();
      if (!$('shortcuts-modal').hidden) closeShortcuts();
      if (canvasViewer.classList.contains('expanded')) {
        canvasViewer.classList.remove('expanded');
        updateExpandButton();
      }
      return;
    }
    if (typing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault(); redo(); return;
    }
    const key = event.key.toLowerCase();
    const shortcuts = { b: 'brush', e: 'eraser', f: 'fill', i: 'eyedropper' };
    if (shortcuts[key]) setTool(shortcuts[key]);
    if (event.key === '1') { setBrushType('normal'); setTool('brush'); }
    if (event.key === '2') { setBrushType('pencil'); setTool('brush'); }
    if (event.key === '3') { setBrushType('paintbrush'); setTool('brush'); }
    if (event.key === '[') sizeSlider.value = String(Math.max(Number(sizeSlider.min), Number(sizeSlider.value) - 2));
    if (event.key === ']') sizeSlider.value = String(Math.min(Number(sizeSlider.max), Number(sizeSlider.value) + 2));
    if (event.key === '[' || event.key === ']') updateSize();
    if (event.key === '+' || event.key === '=') updateZoom(zoom + 25);
    if (event.key === '-') updateZoom(zoom - 25);
    if (event.key === '?') openShortcuts();
  });

  updateSize();
  updateBrushOpacity();
  setColor(color);
  setTool(tool);
  setBrushType(brushType);
  updateHistoryControls();
})();
