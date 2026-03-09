import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config';

let io: Server;

interface TokenPayload {
  userId: string;
  role: string;
}

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: config.corsOrigin,
      methods: ['GET', 'POST'],
    },
  });

  // JWT authentication middleware
  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth.token as string | undefined;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      const payload = jwt.verify(token, config.jwtSecret) as TokenPayload;
      (socket as any).userId = payload.userId;
      (socket as any).role = payload.role;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId = (socket as any).userId as string;
    const role = (socket as any).role as string;

    // Join user-specific room
    socket.join(`user:${userId}`);

    // Admins also join admin room
    if (role === 'ADMIN') {
      socket.join('admin');
    }

    // Campaign subscription
    socket.on('subscribe:campaign', ({ campaignId }: { campaignId: string }) => {
      socket.join(`campaign:${campaignId}`);
    });

    socket.on('unsubscribe:campaign', ({ campaignId }: { campaignId: string }) => {
      socket.leave(`campaign:${campaignId}`);
    });
  });

  return io;
}

export function getIO(): Server {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

/** Emit to a specific user */
export function emitToUser(userId: string, event: string, data: unknown): void {
  if (io) io.to(`user:${userId}`).emit(event, data);
}

/** Emit to all admins */
export function emitToAdmins(event: string, data: unknown): void {
  if (io) io.to('admin').emit(event, data);
}

/** Emit to campaign subscribers */
export function emitToCampaign(campaignId: string, event: string, data: unknown): void {
  if (io) io.to(`campaign:${campaignId}`).emit(event, data);
}
