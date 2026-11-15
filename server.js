const path = require('node:path');
const express = require('express');
const http = require('node:http');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const HISTORY_LIMIT = 1200;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const canvases = new Map();
const makeId = () => `canvas-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const cleanName = (value) => String(value || '').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 28);

function ensureLobby() {
  if (!canvases.size) {
    canvases.set('lobby', { id: 'lobby', name: '라운지', history: [] });
  }
}

function summaries() {
  return [...canvases.values()].map((board) => ({
    id: board.id,
    name: board.name,
    people: io.sockets.adapter.rooms.get(board.id)?.size || 0,
  }));
}

function notifyBoards() {
  io.emit('boards:update', summaries());
}

function validPoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
}

function validColor(color) {
  return typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color);
}

function validStroke(stroke) {
  return stroke && stroke.kind === 'stroke' && validColor(stroke.color)
    && Number.isFinite(stroke.width) && stroke.width >= 1 && stroke.width <= 160
    && typeof stroke.erase === 'boolean'
    && Array.isArray(stroke.points) && stroke.points.length > 0 && stroke.points.length <= 15000
    && stroke.points.every(validPoint);
}

function currentBoard(socket, boardId) {
  const board = canvases.get(boardId);
  return board && socket.data.boardId === boardId ? board : null;
}

io.on('connection', (socket) => {
  ensureLobby();
  socket.emit('boards:update', summaries());

  socket.on('boards:list', () => socket.emit('boards:update', summaries()));

  socket.on('board:create', (payload = {}, reply = () => {}) => {
    const name = cleanName(payload.name);
    if (!name) return reply({ ok: false, message: '캔버스 이름을 입력해 주세요.' });
    if (canvases.size >= 50) return reply({ ok: false, message: '캔버스는 최대 50개까지 만들 수 있어요.' });
    const board = { id: makeId(), name, history: [] };
    canvases.set(board.id, board);
    notifyBoards();
    reply({ ok: true, board: { id: board.id, name: board.name } });
  });

  socket.on('board:join', (payload = {}) => {
    const board = canvases.get(payload.id);
    if (!board) {
      socket.emit('board:error', { message: '캔버스를 찾을 수 없어요.' });
      return;
    }
    const previousId = socket.data.boardId;
    if (previousId) {
      socket.leave(previousId);
      io.to(previousId).emit('board:presence', { boardId: previousId, count: io.sockets.adapter.rooms.get(previousId)?.size || 0 });
    }
    socket.join(board.id);
    socket.data.boardId = board.id;
    socket.emit('board:state', { boardId: board.id, history: board.history });
    io.to(board.id).emit('board:presence', { boardId: board.id, count: io.sockets.adapter.rooms.get(board.id)?.size || 0 });
    notifyBoards();
  });

  socket.on('stroke:start', (payload = {}) => {
    const board = currentBoard(socket, payload.boardId);
    if (!board || !validColor(payload.color) || !validPoint(payload.point)) return;
    const stroke = {
      id: String(payload.id || '').slice(0, 80),
      color: payload.color,
      width: Math.max(1, Math.min(160, Number(payload.width) || 1)),
      erase: payload.erase === true,
      point: payload.point,
    };
    socket.to(board.id).emit('stroke:start', stroke);
  });

  socket.on('stroke:move', (payload = {}) => {
    const board = currentBoard(socket, payload.boardId);
    if (!board || typeof payload.id !== 'string' || !Array.isArray(payload.points)) return;
    const points = payload.points.slice(0, 64).filter(validPoint);
    if (points.length) socket.to(board.id).emit('stroke:move', { id: payload.id.slice(0, 80), points });
  });

  socket.on('stroke:end', (payload = {}) => {
    const board = currentBoard(socket, payload.boardId);
    if (!board || !validStroke(payload.stroke)) return;
    const stroke = { ...payload.stroke, id: String(payload.stroke.id || '').slice(0, 80) };
    board.history.push(stroke);
    if (board.history.length > HISTORY_LIMIT) board.history.splice(0, board.history.length - HISTORY_LIMIT);
    socket.to(board.id).emit('board:action', stroke);
  });

  socket.on('board:action', (payload = {}) => {
    const board = currentBoard(socket, payload.boardId);
    const action = payload.action;
    if (!board || !action || !['fill', 'clear'].includes(action.kind)) return;
    if (action.kind === 'fill' && (!validColor(action.color) || !validPoint(action.point))) return;
    const safeAction = action.kind === 'fill'
      ? { kind: 'fill', point: action.point, color: action.color }
      : { kind: 'clear' };
    board.history.push(safeAction);
    if (board.history.length > HISTORY_LIMIT) board.history.splice(0, board.history.length - HISTORY_LIMIT);
    socket.to(board.id).emit('board:action', safeAction);
  });

  socket.on('disconnect', () => {
    const boardId = socket.data.boardId;
    if (boardId) {
      io.to(boardId).emit('board:presence', { boardId, count: io.sockets.adapter.rooms.get(boardId)?.size || 0 });
      notifyBoards();
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MultiCanvas listening on ${PORT}`);
});
