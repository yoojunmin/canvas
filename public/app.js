(() => {
  const WIDTH = 1200;
  const HEIGHT = 760;
  const canvas = document.getElementById('drawing-canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const socket = io();
  const $ = (id) => document.getElementById(id);
  const boardList = $('board-list');
  const mobileBoardList = $('mobile-board-list');
  const boardName = $('current-board-name');
  const peopleCount = $('people-count');
  const hint = $('canvas-hint');
  const colorPicker = $('color-picker');
  const hexInput = $('hex-input');
  const rgbInputs = [$('red-input'), $('green-input'), $('blue-input')];
  const sizeSlider = $('brush-size');
  let activeBoardId = null;
  let joiningBoardId = null;
  let boards = [];
  let tool = 'brush';
  let color = '#ff6b4a';
  let hasDrawing = false;
  let isDrawing = false;
  let activeStroke = null;
  let toastTimer;

  ctx.fillStyle = '#fbfaf6';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  function setHint() {
    hint.classList.toggle('hidden', hasDrawing);
  }

  function pointFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  }

  function drawDot(point, stroke) {
    const x = point.x * WIDTH;
    const y = point.y * HEIGHT;
    ctx.save();
    ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
    ctx.fillStyle = stroke.color;
    ctx.beginPath();
    ctx.arc(x, y, stroke.width / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawSegment(from, to, stroke) {
    ctx.save();
    ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x * WIDTH, from.y * HEIGHT);
    ctx.lineTo(to.x * WIDTH, to.y * HEIGHT);
    ctx.stroke();
    ctx.restore();
  }

  function replayStroke(stroke) {
    if (!stroke.points?.length) return;
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

  function paintBucket(point, fillColor) {
    const px = Math.max(0, Math.min(WIDTH - 1, Math.floor(point.x * WIDTH)));
    const py = Math.max(0, Math.min(HEIGHT - 1, Math.floor(point.y * HEIGHT)));
    const image = ctx.getImageData(0, 0, WIDTH, HEIGHT);
    const data = image.data;
    const startIndex = (py * WIDTH + px) * 4;
    const target = [data[startIndex], data[startIndex + 1], data[startIndex + 2], data[startIndex + 3]];
    const replacement = [...hexToRgb(fillColor), 255];
    if (target.every((value, index) => value === replacement[index])) return;
    const tolerance = 18;
    const matches = (index) => Math.abs(data[index] - target[0]) <= tolerance
      && Math.abs(data[index + 1] - target[1]) <= tolerance
      && Math.abs(data[index + 2] - target[2]) <= tolerance
      && Math.abs(data[index + 3] - target[3]) <= tolerance;
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
    ctx.putImageData(image, 0, 0);
  }

  function applyAction(action, updateHint = true) {
    if (action.kind === 'stroke') {
      replayStroke(action);
      hasDrawing = true;
    } else if (action.kind === 'fill') {
      paintBucket(action.point, action.color);
      hasDrawing = true;
    }
    else if (action.kind === 'clear') {
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      ctx.fillStyle = '#fbfaf6';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      hasDrawing = false;
    }
    if (updateHint) setHint();
  }

  function updateSize() {
    $('size-value').textContent = sizeSlider.value;
    const pct = ((Number(sizeSlider.value) - Number(sizeSlider.min)) / (Number(sizeSlider.max) - Number(sizeSlider.min))) * 100;
    sizeSlider.style.setProperty('--range-progress', `${pct}%`);
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
  }

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  function setTool(nextTool) {
    tool = nextTool;
    document.querySelectorAll('.tool-button').forEach((button) => {
      button.classList.toggle('selected', button.dataset.tool === nextTool);
    });
    canvas.style.cursor = nextTool === 'eyedropper' ? 'copy' : nextTool === 'fill' ? 'cell' : nextTool === 'eraser' ? 'cell' : 'crosshair';
  }

  function beginStroke(event) {
    if (!activeBoardId || event.button > 0) return;
    event.preventDefault();
    const point = pointFromEvent(event);
    if (tool === 'eyedropper') {
      const x = Math.min(WIDTH - 1, Math.floor(point.x * WIDTH));
      const y = Math.min(HEIGHT - 1, Math.floor(point.y * HEIGHT));
      const pixel = ctx.getImageData(x, y, 1, 1).data;
      setColor(rgbToHex([pixel[0], pixel[1], pixel[2]]));
      setTool('brush');
      return;
    }
    if (tool === 'fill') {
      const action = { kind: 'fill', point, color };
      applyAction(action);
      socket.emit('board:action', { boardId: activeBoardId, action });
      return;
    }
    isDrawing = true;
    canvas.setPointerCapture?.(event.pointerId);
    const id = `${socket.id || 'me'}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const stroke = {
      kind: 'stroke', id, color, width: Number(sizeSlider.value), erase: tool === 'eraser', points: [point],
    };
    activeStroke = stroke;
    drawDot(point, stroke);
    hasDrawing = true;
    socket.emit('stroke:start', { boardId: activeBoardId, id, color, width: stroke.width, erase: stroke.erase, point });
    setHint();
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
    activeStroke = null;
  }

  function openModal() {
    $('modal-error').textContent = '';
    $('board-name').value = '';
    $('board-modal').hidden = false;
    $('board-name').focus();
  }

  function closeModal() { $('board-modal').hidden = true; }

  const remoteStrokes = new Map();

  socket.on('connect', () => {
    $('sidebar-connection').textContent = '실시간 연결됨';
    $('connection-state').textContent = '연결됨';
    if (activeBoardId) {
      joiningBoardId = activeBoardId;
      socket.emit('board:join', { id: activeBoardId });
    }
    else socket.emit('boards:list');
  });
  socket.on('disconnect', () => {
    joiningBoardId = null;
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

  socket.on('board:state', ({ boardId, history }) => {
    setActiveBoard(boardId);
    remoteStrokes.clear();
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = '#fbfaf6';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    hasDrawing = false;
    history.forEach((action) => applyAction(action, false));
    setHint();
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
    remoteStrokes.set(stroke.id, { stroke, points: [stroke.point] });
    hasDrawing = true;
    setHint();
  });
  socket.on('stroke:move', ({ id, points }) => {
    const live = remoteStrokes.get(id);
    if (!live) return;
    points.forEach((point) => {
      drawSegment(live.points[live.points.length - 1], point, live.stroke);
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
  sizeSlider.addEventListener('input', updateSize);
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

  $('new-board').addEventListener('click', openModal);
  $('mobile-new-board').addEventListener('click', openModal);
  $('close-modal').addEventListener('click', closeModal);
  $('board-modal').addEventListener('click', (event) => { if (event.target === $('board-modal')) closeModal(); });
  $('board-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('board-name').value.trim();
    socket.emit('board:create', { name }, (response) => {
      if (!response?.ok) {
        $('modal-error').textContent = response?.message || '캔버스를 만들지 못했어요.';
        return;
      }
      closeModal();
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
    const action = { kind: 'clear' };
    applyAction(action);
    socket.emit('board:action', { boardId: activeBoardId, action });
  });

  document.addEventListener('keydown', (event) => {
    if (event.target.matches('input')) return;
    const shortcuts = { b: 'brush', e: 'eraser', f: 'fill', i: 'eyedropper' };
    if (shortcuts[event.key.toLowerCase()]) setTool(shortcuts[event.key.toLowerCase()]);
    if (event.key === 'Escape' && !$('board-modal').hidden) closeModal();
  });

  updateSize();
  setColor(color);
})();
