import express from 'express';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';
import apiRoutes from './routes/api';
import pageRoutes from './routes/pages';
import { registerSocketHandlers } from './socket/handlers';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

app.use('/api', apiRoutes);
app.use(pageRoutes);

registerSocketHandlers(io);

export { server, io };
