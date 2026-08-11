import express from 'express';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';
import apiRoutes from './routes/api';
import pageRoutes from './routes/pages';
import { registerSocketHandlers } from './socket/handlers';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  /** Default 20s is tight when the browser is busy handling many price ticks + rules UI. */
  pingTimeout: 120000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e7,
});

app.use(express.json({ limit: '50mb' }));
app.use('/js', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(process.cwd(), 'public')));

app.use('/api', apiRoutes);
app.use(pageRoutes);

registerSocketHandlers(io);

export { server, io };
